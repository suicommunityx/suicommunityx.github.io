#!/usr/bin/env node
/**
 * SuiMint v2 indexer (package 0xcb5bd7a2…).
 *
 * Tick metadata: read shared SUIRC20Tick objects (exact on-chain).
 * Balances: NOT stored on-chain (SUIRC20Tick has no balance table/DFs) —
 *   rebuild from suirc20::{MintEvent, TransferEvent, TransferFromEvent}.
 * Mint: credit sender. Transfer: debit sender / credit `to`.
 * TransferFrom: debit `from` / credit `to`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'suirc20v2');
const STATE = path.join(OUT, 'state');
const GQL = process.env.SUI_GRAPHQL || 'https://graphql.mainnet.sui.io/graphql';
const PKG = '0xcb5bd7a29f458a1b1e0221516fbfaeb182be027033eb8dcb4f33dd540d20bb87';
const GLOBAL_CONFIG = '0xc584d0d14cb3a020f8b1411275abc39d1a3d954a4c922d3efa9d03cba9e86ef9';
const PAGE = Number(process.env.V2_PAGE || 50);
const SLEEP_MS = Number(process.env.V2_SLEEP_MS || 400);
const FLUSH_EVERY = Number(process.env.V2_FLUSH_EVERY || 30);
const MAX_PAGES = Number(process.env.V2_MAX_PAGES || 0);

function ensure() {
  for (const d of [OUT, STATE, path.join(OUT, 'holders'), path.join(OUT, 'balances')]) fs.mkdirSync(d, { recursive: true });
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      if (res.status === 429) { const w = Math.min(60000, 1000 * 2 ** Math.min(attempt, 5)); console.warn('429', w); await sleep(w); continue; }
      const json = await res.json();
      if (json.errors?.length) {
        const msg = json.errors[0].message || 'err';
        if (/rate|429|thrott/i.test(msg)) { await sleep(Math.min(60000, 1000 * 2 ** Math.min(attempt, 5))); continue; }
        throw new Error(msg);
      }
      return json.data;
    } catch (e) {
      if (attempt >= 8) throw e;
      await sleep(Math.min(40000, 800 * 2 ** attempt));
    }
  }
}

function toBeijing(iso) {
  if (!iso) return null;
  const d = new Date(typeof iso === 'number' ? iso : iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Shanghai`;
}

function shardKey(addr) {
  return addr.toLowerCase().replace(/^0x/, '').slice(0, 4);
}
function normAddr(a) {
  if (!a) return null;
  const h = String(a).toLowerCase().replace(/^0x/, '');
  return '0x' + h.padStart(64, '0');
}

function loadState() {
  return {
    cursors: readJson(path.join(STATE, 'cursors.json'), {}),
    ticks: readJson(path.join(STATE, 'ticks.json'), {}),
    balances: readJson(path.join(STATE, 'balances-map.json'), {}),
    holders: readJson(path.join(STATE, 'holder-counts.json'), {}),
    supply: readJson(path.join(STATE, 'supply.json'), {}),
    stats: readJson(path.join(STATE, 'stats.json'), {
      deployEvents: 0, mintEvents: 0, transferEvents: 0, transferFromEvents: 0,
      mintAccepted: 0, transferAccepted: 0, transferIgnored: 0,
      lastTs: null, startedAt: new Date().toISOString(),
    }),
  };
}

function balGet(balances, tick, addr) {
  return BigInt(balances[tick]?.[addr] || '0');
}
function balSet(balances, holders, tick, addr, value) {
  if (!balances[tick]) balances[tick] = {};
  const before = balGet(balances, tick, addr);
  if (value === 0n) delete balances[tick][addr];
  else balances[tick][addr] = value.toString();
  if (!holders[tick]) holders[tick] = 0;
  if (before === 0n && value > 0n) holders[tick]++;
  if (before > 0n && value === 0n) holders[tick] = Math.max(0, holders[tick] - 1);
}
function balAdd(balances, holders, tick, addr, delta) {
  const next = balGet(balances, tick, addr) + delta;
  if (next < 0n) return false;
  balSet(balances, holders, tick, addr, next);
  return true;
}

async function indexTickObjects(state) {
  let after = state.cursors.ticks?.after || null;
  if (state.cursors.ticks?.done) return;
  let pages = 0;
  while (true) {
    if (MAX_PAGES && pages >= MAX_PAGES) break;
    const data = await gql(
      `query($a:String){ objects(first:${PAGE}, after:$a, filter:{type:"${PKG}::suirc20::SUIRC20Tick"}){
        pageInfo{hasNextPage endCursor}
        nodes{ address asMoveObject{ contents{ json } } }
      }}`,
      { a: after },
    );
    for (const n of data.objects.nodes) {
      const j = n.asMoveObject?.contents?.json;
      if (!j?.tick) continue;
      const tick = j.tick;
      const createdMs = Number(j.created_ts || 0);
      state.ticks[tick] = {
        tick,
        tickId: n.address,
        p: j.p || 'suirc-20',
        max: String(j.max),
        lim: String(j.lim),
        fee: String(j.fee),
        dec: Number(j.dec ?? 9),
        freq: String(j.freq ?? '0'),
        pick: String(j.pick ?? '0'),
        share: !!j.share,
        creator: normAddr(j.creator),
        createdTs: createdMs || null,
        deployTimeBeijing: createdMs ? toBeijing(createdMs) : null,
        feeVault: String(j.fee_vault ?? '0'),
        version: 'v2',
      };
      if (!state.supply[tick]) state.supply[tick] = { minted: '0', mintCount: 0 };
    }
    pages++;
    after = data.objects.pageInfo.endCursor;
    state.cursors.ticks = { after, done: !data.objects.pageInfo.hasNextPage, pages: (state.cursors.ticks?.pages || 0) + 1 };
    console.log('ticks objects', Object.keys(state.ticks).length, 'page', pages);
    if (pages % FLUSH_EVERY === 0) publish(state);
    if (!data.objects.pageInfo.hasNextPage) { state.cursors.ticks.done = true; break; }
    await sleep(SLEEP_MS);
  }
}

async function indexEvents(state, eventName, apply) {
  const key = eventName;
  let after = state.cursors[key]?.after || null;
  if (state.cursors[key]?.done) return;
  let pages = 0;
  while (true) {
    if (MAX_PAGES && pages >= MAX_PAGES) break;
    const data = await gql(
      `query($t:String!,$a:String){ events(first:${PAGE}, after:$a, filter:{type:$t}){
        pageInfo{hasNextPage endCursor}
        nodes{ timestamp sender{address} contents{json} }
      }}`,
      { t: `${PKG}::suirc20::${eventName}`, a: after },
    );
    for (const n of data.events.nodes) {
      if (n.timestamp) state.stats.lastTs = n.timestamp;
      apply(state, n);
    }
    pages++;
    after = data.events.pageInfo.endCursor;
    state.cursors[key] = { after, done: !data.events.pageInfo.hasNextPage, pages: (state.cursors[key]?.pages || 0) + 1 };
    console.log(eventName, 'pages', state.cursors[key].pages, 'stats', state.stats.mintEvents, state.stats.transferEvents);
    if (pages % FLUSH_EVERY === 0) publish(state);
    if (!data.events.pageInfo.hasNextPage) { state.cursors[key].done = true; break; }
    await sleep(SLEEP_MS);
  }
}

function applyMint(state, n) {
  state.stats.mintEvents++;
  const j = n.contents?.json || {};
  const tick = j.tick;
  const amt = BigInt(j.amt || 0);
  const sender = normAddr(n.sender?.address);
  if (!tick || !sender) return;
  if (!state.ticks[tick]) {
    // tick object may not be loaded yet; still track balance against name
    state.ticks[tick] = { tick, tickId: j.tick_id || null, p: j.p || 'suirc-20', max: '0', lim: '0', fee: '0', dec: 9, version: 'v2', missingMeta: true };
  }
  if (amt > 0n) {
    balAdd(state.balances, state.holders, tick, sender, amt);
    const s = state.supply[tick] || { minted: '0', mintCount: 0 };
    state.supply[tick] = { minted: (BigInt(s.minted) + amt).toString(), mintCount: s.mintCount + 1 };
    state.stats.mintAccepted++;
  }
}

function applyTransfer(state, n) {
  state.stats.transferEvents++;
  const j = n.contents?.json || {};
  const tick = j.tick;
  const amt = BigInt(j.amt || 0);
  const from = normAddr(n.sender?.address);
  const to = normAddr(j.to);
  if (!tick || !from || !to || amt <= 0n) { state.stats.transferIgnored++; return; }
  if (!balAdd(state.balances, state.holders, tick, from, -amt)) { state.stats.transferIgnored++; return; }
  balAdd(state.balances, state.holders, tick, to, amt);
  state.stats.transferAccepted++;
}

function applyTransferFrom(state, n) {
  state.stats.transferFromEvents++;
  const j = n.contents?.json || {};
  const tick = j.tick;
  const amt = BigInt(j.amt || 0);
  const from = normAddr(j.from);
  const to = normAddr(j.to);
  if (!tick || !from || !to || amt <= 0n) { state.stats.transferIgnored++; return; }
  if (!balAdd(state.balances, state.holders, tick, from, -amt)) { state.stats.transferIgnored++; return; }
  balAdd(state.balances, state.holders, tick, to, amt);
  state.stats.transferAccepted++;
}

function publish(state) {
  const rows = Object.values(state.ticks).map((t) => {
    const sup = state.supply[t.tick] || { minted: '0', mintCount: 0 };
    const max = BigInt(t.max || 0);
    const minted = BigInt(sup.minted || 0);
    const progress = max === 0n ? 0 : Number((minted * 10000n) / max) / 100;
    return {
      ...t,
      minted: String(sup.minted || '0'),
      mintCount: sup.mintCount || 0,
      holderCount: state.holders[t.tick] || 0,
      progress,
      badge: '新版',
      source: 'suirc20v2',
    };
  });
  rows.sort((a, b) => b.holderCount - a.holderCount || a.tick.localeCompare(b.tick));

  const meta = {
    protocol: 'suirc-20',
    version: 'v2',
    package: PKG,
    globalConfig: GLOBAL_CONFIG,
    dataSource: {
      ticks: 'on-chain SUIRC20Tick shared objects (exact)',
      balances: 're-index from MintEvent/TransferEvent/TransferFromEvent (no on-chain balance table)',
    },
    marketplaceNote: 'Historical SuiMint marketplace was a separate package (validator-mediated); not built in this UI.',
    tickCount: rows.length,
    stats: state.stats,
    updatedAtBeijing: toBeijing(Date.now()),
    complete: !!(state.cursors.ticks?.done && state.cursors.MintEvent?.done && state.cursors.TransferEvent?.done && state.cursors.TransferFromEvent?.done),
  };

  writeJson(path.join(OUT, 'ticks.json'), { meta, ticks: rows });
  writeJson(path.join(OUT, 'meta.json'), meta);

  const top = new Set(rows.slice(0, 40).map((r) => r.tick));
  for (const pin of ['suis', 'dgen']) top.add(pin);
  for (const tick of top) {
    const map = state.balances[tick] || {};
    const holders = Object.entries(map)
      .map(([owner, balance]) => ({ owner, balance }))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
    writeJson(path.join(OUT, 'holders', `${encodeURIComponent(tick)}.json`), {
      tick, version: 'v2', totalHolders: holders.length, holders, updatedAtBeijing: meta.updatedAtBeijing,
    });
  }

  const shards = {};
  for (const [tick, map] of Object.entries(state.balances)) {
    for (const [owner, bal] of Object.entries(map)) {
      if (BigInt(bal) <= 0n) continue;
      const sk = shardKey(owner);
      if (!shards[sk]) shards[sk] = {};
      if (!shards[sk][owner]) shards[sk][owner] = {};
      shards[sk][owner][tick] = bal;
    }
  }
  for (const [sk, data] of Object.entries(shards)) writeJson(path.join(OUT, 'balances', `${sk}.json`), data);
  writeJson(path.join(OUT, 'balances', 'index.json'), { shardLen: 4, shards: Object.keys(shards).sort() });

  writeJson(path.join(STATE, 'cursors.json'), state.cursors);
  writeJson(path.join(STATE, 'ticks.json'), state.ticks);
  writeJson(path.join(STATE, 'balances-map.json'), state.balances);
  writeJson(path.join(STATE, 'holder-counts.json'), state.holders);
  writeJson(path.join(STATE, 'supply.json'), state.supply);
  writeJson(path.join(STATE, 'stats.json'), state.stats);
  console.log('published v2 ticks', rows.length, 'complete', meta.complete);
  return meta;
}

async function main() {
  ensure();
  const state = loadState();
  // Reset balances if replaying events from scratch when cursors incomplete for events but ticks done
  // Always: ticks first (on-chain), then events chronologically Deploy not needed for balances
  await indexTickObjects(state);
  publish(state);

  // For correct balances, events must be applied in order. If resuming mid-way, state already has partial.
  // If starting events fresh, clear balances once.
  if (!state.cursors.MintEvent && !state.cursors._balancesInited) {
    state.balances = {};
    state.holders = {};
    state.supply = Object.fromEntries(Object.keys(state.ticks).map((t) => [t, { minted: '0', mintCount: 0 }]));
    state.cursors._balancesInited = true;
  }

  await indexEvents(state, 'MintEvent', applyMint);
  await indexEvents(state, 'TransferEvent', applyTransfer);
  await indexEvents(state, 'TransferFromEvent', applyTransferFrom);
  state.stats.finishedAt = new Date().toISOString();
  publish(state);
  console.log('v2 done');
}

main().catch((e) => { console.error(e); process.exit(1); });
