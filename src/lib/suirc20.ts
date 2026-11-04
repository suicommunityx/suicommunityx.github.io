import { Transaction } from '@mysten/sui/transactions';
import { client, friendlyRpcError } from './rpc';

/** SuiMint Operation package (JSON witness). */
export const SUIRC20_OPERATION_PACKAGE =
  '0xe09b37505173ae119a0ae3b1fdf9050a6b029391f9d9f10a3fff27e3f3115727';

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
  /** Deploy timestamp (ms) when the index includes one. */
  createdTs?: number | string | null;
};

export type Suirc20Meta = {
  tickCount: number;
  complete?: boolean;
  updatedAtBeijing?: string;
  /** Chain timestamp the indexer has scanned through (ISO), when present. */
  scannedTo?: string;
  stats?: Record<string, unknown>;
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

function normTick(t: any): Suirc20Tick {
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
    createdTs: t.createdTs ?? null,
  };
}

/** Load the Operation witness index only. */
export async function loadSuirc20Ticks(): Promise<{ meta: Suirc20Meta; ticks: Suirc20Tick[] }> {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}suirc20/ticks.json`);
  if (!res.ok) throw new Error('无法加载 SuiMint 索引 ticks.json');
  const data = await res.json();
  const mapped: Suirc20Tick[] = (data.ticks || []).map(normTick);
  const ticks = pinSuirc20Ticks(mapped);
  const m = data.meta || {};
  const lastTs = m.stats?.lastTs;
  const meta: Suirc20Meta = {
    tickCount: ticks.length,
    complete: m.complete,
    updatedAtBeijing: m.updatedAtBeijing,
    scannedTo: typeof lastTs === 'string' && lastTs ? lastTs : undefined,
    stats: m.stats,
  };
  return { meta, ticks };
}

async function fetchHolders(tick: string) {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}suirc20/holders/${encodeURIComponent(tick)}.json`);
  if (!res.ok) return null;
  try {
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

export async function loadSuirc20Holders(tick: string): Promise<{
  tick: string;
  totalHolders: number;
  holders: Suirc20Holder[];
  source?: string;
}> {
  const data = await fetchHolders(tick);
  if (data) return { ...data, source: 'suirc20/holders' };
  throw new Error(`暂无 ${tick} 持有者快照`);
}

function shardOf(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').slice(0, 4);
}

export async function loadSuirc20Balances(address: string): Promise<Record<string, string>> {
  const base = import.meta.env.BASE_URL;
  const shard = shardOf(address);
  const key = '0x' + address.toLowerCase().replace(/^0x/, '');
  const out: Record<string, string> = {};
  try {
    const res = await fetch(`${base}suirc20/balances/${shard}.json`);
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
