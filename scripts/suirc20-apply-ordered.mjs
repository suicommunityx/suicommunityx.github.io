#!/usr/bin/env node
/**
 * Apply NDJSON Operation actions in global chronological order and publish.
 * Order key: checkpoint, timestamp, digest (checkpoint ranges are disjoint per pkg+fn).
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SUIRC20_OUT || path.join(ROOT, 'public', 'suirc20');
const STATE = path.join(OUT, 'state-fast');
const RAW_DIR = process.env.SUIRC20_RAW || '/workspace/suimint/suirc20/raw';
const PIN = ['suis', 'dgen'];
const UNTIL_CP = process.env.SUIRC20_UNTIL_CP ? Number(process.env.SUIRC20_UNTIL_CP) : null;
const UNTIL_TS = process.env.SUIRC20_UNTIL_TS || null;
const FLUSH_EVERY = Number(process.env.SUIRC20_APPLY_FLUSH || 500000);
const VERIFY_DIR = process.env.SUIRC20_VERIFY_DIR || '';

const PKGS = [
  '0xe09b37505173ae119a0ae3b1fdf9050a6b029391f9d9f10a3fff27e3f3115727',
  '0x2dd4e2523c0121c7e8405977e1d3909a8631df313934e965c472efc941ee3484',
];

function ensureDirs() {
  for (const d of [OUT, STATE, path.join(OUT, 'holders'), path.join(OUT, 'balances')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj, pretty = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
function toBeijing(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Shanghai`;
}
function isDigitStr(s) { return typeof s === 'string' && /^[0-9]+$/.test(s); }
function validAddr(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a); }
function shardKey(addr) { return addr.toLowerCase().replace(/^0x/, '').slice(0, 4); }
function balGet(balances, tick, addr) {
  const m = balances[tick];
  if (!m) return 0n;
  return BigInt(m[addr] || '0');
}
function balSet(balances, tick, addr, value) {
  if (!balances[tick]) balances[tick] = {};
  if (value === 0n) delete balances[tick][addr];
  else balances[tick][addr] = value.toString();
}
function balAdd(balances, holders, tick, addr, delta) {
  const before = balGet(balances, tick, addr);
  const after = before + delta;
  if (after < 0n) return false;
  const had = before > 0n;
  const has = after > 0n;
  balSet(balances, tick, addr, after);
  if (!holders[tick]) holders[tick] = 0;
  if (!had && has) holders[tick]++;
  if (had && !has) holders[tick] = Math.max(0, holders[tick] - 1);
  return true;
}

function applyDeploy(state, tx) {
  const ins = tx.ins;
  if (!ins || ins.p !== 'suirc-20' || ins.op !== 'deploy') return;
  const tick = ins.tick;
  if (typeof tick !== 'string' || !tick) return;
  if (!isDigitStr(ins.max)) return;
  if (state.ticks[tick]) return;
  const lim = ins.lim != null && ins.lim !== '' ? ins.lim : ins.max;
  if (!isDigitStr(lim)) return;
  const fee = ins.fee != null && ins.fee !== '' ? ins.fee : '0';
  if (!isDigitStr(fee)) return;
  let dec = 18;
  if (ins.dec != null && ins.dec !== '') {
    if (!isDigitStr(ins.dec)) return;
    dec = Number(ins.dec);
    if (dec > 18) return;
  }
  state.ticks[tick] = {
    tick, max: ins.max, lim, fee, dec,
    freq: typeof ins.freq === 'string' ? ins.freq : null,
    deployer: tx.sender, deployTimeUtc: tx.ts,
    deployTimeBeijing: toBeijing(tx.ts), digest: tx.digest,
  };
  if (!state.supply[tick]) state.supply[tick] = { minted: '0', mintCount: 0 };
  state.stats.deployTx++;
}

function applyMint(state, tx) {
  state.stats.mintTx++;
  const ins = tx.ins;
  if (!ins || ins.p !== 'suirc-20' || ins.op !== 'mint') { state.stats.mintIgnored++; return; }
  const tick = ins.tick;
  const def = state.ticks[tick];
  if (!def || !isDigitStr(ins.amt)) { state.stats.mintIgnored++; return; }
  const amt = BigInt(ins.amt);
  if (amt === 0n) { state.stats.mintIgnored++; return; }
  if (amt > BigInt(def.lim)) { state.stats.mintIgnored++; return; }
  const minted = BigInt(state.supply[tick]?.minted || '0');
  if (amt > BigInt(def.max) - minted) { state.stats.mintIgnored++; return; }
  balAdd(state.balances, state.holders, tick, tx.sender, amt);
  state.supply[tick] = { minted: (minted + amt).toString(), mintCount: (state.supply[tick]?.mintCount || 0) + 1 };
  state.stats.mintAccepted++;
}

function applyTransfer(state, tx) {
  state.stats.transferTx++;
  const ins = tx.ins;
  if (!ins || ins.p !== 'suirc-20' || ins.op !== 'transfer') { state.stats.transferIgnored++; return; }
  const tick = ins.tick;
  if (!state.ticks[tick] || !isDigitStr(ins.amt) || !validAddr(ins.to)) { state.stats.transferIgnored++; return; }
  const amt = BigInt(ins.amt);
  if (amt === 0n) { state.stats.transferIgnored++; return; }
  const toAddr = '0x' + ins.to.slice(2).toLowerCase();
  if (balGet(state.balances, tick, tx.sender) < amt) { state.stats.transferIgnored++; return; }
  balAdd(state.balances, state.holders, tick, tx.sender, -amt);
  balAdd(state.balances, state.holders, tick, toAddr, amt);
  state.stats.transferAccepted++;
}

function estimateProgress(state) {
  const start = Date.parse('2023-12-15T15:34:13.517Z');
  const end = Date.parse('2025-05-03T17:57:09.272Z');
  const last = state.stats.lastTs ? Date.parse(state.stats.lastTs) : start;
  const timePct = Math.max(0, Math.min(99.9, ((last - start) / (end - start)) * 100));
  const mintPct = Math.max(0, Math.min(99.9, (state.stats.mintTx / 1_000_000) * 100));
  return Math.round(Math.max(timePct, mintPct) * 10) / 10;
}
function pinSort(a, b) {
  const ra = PIN.indexOf(a.tick), rb = PIN.indexOf(b.tick);
  const aa = ra === -1 ? 99 : ra, bb = rb === -1 ? 99 : rb;
  if (aa !== bb) return aa - bb;
  return a.tick.localeCompare(b.tick);
}

function publish(state, { complete = false } = {}) {
  const tickRows = Object.values(state.ticks).map((t) => {
    const sup = state.supply[t.tick] || { minted: '0', mintCount: 0 };
    const minted = BigInt(sup.minted), max = BigInt(t.max);
    const progress = max === 0n ? 0 : Number((minted * 10000n) / max) / 100;
    return {
      tick: t.tick, max: t.max, lim: t.lim, dec: t.dec, fee: t.fee, freq: t.freq,
      deployer: t.deployer, deployTimeBeijing: t.deployTimeBeijing, deployTimeUtc: t.deployTimeUtc,
      digest: t.digest, minted: sup.minted, mintCount: sup.mintCount,
      holderCount: state.holders[t.tick] || 0, progress,
    };
  });
  tickRows.sort(pinSort);
  const tipCp = process.env.SUIRC20_SCAN_TIP_CP ? Number(process.env.SUIRC20_SCAN_TIP_CP) : null;
  const tipTs = process.env.SUIRC20_SCAN_TIP_TS || null;
  // Prefer explicit tip cursor so "scanned through" means chain tip, not last matching tx.
  if (tipTs) state.stats.lastTs = tipTs;
  if (tipCp != null && Number.isFinite(tipCp)) state.stats.lastCheckpoint = tipCp;
  const progressPct = complete ? 100 : estimateProgress(state);
  const scanBeijing = toBeijing(state.stats.lastTs) || '—';
  const meta = {
    protocol: 'suirc-20', packages: PKGS,
    cb5Note: '0xcb5bd7a2… Operation-witness ledger only; not merged.',
    rules: {
      caseSensitive: true, firstDeployWins: true, mintOverLimIgnored: true,
      mintOverMaxIgnored: true, partialLastMint: false, transferRequiresBalanceAndTo: true,
    },
    pinOrder: PIN, progressPct,
    // Prefer tick count + snapshot time + scan cursor; avoid "索引进度 XX%" wording.
    progressLabel: complete
      ? `${tickRows.length} ticks · 扫描到 ${scanBeijing}` + (state.stats.lastCheckpoint != null ? ` · CP ${state.stats.lastCheckpoint}` : '')
      : `${tickRows.length} ticks · 扫描到 ${scanBeijing}` + (state.stats.lastCheckpoint != null ? ` · CP ${state.stats.lastCheckpoint}` : ''),
    scannedTo: state.stats.lastTs || undefined,
    stats: state.stats, tickCount: tickRows.length,
    updatedAtBeijing: toBeijing(new Date().toISOString()), complete,
    pipeline: 'fetch-parallel+apply-ordered',
  };
  writeJson(path.join(OUT, 'ticks.json'), { meta, ticks: tickRows });
  writeJson(path.join(OUT, 'meta.json'), meta, true);

  const byMint = [...tickRows].sort((a, b) => b.mintCount - a.mintCount);
  const topSet = new Set([...PIN, ...byMint.slice(0, 40).map((t) => t.tick)]);
  for (const tick of topSet) {
    const map = state.balances[tick] || {};
    const holders = Object.entries(map)
      .map(([owner, balance]) => ({ owner, balance }))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));
    writeJson(path.join(OUT, 'holders', `${encodeURIComponent(tick)}.json`), {
      tick, updatedAtBeijing: meta.updatedAtBeijing, totalHolders: holders.length, holders,
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
  const balDir = path.join(OUT, 'balances');
  for (const [sk, data] of Object.entries(shards)) writeJson(path.join(balDir, `${sk}.json`), data);
  writeJson(path.join(balDir, 'index.json'), {
    shardLen: 4, shards: Object.keys(shards).sort(),
    note: 'balances/<first4 hex>.json → { address: { tick: amount } }',
  });
  writeJson(path.join(STATE, 'supply.json'), state.supply);
  writeJson(path.join(STATE, 'holder-counts.json'), state.holders);
  writeJson(path.join(STATE, 'stats.json'), state.stats);
  writeJson(path.join(STATE, 'tick-defs.json'), state.ticks);
  const suis = tickRows.find((t) => t.tick === 'suis');
  const dgen = tickRows.find((t) => t.tick === 'dgen');
  console.log(
    '[publish]', meta.progressLabel,
    'ticks=', tickRows.length,
    'mintAcc=', state.stats.mintAccepted,
    'xferAcc=', state.stats.transferAccepted,
    'suis', suis?.minted, '/', suis?.holderCount,
    'dgen', dgen?.minted, '/', dgen?.holderCount,
  );
  return meta;
}

function seedDeploys(state) {
  const researchRaw = '/workspace/suimint/suirc20/deploys_raw.json';
  if (!fs.existsSync(researchRaw)) throw new Error('missing deploys_raw.json');
  const rows = JSON.parse(fs.readFileSync(researchRaw, 'utf8'));
  for (const d of rows) {
    if (d.status && d.status !== 'SUCCESS') continue;
    applyDeploy(state, { digest: d.digest, sender: d.sender, ts: d.timestamp, ins: d.inscription });
  }
  console.log('[seed] deploys', Object.keys(state.ticks).length);
}

async function* readNdjson(file) {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

function sortKey(x) {
  const cp = x.checkpoint == null ? Number.MAX_SAFE_INTEGER : Number(x.checkpoint);
  return [cp, x.ts || '', x.digest || ''];
}
function cmpKey(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

async function* mergeFiles(files) {
  const iters = [];
  for (const f of files) {
    const it = readNdjson(f)[Symbol.asyncIterator]();
    const n = await it.next();
    if (!n.done) iters.push({ it, cur: n.value, key: sortKey(n.value) });
  }
  while (iters.length) {
    let bestI = 0;
    for (let i = 1; i < iters.length; i++) {
      if (cmpKey(iters[i].key, iters[bestI].key) < 0) bestI = i;
    }
    const best = iters[bestI];
    yield best.cur;
    const n = await best.it.next();
    if (n.done) iters.splice(bestI, 1);
    else {
      best.cur = n.value;
      best.key = sortKey(n.value);
    }
  }
}

async function main() {
  ensureDirs();
  const state = {
    ticks: {}, supply: {}, holders: {}, balances: {},
    stats: {
      mintTx: 0, transferTx: 0, deployTx: 0,
      mintAccepted: 0, mintIgnored: 0, transferAccepted: 0, transferIgnored: 0,
      lastTs: null, lastCheckpoint: null, startedAt: new Date().toISOString(),
    },
  };
  seedDeploys(state);

  const files = fs.readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.ndjson') && (f.startsWith('mint-') || f.startsWith('transfer-')))
    .map((f) => path.join(RAW_DIR, f))
    .filter((f) => fs.statSync(f).size > 0)
    .sort();
  if (!files.length) {
    console.error('No NDJSON in', RAW_DIR);
    process.exit(1);
  }
  console.log('[apply] merging', files.length, 'files', 'until_cp', UNTIL_CP, 'until_ts', UNTIL_TS);

  let n = 0;
  const t0 = Date.now();
  const seen = new Set();
  let dupes = 0;
  for await (const tx of mergeFiles(files)) {
    if (UNTIL_CP != null && tx.checkpoint != null && Number(tx.checkpoint) > UNTIL_CP) continue;
    if (UNTIL_TS && tx.ts && tx.ts > UNTIL_TS) continue;
    if (tx.digest) {
      const dk = tx.digest + ':' + (tx.fn || '');
      if (seen.has(dk)) { dupes++; continue; }
      // V8 Set max ~16.7M; keep a rolling window (shards mostly local).
      if (seen.size >= 12_000_000) seen.clear();
      seen.add(dk);
    }
    if (tx.ts) state.stats.lastTs = tx.ts;
    if (tx.checkpoint != null) state.stats.lastCheckpoint = tx.checkpoint;
    if (tx.fn === 'mint') applyMint(state, tx);
    else if (tx.fn === 'transfer') applyTransfer(state, tx);
    n++;
    if (n % FLUSH_EVERY === 0) {
      console.log('[apply] processed', n, 'dupes', dupes, 'min', ((Date.now() - t0) / 60000).toFixed(1));
      publish(state, { complete: false });
    }
  }
  state.stats.finishedAt = new Date().toISOString();
  state.stats.dupesSkipped = dupes;
  // Tip catch-up: complete means scanned through tip (env), not "finished May 2025".
  const complete = (UNTIL_CP == null && !UNTIL_TS) || Boolean(process.env.SUIRC20_SCAN_TIP_CP || process.env.SUIRC20_SCAN_TIP_TS);
  publish(state, { complete });
  writeJson(path.join(STATE, 'balances-map.json'), state.balances);
  console.log('[apply] DONE rows=', n, 'dupes', dupes, 'min', ((Date.now() - t0) / 60000).toFixed(2));

  if (VERIFY_DIR) {
    const liveSupply = readJson(path.join(VERIFY_DIR, 'state/supply.json'), {});
    const liveHolders = readJson(path.join(VERIFY_DIR, 'state/holder-counts.json'), {});
    for (const tick of ['suis', 'dgen']) {
      const a = state.supply[tick]?.minted || '0';
      const b = liveSupply[tick]?.minted || '0';
      const ha = state.holders[tick] || 0;
      const hb = liveHolders[tick] || 0;
      console.log(`[verify] ${tick} minted fast=${a} live=${b} match=${a === b} holders fast=${ha} live=${hb} match=${ha === hb}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
