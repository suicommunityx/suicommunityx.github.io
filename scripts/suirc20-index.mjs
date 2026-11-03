#!/usr/bin/env node
/**
 * SuiMint SUIRC-20 Operation indexer (JSON witness).
 *
 * Indexes Operation::{deploy,mint,transfer} on:
 *   - 0xe09b3750… (v1) and 0x2dd4e252… (v2 package upgrade)
 *
 * Does NOT merge the later 0xcb5bd7a2 on-chain SUIRC20Tick ledger into balances:
 * that package is also SuiMint (archived frontend mainnet config) but uses a
 * different Move API (structured suirc20::deploy/mint/transfer + on-chain ticks).
 * Its Operation module had ~0 historical txs; see meta.cb5Note.
 *
 * Rules (case-sensitive, BRC-20-like):
 *   - first successful deploy per exact tick string wins
 *   - mint ignored if amt > lim or amt > remaining (no partial fill; classic BRC-20)
 *   - transfer ignored if insufficient balance or missing/invalid `to`
 *   - numeric fields must be digit strings; p must be "suirc-20"
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'suirc20');
const STATE = path.join(OUT, 'state');
const GQL = process.env.SUI_GRAPHQL || 'https://graphql.mainnet.sui.io/graphql';
const PAGE = Number(process.env.SUIRC20_PAGE || 50);
const MAX_PAGES = Number(process.env.SUIRC20_MAX_PAGES || 0); // 0 = unlimited
const FLUSH_EVERY = Number(process.env.SUIRC20_FLUSH_EVERY || 40);
const SLEEP_MS = Number(process.env.SUIRC20_SLEEP_MS || 350);
const PIN = ['suis', 'dgen'];

const PKGS = [
  '0xe09b37505173ae119a0ae3b1fdf9050a6b029391f9d9f10a3fff27e3f3115727',
  '0x2dd4e2523c0121c7e8405977e1d3909a8631df313934e965c472efc941ee3484',
];

function ensureDirs() {
  for (const d of [OUT, STATE, path.join(OUT, 'holders'), path.join(OUT, 'balances'), path.join(STATE, 'balances')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gql(query, variables = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(GQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429) {
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 5));
        console.warn('429 backoff', wait, 'ms');
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const json = await res.json();
      if (json.errors?.length) {
        const msg = json.errors[0].message || 'graphql error';
        if (/rate|429|thrott/i.test(msg)) {
          const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 5));
          console.warn('gql throttle', wait, msg);
          await sleep(wait);
          continue;
        }
        throw new Error(msg);
      }
      return json.data;
    } catch (e) {
      if (attempt >= 8) throw e;
      const wait = Math.min(40_000, 800 * 2 ** attempt);
      console.warn('retry', attempt, e.message || e, 'sleep', wait);
      await sleep(wait);
    }
  }
}

function bcsStringFromPure(pure) {
  if (typeof pure !== 'string') return null;
  let raw;
  try {
    raw = Buffer.from(pure, 'base64');
  } catch {
    return null;
  }
  const idx = raw.indexOf(0x7b); // '{'
  if (idx < 0) return null;
  const slice = raw.subarray(idx);
  const end = slice.lastIndexOf(0x7d);
  if (end < 0) return null;
  try {
    return JSON.parse(slice.subarray(0, end + 1).toString('utf8'));
  } catch {
    return null;
  }
}

function parseInscription(transactionJson) {
  let tj = transactionJson;
  if (typeof tj === 'string') {
    try {
      tj = JSON.parse(tj);
    } catch {
      return null;
    }
  }
  const inputs =
    tj?.kind?.programmableTransaction?.inputs ||
    tj?.transaction?.kind?.programmableTransaction?.inputs ||
    tj?.inputs ||
    [];
  for (const inp of inputs) {
    if (!inp || typeof inp !== 'object') continue;
    const parsed = bcsStringFromPure(inp.pure);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof inp.value === 'string' && inp.value.startsWith('{')) {
      try {
        return JSON.parse(inp.value);
      } catch {}
    }
  }
  return null;
}

function isDigitStr(s) {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}

function validAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a);
}

function toBeijing(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Shanghai`;
}

function shardKey(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  return a.slice(0, 4);
}

function loadLedger() {
  const cursors = readJson(path.join(STATE, 'cursors.json'), {});
  const ticks = readJson(path.join(STATE, 'tick-defs.json'), {});
  const supply = readJson(path.join(STATE, 'supply.json'), {});
  const holders = readJson(path.join(STATE, 'holder-counts.json'), {});
  const stats = readJson(path.join(STATE, 'stats.json'), {
    mintTx: 0,
    transferTx: 0,
    deployTx: 0,
    mintAccepted: 0,
    mintIgnored: 0,
    transferAccepted: 0,
    transferIgnored: 0,
    lastTs: null,
    startedAt: new Date().toISOString(),
  });
  // balances: tick -> { addr -> bigint-as-string }
  const balances = readJson(path.join(STATE, 'balances-map.json'), {});
  return { cursors, ticks, supply, holders, stats, balances };
}

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
  if (state.ticks[tick]) return; // first-wins
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
    tick,
    max: ins.max,
    lim,
    fee,
    dec,
    freq: typeof ins.freq === 'string' ? ins.freq : null,
    deployer: tx.sender,
    deployTimeUtc: tx.ts,
    deployTimeBeijing: toBeijing(tx.ts),
    digest: tx.digest,
  };
  if (!state.supply[tick]) state.supply[tick] = { minted: '0', mintCount: 0 };
  state.stats.deployTx++;
}

function applyMint(state, tx) {
  state.stats.mintTx++;
  const ins = tx.ins;
  if (!ins || ins.p !== 'suirc-20' || ins.op !== 'mint') {
    state.stats.mintIgnored++;
    return;
  }
  const tick = ins.tick;
  const def = state.ticks[tick];
  if (!def) {
    state.stats.mintIgnored++;
    return;
  }
  if (!isDigitStr(ins.amt)) {
    state.stats.mintIgnored++;
    return;
  }
  const amt = BigInt(ins.amt);
  if (amt === 0n) {
    state.stats.mintIgnored++;
    return;
  }
  const lim = BigInt(def.lim);
  if (amt > lim) {
    state.stats.mintIgnored++;
    return;
  }
  const max = BigInt(def.max);
  const minted = BigInt(state.supply[tick]?.minted || '0');
  const remain = max - minted;
  if (amt > remain) {
    // classic BRC-20: ignore entirely (no partial)
    state.stats.mintIgnored++;
    return;
  }
  balAdd(state.balances, state.holders, tick, tx.sender, amt);
  state.supply[tick] = {
    minted: (minted + amt).toString(),
    mintCount: (state.supply[tick]?.mintCount || 0) + 1,
  };
  state.stats.mintAccepted++;
}

function applyTransfer(state, tx) {
  state.stats.transferTx++;
  const ins = tx.ins;
  if (!ins || ins.p !== 'suirc-20' || ins.op !== 'transfer') {
    state.stats.transferIgnored++;
    return;
  }
  const tick = ins.tick;
  if (!state.ticks[tick]) {
    state.stats.transferIgnored++;
    return;
  }
  if (!isDigitStr(ins.amt) || !validAddr(ins.to)) {
    state.stats.transferIgnored++;
    return;
  }
  const amt = BigInt(ins.amt);
  if (amt === 0n) {
    state.stats.transferIgnored++;
    return;
  }
  const from = tx.sender;
  const to = ins.to.toLowerCase().replace(/^0x/, '0x');
  const normTo = '0x' + to.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  // keep original casing from payload if valid length
  const toAddr = ins.to.startsWith('0x') ? '0x' + ins.to.slice(2).toLowerCase() : ins.to.toLowerCase();
  if (balGet(state.balances, tick, from) < amt) {
    state.stats.transferIgnored++;
    return;
  }
  balAdd(state.balances, state.holders, tick, from, -amt);
  balAdd(state.balances, state.holders, tick, toAddr, amt);
  state.stats.transferAccepted++;
}

function estimateProgress(state) {
  // Blend chain-time span with mint volume heuristic (~1e6 lim-sized suis mints upper bound).
  const start = Date.parse('2023-12-15T15:34:13.517Z');
  const end = Date.parse('2025-05-03T17:57:09.272Z');
  const last = state.stats.lastTs ? Date.parse(state.stats.lastTs) : start;
  const timePct = Math.max(0, Math.min(99.9, ((last - start) / (end - start)) * 100));
  const mintPct = Math.max(0, Math.min(99.9, (state.stats.mintTx / 1_000_000) * 100));
  const pct = Math.max(timePct, mintPct);
  return Math.round(pct * 10) / 10;
}

function pinSort(a, b) {
  const ra = PIN.indexOf(a.tick);
  const rb = PIN.indexOf(b.tick);
  const aa = ra === -1 ? 99 : ra;
  const bb = rb === -1 ? 99 : rb;
  if (aa !== bb) return aa - bb;
  return a.tick.localeCompare(b.tick);
}

function publish(state) {
  const tickRows = Object.values(state.ticks).map((t) => {
    const sup = state.supply[t.tick] || { minted: '0', mintCount: 0 };
    const minted = BigInt(sup.minted);
    const max = BigInt(t.max);
    const progress = max === 0n ? 0 : Number((minted * 10000n) / max) / 100;
    return {
      tick: t.tick,
      max: t.max,
      lim: t.lim,
      dec: t.dec,
      fee: t.fee,
      freq: t.freq,
      deployer: t.deployer,
      deployTimeBeijing: t.deployTimeBeijing,
      deployTimeUtc: t.deployTimeUtc,
      digest: t.digest,
      minted: sup.minted,
      mintCount: sup.mintCount,
      holderCount: state.holders[t.tick] || 0,
      progress,
    };
  });
  tickRows.sort(pinSort);

  const progressPct = estimateProgress(state);
  const meta = {
    protocol: 'suirc-20',
    packages: PKGS,
    cb5Note:
      '0xcb5bd7a2… is also SuiMint (archived app mainnet package) with on-chain SUIRC20Tick; not merged into this Operation-witness ledger. Index Operation JSON only.',
    rules: {
      caseSensitive: true,
      firstDeployWins: true,
      mintOverLimIgnored: true,
      mintOverMaxIgnored: true,
      partialLastMint: false,
      transferRequiresBalanceAndTo: true,
    },
    pinOrder: PIN,
    progressPct,
    progressLabel: `索引进度 ${progressPct}%（扫描到 ${toBeijing(state.stats.lastTs) || '—'}）`,
    stats: state.stats,
    tickCount: tickRows.length,
    updatedAtBeijing: toBeijing(new Date().toISOString()),
    complete: false,
  };

  writeJson(path.join(OUT, 'ticks.json'), { meta, ticks: tickRows });
  writeJson(path.join(OUT, 'meta.json'), meta);

  // top ticks by mintCount + pins
  const byMint = [...tickRows].sort((a, b) => b.mintCount - a.mintCount);
  const topSet = new Set([...PIN, ...byMint.slice(0, 30).map((t) => t.tick)]);
  for (const tick of topSet) {
    const map = state.balances[tick] || {};
    const holders = Object.entries(map)
      .map(([owner, balance]) => ({ owner, balance }))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));
    writeJson(path.join(OUT, 'holders', `${encodeURIComponent(tick)}.json`), {
      tick,
      updatedAtBeijing: meta.updatedAtBeijing,
      totalHolders: holders.length,
      holders,
    });
  }

  // balance shards: rebuild from balances map (only addresses with any balance)
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
  // clear old shards that are empty? keep writing current set
  const balDir = path.join(OUT, 'balances');
  for (const [sk, data] of Object.entries(shards)) {
    writeJson(path.join(balDir, `${sk}.json`), data);
  }
  writeJson(path.join(OUT, 'balances', 'index.json'), {
    shardLen: 4,
    shards: Object.keys(shards).sort(),
    note: 'balances/<first4 hex of address without 0x>.json → { address: { tick: amount } }',
  });

  // persist state
  writeJson(path.join(STATE, 'cursors.json'), state.cursors);
  writeJson(path.join(STATE, 'tick-defs.json'), state.ticks);
  writeJson(path.join(STATE, 'supply.json'), state.supply);
  writeJson(path.join(STATE, 'holder-counts.json'), state.holders);
  writeJson(path.join(STATE, 'stats.json'), state.stats);
  writeJson(path.join(STATE, 'balances-map.json'), state.balances);

  console.log(
    'published',
    'ticks=',
    tickRows.length,
    'progress=',
    meta.progressLabel,
    'mintAcc=',
    state.stats.mintAccepted,
    'mintIgn=',
    state.stats.mintIgnored,
  );
  return meta;
}

async function pageFunction(pkg, fn, after) {
  const f = `${pkg}::Operation::${fn}`;
  const data = await gql(
    `query($f:String!,$a:String){
      transactions(first:${PAGE}, after:$a, filter:{function:$f}){
        pageInfo{hasNextPage endCursor}
        nodes{
          digest
          sender{address}
          effects{timestamp status}
          transactionJson
        }
      }
    }`,
    { f, a: after },
  );
  return data.transactions;
}

async function indexFunction(state, pkg, fn, apply) {
  const key = `${pkg}:${fn}`;
  let after = state.cursors[key]?.after || null;
  let done = state.cursors[key]?.done || false;
  if (done) return 0;
  let pages = 0;
  let processed = 0;
  while (true) {
    if (MAX_PAGES && pages >= MAX_PAGES) break;
    const conn = await pageFunction(pkg, fn, after);
    const nodes = conn.nodes || [];
    for (const n of nodes) {
      if (n.effects?.status && n.effects.status !== 'SUCCESS') continue;
      const ins = parseInscription(n.transactionJson);
      const tx = {
        digest: n.digest,
        sender: n.sender?.address,
        ts: n.effects?.timestamp,
        ins,
      };
      if (tx.ts) state.stats.lastTs = tx.ts;
      apply(state, tx);
      processed++;
    }
    pages++;
    state.cursors[key] = {
      after: conn.pageInfo.endCursor,
      done: !conn.pageInfo.hasNextPage,
      pages: (state.cursors[key]?.pages || 0) + 1,
      processed: (state.cursors[key]?.processed || 0) + nodes.length,
    };
    after = conn.pageInfo.endCursor;
    if (pages % FLUSH_EVERY === 0) publish(state);
    if (!conn.pageInfo.hasNextPage) {
      state.cursors[key].done = true;
      break;
    }
    await sleep(SLEEP_MS);
  }
  return processed;
}

function seedDeploysFromResearch(state) {
  const researchCsv = '/workspace/suimint/suirc20/ticks_first_wins.csv';
  const researchRaw = '/workspace/suimint/suirc20/deploys_raw.json';
  if (Object.keys(state.ticks).length > 0) return;
  if (fs.existsSync(researchRaw)) {
    const rows = JSON.parse(fs.readFileSync(researchRaw, 'utf8'));
    for (const d of rows) {
      if (d.status && d.status !== 'SUCCESS') continue;
      applyDeploy(state, {
        digest: d.digest,
        sender: d.sender,
        ts: d.timestamp,
        ins: d.inscription,
      });
    }
    // mark deploy cursors done for both pkgs if we fully seeded from research
    for (const pkg of PKGS) {
      state.cursors[`${pkg}:deploy`] = {
        after: null,
        done: true,
        pages: 0,
        processed: rows.length,
        seededFrom: researchRaw,
      };
    }
    console.log('seeded deploys from research', Object.keys(state.ticks).length);
    return;
  }
  if (fs.existsSync(researchCsv)) {
    const text = fs.readFileSync(researchCsv, 'utf8').trim().split('\n').slice(1);
    for (const line of text) {
      // tick,max,lim,fee,freq,dec,deployer,deploy_time_beijing,digest
      const parts = line.split(',');
      if (parts.length < 9) continue;
      const tick=parts[0], max=parts[1], lim=parts[2], fee=parts[3], freq=parts[4], dec=parts[5], deployer=parts[6], deploy_time_beijing=parts[7], digest=parts[8];
      // beijing time may contain commas? our csv doesn't
      state.ticks[tick] = {
        tick,
        max,
        lim,
        fee,
        dec: dec ? Number(dec) : 18,
        freq: freq || null,
        deployer,
        deployTimeUtc: null,
        deployTimeBeijing: deploy_time_beijing,
        digest,
      };
      state.supply[tick] = { minted: '0', mintCount: 0 };
    }
    console.log('seeded deploys from csv', Object.keys(state.ticks).length);
  }
}

async function main() {
  ensureDirs();
  const state = loadLedger();
  seedDeploysFromResearch(state);
  publish(state);

  // Order: finish any remaining deploys, then mints, then transfers (BRC-20 transfer after mint)
  // For resume: each cursor independent. Prefer mint before transfer for balance correctness
  // when both incomplete — process in chronological merge would be ideal; with separate
  // streams we process mint fully then transfer (transfers that happen mid-mint era may
  // temporarily fail then… actually that's wrong for interleaved history).
  //
  // Better approach: interleaved by fetching both with timestamps — for correctness on
  // first full build, process ALL ops in time order via a merge queue.
  // Practical MVP: mint first (dominant), then replay transfers. Early transfers during
  // mint era may be ignored incorrectly if we mint-first fully then transfer.
  //
  // Correct approach for this script: single chronological merge of mint+transfer pages.
  await indexChronological(state);

  state.stats.finishedAt = new Date().toISOString();
  const meta = publish(state);
  // mark complete if all cursors done
  const allDone = Object.values(state.cursors).every((c) => c.done);
  if (allDone) {
    meta.complete = true;
    meta.progressPct = 100;
    meta.progressLabel = `索引进度 100%（扫描完成 ${toBeijing(state.stats.lastTs) || ''}）`;
    writeJson(path.join(OUT, 'meta.json'), meta);
    const ticks = readJson(path.join(OUT, 'ticks.json'), {});
    ticks.meta = meta;
    writeJson(path.join(OUT, 'ticks.json'), ticks);
  }
  console.log('done', meta.progressLabel);
}

/**
 * Chronological indexer: advance mint/transfer (and undeployed deploy) cursors
 * by always consuming the earliest next page head.
 */
async function indexChronological(state) {
  // Ensure deploys indexed (or seeded)
  for (const pkg of PKGS) {
    await indexFunction(state, pkg, 'deploy', applyDeploy);
  }
  publish(state);

  // Prepare streams for mint & transfer across packages
  const streams = [];
  for (const pkg of PKGS) {
    for (const fn of ['mint', 'transfer']) {
      streams.push({ pkg, fn, buffer: [], after: state.cursors[`${pkg}:${fn}`]?.after || null, done: !!state.cursors[`${pkg}:${fn}`]?.done });
    }
  }

  async function fill(stream) {
    if (stream.done) return;
    if (stream.buffer.length) return;
    const conn = await pageFunction(stream.pkg, stream.fn, stream.after);
    for (const n of conn.nodes || []) {
      if (n.effects?.status && n.effects.status !== 'SUCCESS') continue;
      stream.buffer.push({
        digest: n.digest,
        sender: n.sender?.address,
        ts: n.effects?.timestamp,
        ins: parseInscription(n.transactionJson),
        fn: stream.fn,
        pkg: stream.pkg,
      });
    }
    stream.after = conn.pageInfo.endCursor;
    stream.done = !conn.pageInfo.hasNextPage;
    const key = `${stream.pkg}:${stream.fn}`;
    state.cursors[key] = {
      after: stream.after,
      done: stream.done,
      pages: (state.cursors[key]?.pages || 0) + 1,
      processed: (state.cursors[key]?.processed || 0) + (conn.nodes?.length || 0),
    };
    await sleep(SLEEP_MS);
  }

  let steps = 0;
  while (true) {
    for (const s of streams) await fill(s);
    // pick earliest buffered tx
    let best = null;
    let bestStream = null;
    for (const s of streams) {
      if (!s.buffer.length) continue;
      const t = s.buffer[0];
      if (!best || (t.ts || '') < (best.ts || '')) {
        best = t;
        bestStream = s;
      }
    }
    if (!best) break; // all done
    bestStream.buffer.shift();
    if (best.ts) state.stats.lastTs = best.ts;
    if (best.fn === 'mint') applyMint(state, best);
    else applyTransfer(state, best);
    steps++;
    if (steps % (PAGE * FLUSH_EVERY) === 0) publish(state);
    if (MAX_PAGES && steps >= MAX_PAGES * PAGE) {
      console.log('MAX_PAGES reached, pausing');
      publish(state);
      return;
    }
  }
  publish(state);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
