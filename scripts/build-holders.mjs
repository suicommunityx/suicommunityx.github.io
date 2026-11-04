#!/usr/bin/env node
/**
 * Build public/holders/<TICK>.json from the live Movescription object set.
 *
 * GraphQL pages are pinned to a checkpoint (~1h consistent range) and ordered
 * by object id. A single cursor cannot walk the whole set before the pin
 * expires, and restarting from the beginning only repeats the same prefix.
 * This scan partitions the object-id space, finishes each slice inside one
 * pin, and publishes a tick only after every slice is done. An incomplete
 * result never replaces a live snapshot that is already complete.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public', 'holders');
const SCAN_DIR = process.env.HOLDERS_SCAN_DIR || '/tmp/holders-scan';
const GQL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
const RPC = process.env.SUI_RPC_URL || 'https://mainnet.suiet.app';
const TYPE =
  '0x830fe26674dc638af7c3d84030e2575f44a2bdc1baa1f4757cfe010a4b106b6a::movescription::Movescription';
const PAGE = Math.min(50, Number(process.env.HOLDERS_PAGE_SIZE || 50));
const PARTS = Number(process.env.HOLDERS_PARTS || 256);
const CONCURRENCY = Math.max(1, Number(process.env.HOLDERS_CONCURRENCY || 8));
const SLICE_MAX_AGE_MS = Number(process.env.HOLDERS_SLICE_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const FORCE = process.env.HOLDERS_FORCE === '1';
const PUBLISH = process.env.HOLDERS_PUBLISH !== '0';
const ONLY = (process.env.HOLDERS_TICKS || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const PART_FILTER = (process.env.HOLDERS_PART_FILTER || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.startsWith('0x') ? Number.parseInt(s, 16) : Number.parseInt(s, 10)));

const TARGET_ADDR = '0x87d55d66c168e8acec2ffab46bf356d99319b3c9d6dda8fee670e8e3ee62cbeb';
const TARGET_OBJ = '0xfd87059fe73643c974bfe490adf426e169fd9d1d65d01a05979843125a76dac5';
/** Opt-in. A live whale balance changes, so scheduled refreshes must not depend on it. */
const VERIFY_IKUN = process.env.HOLDERS_VERIFY_IKUN === '1';

function log(obj) {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function queryObjects() {
  return `query($cursor: String) {
  objects(first: ${PAGE}, after: $cursor, filter: { type: "${TYPE}" }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      address
      owner {
        __typename
        ... on AddressOwner { address { address } }
        ... on ObjectOwner { address { address } }
        ... on Shared { initialSharedVersion }
      }
      asMoveObject { contents { json } }
    }
  }
}`;
}

function encodeUleb(n) {
  const bytes = [];
  let x = n;
  while (x > 127) {
    bytes.push((x & 0x7f) | 0x80);
    x >>= 7;
  }
  bytes.push(x);
  return Buffer.from(bytes);
}

function encodeCursor(cp, token) {
  const cpBuf = Buffer.alloc(8);
  cpBuf.writeBigUInt64LE(BigInt(cp));
  return Buffer.concat([cpBuf, encodeUleb(token.length), token]).toString('base64');
}

function decodeCursor(s) {
  const raw = Buffer.from(s, 'base64');
  const cp = Number(raw.readBigUInt64LE(0));
  let i = 8;
  let length = 0;
  let shift = 0;
  while (i < raw.length) {
    const b = raw[i++];
    length |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const token = raw.subarray(i, i + length);
  if (token.length !== length) throw new Error('truncated object cursor');
  return { cp, token: Buffer.from(token) };
}

function bigToBytes32(n) {
  const hex = n.toString(16).padStart(64, '0');
  if (hex.length !== 64) throw new Error(`object id out of range: ${hex.length}`);
  return Buffer.from(hex, 'hex');
}

function normAddr(addr) {
  const hex = String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `0x${hex}`;
}

function sliceShift(parts) {
  if (!Number.isInteger(parts) || parts < 2 || (parts & (parts - 1)) !== 0) {
    throw new Error(`HOLDERS_PARTS must be a power of two >= 2, got ${parts}`);
  }
  return 256 - Math.round(Math.log2(parts));
}

function sliceBounds(part, parts) {
  const shift = BigInt(sliceShift(parts));
  const start = BigInt(part) << shift;
  const end = part + 1 === parts ? 1n << 256n : BigInt(part + 1) << shift;
  return { start, end };
}

function slicePath(part) {
  const width = Math.ceil(sliceShift(PARTS) === 248 ? 2 : Math.ceil(Math.log2(PARTS) / 4));
  return join(SCAN_DIR, `slice-${part.toString(16).padStart(width, '0')}.json`);
}

async function gql(query, variables, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(GQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'suicommunity-holders/1.0' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(20000, 400 * 2 ** i));
        continue;
      }
      const json = await res.json();
      if (json.errors?.length) {
        const msg = json.errors.map((e) => e.message).join('; ');
        const err = new Error(msg);
        err.graphql = true;
        if (/consistent range|available range/i.test(msg)) throw err;
        if (/in the future/i.test(msg) && i < tries - 1) {
          await sleep(250 * (i + 1));
          last = err;
          continue;
        }
        throw err;
      }
      return json.data;
    } catch (e) {
      last = e;
      if (e?.graphql && /consistent range|available range|in the future/i.test(String(e.message))) throw e;
      await sleep(Math.min(20000, 400 * 2 ** i));
    }
  }
  throw last;
}

async function rpc(method, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'suicommunity-holders/1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(20000, 400 * 2 ** i));
        continue;
      }
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } catch (e) {
      last = e;
      await sleep(Math.min(15000, 400 * 2 ** i));
    }
  }
  throw last;
}

async function loadTemplate() {
  const data = await gql(queryObjects(), { cursor: null });
  const cursor = data?.objects?.pageInfo?.endCursor;
  if (!cursor) throw new Error('template page returned no cursor');
  const { cp, token } = decodeCursor(cursor);
  if (token.length < 32) throw new Error('template token missing object id');
  return { cp, prefix: token.subarray(0, token.length - 32) };
}

function cursorAfter(template, start) {
  if (start === 0n) return null;
  const token = Buffer.concat([template.prefix, bigToBytes32(start - 1n)]);
  return encodeCursor(template.cp, token);
}

function emptySliceState() {
  return {
    ticks: new Map(),
    objects: 0,
    watched: [],
    minId: null,
    maxId: null,
  };
}

function tickState(map, tick) {
  let row = map.get(tick);
  if (!row) {
    row = { holders: new Map(), marketAmount: 0n, marketObjects: 0, objects: 0 };
    map.set(tick, row);
  }
  return row;
}

function safeTick(raw) {
  const tick = String(raw || '').trim().toUpperCase();
  if (!tick || tick.length > 180) return null;
  if (tick.includes('/') || tick.includes('\\') || tick.includes('\0') || tick === '.' || tick === '..') return null;
  return tick;
}

function ingest(state, node) {
  const json = node?.asMoveObject?.contents?.json;
  const tick = safeTick(json?.tick);
  if (!tick) return;
  if (ONLY.length && !ONLY.includes(tick)) return;
  const oid = normAddr(node.address);
  const amount = BigInt(json.amount ?? 0);
  state.objects++;
  if (state.minId == null || oid < state.minId) state.minId = oid;
  if (state.maxId == null || oid > state.maxId) state.maxId = oid;
  if (oid === TARGET_OBJ) {
    const kind = node.owner?.__typename || null;
    const owner = node.owner?.address?.address ? normAddr(node.owner.address.address) : null;
    state.watched.push({ id: oid, tick, amount: amount.toString(), owner, ownerKind: kind });
  }
  const bucket = tickState(state.ticks, tick);
  bucket.objects++;
  if (node.owner?.__typename === 'AddressOwner' && node.owner.address?.address) {
    const addr = normAddr(node.owner.address.address);
    const cur = bucket.holders.get(addr) || { amount: 0n, objects: 0 };
    cur.amount += amount;
    cur.objects += 1;
    bucket.holders.set(addr, cur);
  } else {
    bucket.marketAmount += amount;
    bucket.marketObjects += 1;
  }
}

function serializeSlice(part, template, state, pages, startedAt) {
  const ticks = {};
  for (const [tick, bucket] of state.ticks) {
    const holders = {};
    for (const [addr, v] of bucket.holders) {
      holders[addr] = { amount: v.amount.toString(), objects: v.objects };
    }
    ticks[tick] = {
      objects: bucket.objects,
      marketAmount: bucket.marketAmount.toString(),
      marketObjects: bucket.marketObjects,
      holders,
    };
  }
  return {
    done: true,
    part,
    checkpoint: template.cp,
    pages,
    objects: state.objects,
    minId: state.minId,
    maxId: state.maxId,
    watched: state.watched,
    startedAt,
    finishedAt: new Date().toISOString(),
    ticks,
  };
}

function readSlice(part) {
  const path = slicePath(part);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sliceFresh(slice) {
  if (!slice?.done || FORCE) return false;
  const at = Date.parse(slice.finishedAt || '');
  return Number.isFinite(at) && Date.now() - at <= SLICE_MAX_AGE_MS;
}

async function scanSliceOnce(part) {
  const { start, end } = sliceBounds(part, PARTS);
  const template = await loadTemplate();
  let cursor = cursorAfter(template, start);
  const state = emptySliceState();
  const startedAt = new Date().toISOString();
  const q = queryObjects();
  let pages = 0;
  for (;;) {
    const data = await gql(q, { cursor });
    const conn = data?.objects;
    if (!conn) throw new Error(`slice ${part} missing objects connection`);
    const nodes = conn.nodes || [];
    if (!nodes.length) {
      if (conn.pageInfo?.hasNextPage) throw new Error(`slice ${part} empty page with hasNextPage`);
      break;
    }
    let prev = null;
    let crossed = false;
    for (const node of nodes) {
      const id = BigInt(normAddr(node.address));
      if (prev != null && id < prev) throw new Error(`slice ${part} page not sorted by object id`);
      prev = id;
      if (id < start) continue;
      if (id >= end) {
        crossed = true;
        break;
      }
      ingest(state, node);
    }
    pages++;
    if (pages % 200 === 0) {
      log({
        event: 'slice-progress',
        part,
        pages,
        objects: state.objects,
        checkpoint: template.cp,
        last: nodes[nodes.length - 1]?.address,
      });
    }
    if (crossed || !conn.pageInfo?.hasNextPage) break;
    if (!conn.pageInfo.endCursor) throw new Error(`slice ${part} missing end cursor`);
    cursor = conn.pageInfo.endCursor;
  }
  const payload = serializeSlice(part, template, state, pages, startedAt);
  const path = slicePath(part);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, path);
  log({
    event: 'slice-done',
    part,
    pages,
    objects: state.objects,
    ticks: state.ticks.size,
    checkpoint: template.cp,
    minId: state.minId,
    maxId: state.maxId,
  });
}

async function scanSliceWithRetry(part) {
  if (sliceFresh(readSlice(part))) {
    const prev = readSlice(part);
    log({ event: 'slice-skip', part, objects: prev.objects, finishedAt: prev.finishedAt });
    return;
  }
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await scanSliceOnce(part);
      return;
    } catch (e) {
      last = e;
      log({
        event: 'slice-retry',
        part,
        attempt,
        message: String(e?.message || e),
      });
      await sleep(Math.min(10000, 500 * 2 ** attempt));
    }
  }
  throw last;
}

function loadSupply() {
  const snapPath = join(ROOT, 'public', 'ticks-snapshot.json');
  const map = new Map();
  if (!existsSync(snapPath)) return map;
  const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
  for (const t of snap.ticks || []) {
    const tick = safeTick(t.tick);
    if (!tick) continue;
    map.set(tick, {
      totalSupply: BigInt(t.totalSupply || 0),
      currentSupply: BigInt(t.currentSupply || 0),
      recordId: t.recordId || null,
      refreshed: false,
    });
  }
  return map;
}

function parseRecordSupply(obj) {
  const data = obj?.data;
  const f = data?.content?.fields;
  if (!f) return null;
  const typ = data?.content?.type || data?.type || '';
  const totalSupply = BigInt(f.total_supply || 0);
  if (String(typ).includes('TickRecordV2')) {
    const stat = f.stat?.fields || f.stat || {};
    return { totalSupply, currentSupply: BigInt(stat.current_supply || 0) };
  }
  return { totalSupply, currentSupply: BigInt(f.current_supply || 0) };
}

async function refreshSupply(supply, ticks) {
  const jobs = [];
  for (const tick of ticks) {
    const row = supply.get(tick);
    if (row?.recordId) jobs.push({ tick, recordId: row.recordId });
  }
  for (let i = 0; i < jobs.length; i += 20) {
    const batch = jobs.slice(i, i + 20);
    try {
      const objs = await rpc('sui_multiGetObjects', [
        batch.map((j) => j.recordId),
        { showContent: true, showType: true },
      ]);
      objs.forEach((obj, idx) => {
        const parsed = parseRecordSupply(obj);
        if (!parsed) return;
        const row = supply.get(batch[idx].tick);
        row.totalSupply = parsed.totalSupply;
        row.currentSupply = parsed.currentSupply;
        row.refreshed = true;
      });
    } catch (e) {
      log({ event: 'supply-refresh-err', message: String(e?.message || e), at: i });
    }
  }
}

function mergeSlices(parts) {
  const ticks = new Map();
  const watched = [];
  let objects = 0;
  let pages = 0;
  let minCp = null;
  let maxCp = null;
  for (const part of parts) {
    const slice = readSlice(part);
    if (!slice?.done) throw new Error(`slice ${part} is not complete`);
    objects += Number(slice.objects || 0);
    pages += Number(slice.pages || 0);
    if (slice.checkpoint != null) {
      minCp = minCp == null ? slice.checkpoint : Math.min(minCp, slice.checkpoint);
      maxCp = maxCp == null ? slice.checkpoint : Math.max(maxCp, slice.checkpoint);
    }
    for (const hit of slice.watched || []) watched.push(hit);
    for (const [rawTick, src] of Object.entries(slice.ticks || {})) {
      const tick = safeTick(rawTick);
      if (!tick) continue;
      if (ONLY.length && !ONLY.includes(tick)) continue;
      const bucket = tickState(ticks, tick);
      bucket.objects += Number(src.objects || 0);
      bucket.marketAmount += BigInt(src.marketAmount || 0);
      bucket.marketObjects += Number(src.marketObjects || 0);
      for (const [addr, v] of Object.entries(src.holders || {})) {
        const key = normAddr(addr);
        const cur = bucket.holders.get(key) || { amount: 0n, objects: 0 };
        cur.amount += BigInt(v.amount || 0);
        cur.objects += Number(v.objects || 0);
        bucket.holders.set(key, cur);
      }
    }
  }
  return { ticks, watched, objects, pages, minCp, maxCp };
}

function buildPayload(tick, bucket, supply, updatedAt, scanMeta) {
  const info = supply.get(tick);
  const currentSupply = info?.currentSupply || 0n;
  const totalSupply = info?.totalSupply || 0n;
  const rows = [...bucket.holders.entries()]
    .map(([address, v]) => ({
      address,
      amount: v.amount.toString(),
      objects: v.objects,
      pct: currentSupply > 0n ? Number((v.amount * 10000n) / currentSupply) / 100 : 0,
    }))
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount);
      if (d !== 0n) return d > 0n ? 1 : -1;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });
  const holderAmount = bucket.holders.size
    ? [...bucket.holders.values()].reduce((s, v) => s + v.amount, 0n)
    : 0n;
  const accounted = holderAmount + bucket.marketAmount;
  const payload = {
    tick,
    updatedAt,
    timezoneNote: 'Asia/Shanghai (UTC+8)',
    complete: true,
    coverage: {
      method: 'object-id-partition',
      parts: PARTS,
      pages: scanMeta.pages,
      objectsScanned: scanMeta.objects,
      checkpoints: { min: scanMeta.minCp, max: scanMeta.maxCp },
      supply: {
        holderAmount: holderAmount.toString(),
        marketAmount: bucket.marketAmount.toString(),
        accounted: accounted.toString(),
        currentSupply: currentSupply.toString(),
        ratio: currentSupply > 0n ? Number((accounted * 10000n) / currentSupply) / 10000 : null,
        supplyRefreshed: !!info?.refreshed,
      },
    },
    totalSupply: totalSupply.toString(),
    currentSupply: currentSupply.toString(),
    scannedObjects: bucket.objects,
    holderCount: rows.length,
    marketEscrow: {
      note: 'Movescription objects owned by marketplace/shared objects (listed for sale), excluded from holder ranks',
      amount: bucket.marketAmount.toString(),
      objects: bucket.marketObjects,
    },
    holders: rows,
  };
  return payload;
}

function readLive(tick) {
  const path = join(OUT, `${tick}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeLive(payload) {
  const dest = join(OUT, `${payload.tick}.json`);
  if (payload.complete !== true) {
    const prev = readLive(payload.tick);
    if (prev?.complete === true) {
      log({ event: 'refuse-incomplete-overwrite', tick: payload.tick });
      return false;
    }
  }
  const prev = readLive(payload.tick);
  if (
    prev?.complete === true &&
    Number(prev.holderCount || 0) > 0 &&
    payload.holderCount < Number(prev.holderCount) * 0.5
  ) {
    throw new Error(
      `refuse to shrink complete snapshot ${payload.tick}: ${prev.holderCount} -> ${payload.holderCount}`,
    );
  }
  const tmp = join(SCAN_DIR, `publish-${payload.tick}.json`);
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, dest);
  return true;
}

async function ownedIkunSum(owner) {
  let cursor = null;
  let sum = 0n;
  let objects = 0;
  do {
    const page = await rpc('suix_getOwnedObjects', [
      owner,
      { filter: { StructType: TYPE }, options: { showContent: true } },
      cursor,
      50,
    ]);
    for (const row of page.data || []) {
      const f = row?.data?.content?.fields;
      if (!f || safeTick(f.tick) !== 'IKUN') continue;
      sum += BigInt(f.amount || 0);
      objects++;
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return { sum, objects };
}

async function verifyIkun(payload, watched) {
  const hit = watched.find((w) => w.id === TARGET_OBJ && w.tick === 'IKUN');
  if (!hit) throw new Error(`IKUN object ${TARGET_OBJ} was not in the scan`);
  const live = await rpc('sui_getObject', [TARGET_OBJ, { showContent: true, showOwner: true }]);
  const fields = live?.data?.content?.fields;
  const liveOwner = live?.data?.owner?.AddressOwner ? normAddr(live.data.owner.AddressOwner) : null;
  const liveAmount = BigInt(fields?.amount || 0);
  if (!liveOwner || safeTick(fields?.tick) !== 'IKUN') {
    throw new Error('live IKUN target object is missing or not an address-owned IKUN movescription');
  }
  if (hit.owner !== liveOwner || BigInt(hit.amount) !== liveAmount) {
    throw new Error(
      `scan/live mismatch for ${TARGET_OBJ}: scan ${hit.owner} ${hit.amount} vs live ${liveOwner} ${liveAmount}`,
    );
  }
  const row = payload.holders.find((h) => h.address === liveOwner);
  if (!row) throw new Error(`holder ${liveOwner} missing from IKUN snapshot`);
  const owned = await ownedIkunSum(liveOwner);
  if (BigInt(row.amount) !== owned.sum) {
    throw new Error(
      `IKUN balance mismatch for ${liveOwner}: snapshot ${row.amount} vs owned-objects ${owned.sum} (${owned.objects} objects)`,
    );
  }
  const rank = payload.holders.findIndex((h) => h.address === liveOwner) + 1;
  return {
    address: liveOwner,
    amount: row.amount,
    objects: row.objects,
    rank,
    objectId: TARGET_OBJ,
    objectAmount: liveAmount.toString(),
    holderCount: payload.holderCount,
    accounted: payload.coverage.supply.accounted,
    currentSupply: payload.currentSupply,
    ratio: payload.coverage.supply.ratio,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCAN_DIR, { recursive: true });
  if (PART_FILTER.some((n) => !Number.isInteger(n) || n < 0 || n >= PARTS)) {
    throw new Error(`HOLDERS_PART_FILTER out of range 0..${PARTS - 1}`);
  }
  const filter = PART_FILTER.length ? new Set(PART_FILTER) : null;
  log({
    event: 'start',
    parts: PARTS,
    concurrency: CONCURRENCY,
    page: PAGE,
    filter: filter ? [...filter] : null,
    only: ONLY.length ? ONLY : null,
    publish: PUBLISH && !filter,
    scanDir: SCAN_DIR,
  });

  let next = 0;
  async function worker() {
    for (;;) {
      const part = next++;
      if (part >= PARTS) return;
      if (filter && !filter.has(part)) continue;
      await scanSliceWithRetry(part);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, PARTS) }, () => worker()));

  if (filter || !PUBLISH) {
    log({ event: 'scan-only', reason: filter ? 'part-filter' : 'publish-disabled' });
    return;
  }

  const counts = [];
  for (let part = 0; part < PARTS; part++) {
    const slice = readSlice(part);
    if (!slice?.done) throw new Error(`missing completed slice ${part}`);
    counts.push(Number(slice.objects || 0));
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  if (median >= 100) {
    for (let part = 0; part < PARTS; part++) {
      if (counts[part] < median * 0.05) {
        log({ event: 'slice-suspect', part, objects: counts[part], median });
        const path = slicePath(part);
        if (existsSync(path)) unlinkSync(path);
        await scanSliceWithRetry(part);
      }
    }
  }

  const scanMeta = mergeSlices([...Array(PARTS).keys()]);
  const tickNames = [...scanMeta.ticks.keys()].sort();
  const supply = loadSupply();
  await refreshSupply(supply, tickNames);
  const updatedAt = new Date().toISOString();
  const summary = {
    updatedAt,
    method: 'object-id-partition',
    parts: PARTS,
    objectsScanned: scanMeta.objects,
    pages: scanMeta.pages,
    checkpoints: { min: scanMeta.minCp, max: scanMeta.maxCp },
    ticks: {},
  };

  let ikunPayload = null;
  for (const tick of tickNames) {
    const payload = buildPayload(tick, scanMeta.ticks.get(tick), supply, updatedAt, scanMeta);
    if (tick === 'IKUN') ikunPayload = payload;
    const info = supply.get(tick);
    const accounted = BigInt(payload.coverage.supply.accounted);
    const current = info?.currentSupply || 0n;
    if (current > 0n) {
      const ratio = Number((accounted * 10000n) / current) / 10000;
      if (ratio < 0.98) {
        log({
          event: 'supply-gap',
          tick,
          ratio,
          accounted: accounted.toString(),
          currentSupply: current.toString(),
          holders: payload.holderCount,
          objects: payload.scannedObjects,
        });
      }
    }
    summary.ticks[tick] = {
      holders: payload.holderCount,
      objects: payload.scannedObjects,
      marketObjects: payload.marketEscrow.objects,
      accounted: payload.coverage.supply.accounted,
      currentSupply: payload.currentSupply,
      ratio: payload.coverage.supply.ratio,
      top3: payload.holders.slice(0, 3).map((r) => ({ address: r.address, amount: r.amount })),
    };
  }

  if (!ikunPayload) throw new Error('IKUN tick missing from full scan');
  let ikunCheck = null;
  if (VERIFY_IKUN) {
    ikunCheck = await verifyIkun(ikunPayload, scanMeta.watched);
    log({ event: 'ikun-verified', ...ikunCheck });
    summary.ikunVerification = ikunCheck;
  } else {
    const row = ikunPayload.holders.find((h) => h.address === TARGET_ADDR);
    const rank = row ? ikunPayload.holders.findIndex((h) => h.address === TARGET_ADDR) + 1 : null;
    summary.ikun = row
      ? { address: TARGET_ADDR, amount: row.amount, objects: row.objects, rank, holderCount: ikunPayload.holderCount }
      : { address: TARGET_ADDR, present: false };
  }

  const countsOut = {};
  const meta = {};
  for (const tick of tickNames) {
    const payload = buildPayload(tick, scanMeta.ticks.get(tick), supply, updatedAt, scanMeta);
    writeLive(payload);
    countsOut[tick] = payload.holderCount;
    meta[tick] = { holderCount: payload.holderCount, updatedAt, complete: true };
    console.log(
      'WROTE',
      tick,
      'holders',
      payload.holderCount,
      'objects',
      payload.scannedObjects,
      'ratio',
      payload.coverage.supply.ratio,
    );
  }
  writeFileSync(
    join(OUT, 'counts.json'),
    JSON.stringify(
      {
        updatedAt,
        source: 'public/holders/*.json top-level holderCount after a full Movescription object-id scan',
        counts: countsOut,
        meta,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('DONE', JSON.stringify({ elapsedNote: 'see slice logs', ikun: ikunCheck, ticks: tickNames.length, objects: scanMeta.objects }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
