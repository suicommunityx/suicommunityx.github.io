import { Transaction } from '@mysten/sui/transactions';
import { client, friendlyRpcError } from './rpc';

/** Original SuiMint Operation package (JSON witness). */
export const SUIRC20_OPERATION_PACKAGE =
  '0xe09b37505173ae119a0ae3b1fdf9050a6b029391f9d9f10a3fff27e3f3115727';

/** Later SuiMint on-chain SUIRC20Tick package. */
export const SUIRC20_V2_PACKAGE =
  '0xcb5bd7a29f458a1b1e0221516fbfaeb182be027033eb8dcb4f33dd540d20bb87';

export const SUIRC20_V2_GLOBAL_CONFIG =
  '0xc584d0d14cb3a020f8b1411275abc39d1a3d954a4c922d3efa9d03cba9e86ef9';

export const SUI_CLOCK_OBJECT_ID = '0x6';

export const SUIRC20_PIN = ['suis', 'dgen'] as const;

export type Suirc20Tick = {
  tick: string;
  max: string;
  lim: string;
  dec: number;
  fee: string;
  freq: string | null;
  deployer: string;
  deployTimeBeijing: string | null;
  deployTimeUtc?: string | null;
  digest?: string;
  minted: string;
  mintCount: number;
  holderCount: number;
  progress: number;
  /** Prefer on-chain v2 when exact tick match. */
  version?: 'v1' | 'v2';
  badge?: string | null;
  source?: string;
  tickId?: string | null;
  /** v2 on-chain created_ts (ms) when available */
  createdTs?: number | string | null;
};

export type Suirc20Meta = {
  progressPct: number;
  progressLabel: string;
  tickCount: number;
  complete?: boolean;
  updatedAtBeijing?: string;
  stats?: Record<string, unknown>;
  cb5Note?: string;
  v2?: {
    tickCount: number;
    complete?: boolean;
    updatedAtBeijing?: string;
    dataSource?: Record<string, string>;
  };
};

export type Suirc20Holder = { owner: string; balance: string };

function suirc20DeployMs(t: {
  deployTimeUtc?: string | null;
  deployTimeBeijing?: string | null;
  createdTs?: number | string | null;
}): number {
  const times: number[] = [];
  if (t.createdTs != null && t.createdTs !== '') {
    const n = Number(t.createdTs);
    if (Number.isFinite(n) && n > 0) times.push(n);
  }
  if (t.deployTimeUtc) {
    const n = Date.parse(t.deployTimeUtc);
    if (Number.isFinite(n)) times.push(n);
  }
  if (t.deployTimeBeijing) {
    // "2023-12-15 23:34:13 Asia/Shanghai" → treat as +08:00
    const m = String(t.deployTimeBeijing).match(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/,
    );
    if (m) {
      const n = Date.parse(`${m[1]}T${m[2]}+08:00`);
      if (Number.isFinite(n)) times.push(n);
    }
  }
  if (!times.length) return Number.POSITIVE_INFINITY;
  return Math.min(...times);
}

/** SuiMint: suis #1, dgen #2 pinned; then oldest deploy first. */
export function pinSuirc20Ticks<
  T extends {
    tick: string;
    deployTimeUtc?: string | null;
    deployTimeBeijing?: string | null;
    createdTs?: number | string | null;
  },
>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = SUIRC20_PIN.indexOf(a.tick as (typeof SUIRC20_PIN)[number]);
    const rb = SUIRC20_PIN.indexOf(b.tick as (typeof SUIRC20_PIN)[number]);
    const aa = ra === -1 ? 99 : ra;
    const bb = rb === -1 ? 99 : rb;
    if (aa !== bb) return aa - bb;
    const ta = suirc20DeployMs(a);
    const tb = suirc20DeployMs(b);
    if (ta !== tb) return ta - tb;
    return a.tick.localeCompare(b.tick);
  });
}

/** 新版: pin suis first if present, then oldest create/deploy. */
export function pinSuirc20TicksV2<
  T extends {
    tick: string;
    deployTimeUtc?: string | null;
    deployTimeBeijing?: string | null;
    createdTs?: number | string | null;
  },
>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.tick === 'suis' && b.tick !== 'suis') return -1;
    if (b.tick === 'suis' && a.tick !== 'suis') return 1;
    const ta = suirc20DeployMs(a);
    const tb = suirc20DeployMs(b);
    if (ta !== tb) return ta - tb;
    return a.tick.localeCompare(b.tick);
  });
}

function normV1(t: any): Suirc20Tick {
  return {
    tick: t.tick,
    max: String(t.max ?? '0'),
    lim: String(t.lim ?? '0'),
    dec: Number(t.dec ?? 0),
    fee: String(t.fee ?? '0'),
    freq: t.freq == null ? null : String(t.freq),
    deployer: t.deployer || '',
    deployTimeBeijing: t.deployTimeBeijing || null,
    deployTimeUtc: t.deployTimeUtc || null,
    digest: t.digest || '',
    minted: String(t.minted ?? '0'),
    mintCount: Number(t.mintCount ?? 0),
    holderCount: Number(t.holderCount ?? 0),
    progress: Number(t.progress ?? 0),
    version: 'v1',
    badge: null,
    source: 'suirc20',
    tickId: null,
  };
}

function normV2(t: any): Suirc20Tick {
  return {
    tick: t.tick,
    max: String(t.max ?? '0'),
    lim: String(t.lim ?? '0'),
    dec: Number(t.dec ?? 0),
    fee: String(t.fee ?? '0'),
    freq: t.freq == null ? null : String(t.freq),
    deployer: t.creator || t.deployer || '',
    deployTimeBeijing: t.deployTimeBeijing || null,
    deployTimeUtc: t.deployTimeUtc || null,
    digest: t.digest || '',
    minted: String(t.minted ?? '0'),
    mintCount: Number(t.mintCount ?? 0),
    holderCount: Number(t.holderCount ?? 0),
    progress: Number(t.progress ?? 0),
    version: 'v2',
    badge: t.badge || '新版',
    source: 'suirc20v2',
    tickId: t.tickId || null,
    createdTs: t.createdTs ?? null,
  };
}

/** Merge Operation (v1) + on-chain SUIRC20Tick (v2). Exact tick → on-chain meta + 新版; keep richer supply stats. */
export function mergeSuirc20Ticks(v1: Suirc20Tick[], v2: Suirc20Tick[]): Suirc20Tick[] {
  const map = new Map<string, Suirc20Tick>();
  for (const t of v1) map.set(t.tick, t);
  for (const t of v2) {
    const prev = map.get(t.tick);
    if (!prev) {
      map.set(t.tick, t);
      continue;
    }
    const v1m = BigInt(prev.minted || '0');
    const v2m = BigInt(t.minted || '0');
    const useSupply = v2m >= v1m ? t : prev;
    map.set(t.tick, {
      ...t,
      // on-chain meta wins (fee/max/lim/tickId/badge)
      minted: useSupply.minted,
      mintCount: useSupply.mintCount,
      holderCount: Math.max(t.holderCount || 0, prev.holderCount || 0),
      progress: useSupply.progress,
      // keep Operation deployer/time if v2 missing
      deployer: t.deployer || prev.deployer,
      deployTimeBeijing: t.deployTimeBeijing || prev.deployTimeBeijing,
      deployTimeUtc: t.deployTimeUtc || prev.deployTimeUtc,
      createdTs: t.createdTs ?? (prev as any).createdTs ?? null,
      digest: t.digest || prev.digest,
    });
  }
  return pinSuirc20Ticks([...map.values()]);
}

export type Suirc20Version = 'v1' | 'v2';

/** Load ticks for one version only — never merge same-name ticks across versions. */
export async function loadSuirc20TicksByVersion(
  version: Suirc20Version,
): Promise<{ meta: Suirc20Meta; ticks: Suirc20Tick[] }> {
  const base = import.meta.env.BASE_URL;
  if (version === 'v1') {
    const res = await fetch(`${base}suirc20/ticks.json`);
    if (!res.ok) throw new Error('无法加载 SuiMint 旧版索引 ticks.json');
    const data = await res.json();
    const mappedV1: Suirc20Tick[] = (data.ticks || []).map(normV1);
    const ticks = pinSuirc20Ticks(mappedV1);
    const meta: Suirc20Meta = {
      ...(data.meta || {}),
      tickCount: ticks.length,
      cb5Note: undefined,
      v2: undefined,
    };
    return { meta, ticks };
  }

  const res = await fetch(`${base}suirc20v2/ticks.json`);
  if (!res.ok) throw new Error('无法加载 SuiMint 新版索引 ticks.json');
  const data = await res.json();
  const mappedV2: Suirc20Tick[] = (data.ticks || []).map(normV2);
  const ticks = pinSuirc20TicksV2(mappedV2);
  const m = data.meta || {};
  const meta: Suirc20Meta = {
    progressPct: 0,
    progressLabel: m.updatedAtBeijing
      ? `新版索引更新于 ${m.updatedAtBeijing}`
      : '新版（cb5）链上注册表',
    tickCount: ticks.length,
    complete: m.complete,
    updatedAtBeijing: m.updatedAtBeijing,
    stats: m.stats,
    v2: {
      tickCount: m.tickCount ?? ticks.length,
      complete: m.complete,
      updatedAtBeijing: m.updatedAtBeijing,
      dataSource: m.dataSource,
    },
  };
  return { meta, ticks };
}

/** @deprecated Prefer loadSuirc20TicksByVersion — kept for scripts/tests. */
export async function loadSuirc20Ticks(): Promise<{ meta: Suirc20Meta; ticks: Suirc20Tick[] }> {
  return loadSuirc20TicksByVersion('v1');
}

async function fetchHolders(path: string, tick: string) {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}${path}/${encodeURIComponent(tick)}.json`);
  if (!res.ok) return null;
  return res.json();
}

export async function loadSuirc20Holders(
  tick: string,
  version: Suirc20Version | boolean = 'v1',
): Promise<{
  tick: string;
  totalHolders: number;
  holders: Suirc20Holder[];
  source?: string;
}> {
  // backward compat: preferV2 boolean
  const ver: Suirc20Version =
    version === true ? 'v2' : version === false ? 'v1' : version;
  const path = ver === 'v2' ? 'suirc20v2/holders' : 'suirc20/holders';
  const data = await fetchHolders(path, tick);
  if (data) return { ...data, source: path };
  throw new Error(`暂无 ${tick} 持有者快照（${ver === 'v2' ? '新版' : '旧版'}）`);
}

function shardOf(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').slice(0, 4);
}

export async function loadSuirc20Balances(
  address: string,
  version: Suirc20Version = 'v1',
): Promise<Record<string, string>> {
  const base = import.meta.env.BASE_URL;
  const shard = shardOf(address);
  const key = '0x' + address.toLowerCase().replace(/^0x/, '');
  const out: Record<string, string> = {};
  const path =
    version === 'v2'
      ? `suirc20v2/balances/${shard}.json`
      : `suirc20/balances/${shard}.json`;
  try {
    const res = await fetch(`${base}${path}`);
    if (res.ok) {
      const data = await res.json();
      const row = data[key] || data[address] || data[address.toLowerCase()] || {};
      for (const [tick, bal] of Object.entries(row)) {
        out[tick] = String(bal);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function buildSuirc20DeployTx(payload: Record<string, string>): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIRC20_OPERATION_PACKAGE}::Operation::deploy`,
    arguments: [tx.pure.string(JSON.stringify(payload))],
  });
  return tx;
}

/** Match historical SuiMint mint PTB: split fee from gas, pass Coin + JSON string. */
export function buildSuirc20MintTx(tick: string, amt: string, feeMist: bigint): Transaction {
  const tx = new Transaction();
  const payload = JSON.stringify({ p: 'suirc-20', op: 'mint', tick, amt });
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist > 0n ? feeMist : 0n)]);
  tx.moveCall({
    target: `${SUIRC20_OPERATION_PACKAGE}::Operation::mint`,
    arguments: [coin, tx.pure.string(payload)],
  });
  return tx;
}

export function buildSuirc20TransferTx(
  tick: string,
  amt: string,
  to: string,
): Transaction {
  const tx = new Transaction();
  const payload = JSON.stringify({ p: 'suirc-20', op: 'transfer', tick, amt, to });
  tx.moveCall({
    target: `${SUIRC20_OPERATION_PACKAGE}::Operation::transfer`,
    arguments: [tx.pure.string(payload)],
  });
  return tx;
}

/**
 * v2: suirc20::deploy(GlobalConfig, tick, lim, fee, max, dec, freq, Clock, Ctx)
 * On-chain arg order is lim/fee/max (NOT max/lim/fee) — verified via bytecode + dry-run.
 */
export function buildSuirc20V2DeployTx(opts: {
  tick: string;
  max: string;
  lim: string;
  fee: string;
  dec?: number;
  freq: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIRC20_V2_PACKAGE}::suirc20::deploy`,
    arguments: [
      tx.object(SUIRC20_V2_GLOBAL_CONFIG),
      tx.pure.string(opts.tick),
      tx.pure.u64(BigInt(opts.lim || '0')),
      tx.pure.u64(BigInt(opts.fee || '0')),
      tx.pure.u64(BigInt(opts.max || '0')),
      tx.pure.u8(opts.dec ?? 0),
      tx.pure.u64(BigInt(opts.freq || '0')),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** v2: suirc20::mint(&SUIRC20Tick, amt, Coin<SUI>, Ctx) */
export function buildSuirc20V2MintTx(tickId: string, amt: string, feeMist: bigint): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist > 0n ? feeMist : 0n)]);
  tx.moveCall({
    target: `${SUIRC20_V2_PACKAGE}::suirc20::mint`,
    arguments: [tx.object(tickId), tx.pure.u64(BigInt(amt || '0')), coin],
  });
  return tx;
}

/** v2: suirc20::transfer(tick, amt, to, Ctx) */
export function buildSuirc20V2TransferTx(tick: string, amt: string, to: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIRC20_V2_PACKAGE}::suirc20::transfer`,
    arguments: [tx.pure.string(tick), tx.pure.u64(BigInt(amt || '0')), tx.pure.address(to)],
  });
  return tx;
}

export async function dryRunSuirc20(tx: Transaction, sender: string) {
  tx.setSender(sender);
  const bytes = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  const status = res.effects?.status?.status;
  return {
    status: status === 'success' ? 'success' : 'failure',
    error: status === 'success' ? null : res.effects?.status?.error || 'dry-run failed',
    res,
  };
}

export { friendlyRpcError };
