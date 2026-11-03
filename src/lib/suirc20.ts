import { Transaction } from '@mysten/sui/transactions';
import { client, friendlyRpcError } from './rpc';

/** Original SuiMint Operation package (JSON witness). */
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
  digest: string;
  minted: string;
  mintCount: number;
  holderCount: number;
  progress: number;
};

export type Suirc20Meta = {
  progressPct: number;
  progressLabel: string;
  tickCount: number;
  complete?: boolean;
  updatedAtBeijing?: string;
  stats?: Record<string, unknown>;
  cb5Note?: string;
};

export type Suirc20Holder = { owner: string; balance: string };

export function pinSuirc20Ticks<T extends { tick: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = SUIRC20_PIN.indexOf(a.tick as (typeof SUIRC20_PIN)[number]);
    const rb = SUIRC20_PIN.indexOf(b.tick as (typeof SUIRC20_PIN)[number]);
    const aa = ra === -1 ? 99 : ra;
    const bb = rb === -1 ? 99 : rb;
    if (aa !== bb) return aa - bb;
    return a.tick.localeCompare(b.tick);
  });
}

export async function loadSuirc20Ticks(): Promise<{ meta: Suirc20Meta; ticks: Suirc20Tick[] }> {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}suirc20/ticks.json`);
  if (!res.ok) throw new Error('无法加载 SuiMint 索引 ticks.json');
  const data = await res.json();
  return {
    meta: data.meta,
    ticks: pinSuirc20Ticks(data.ticks || []),
  };
}

export async function loadSuirc20Holders(tick: string): Promise<{
  tick: string;
  totalHolders: number;
  holders: Suirc20Holder[];
}> {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}suirc20/holders/${encodeURIComponent(tick)}.json`);
  if (!res.ok) throw new Error(`暂无 ${tick} 持有者快照`);
  return res.json();
}

function shardOf(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').slice(0, 4);
}

export async function loadSuirc20Balances(
  address: string,
): Promise<Record<string, string>> {
  const base = import.meta.env.BASE_URL;
  const shard = shardOf(address);
  const res = await fetch(`${base}suirc20/balances/${shard}.json`);
  if (!res.ok) return {};
  const data = await res.json();
  const key = '0x' + address.toLowerCase().replace(/^0x/, '');
  // try exact and lowercase variants
  return data[key] || data[address] || data[address.toLowerCase()] || {};
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
  if (feeMist > 0n) {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist)]);
    tx.moveCall({
      target: `${SUIRC20_OPERATION_PACKAGE}::Operation::mint`,
      arguments: [coin, tx.pure.string(payload)],
    });
  } else {
    // fee 0: still pass a zero-value coin (historical txs used split of 0)
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
    tx.moveCall({
      target: `${SUIRC20_OPERATION_PACKAGE}::Operation::mint`,
      arguments: [coin, tx.pure.string(payload)],
    });
  }
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
