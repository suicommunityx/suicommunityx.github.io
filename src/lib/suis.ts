import { Transaction } from '@mysten/sui/transactions';

/**
 * Mainnet package id for `suis::inscription`.
 * Empty until a package is published. Do not put the SuiMint Operation
 * package here — those events are a different protocol.
 */
export const SUIS_PACKAGE_ID: string = '';

export const SUIS_RULES = 'suis-20-v1';
export const SUIS_PROTOCOL = 'suis-20';

const TICK_RE = /^[A-Za-z0-9]{4,8}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const UINT128_MAX = (1n << 128n) - 1n;

export type SuisTick = {
  tick: string;
  max: string;
  lim: string;
  minted: string;
  holderCount: string;
  deployer: string;
  deployCheckpoint: string;
  deployDigest: string;
};

export type SuisHolder = { owner: string; balance: string };

export type SuisIndex = {
  rules: string;
  ticks: SuisTick[];
};

type TickFile = {
  rules?: string;
  ticks?: Record<string, Record<string, unknown>>;
};

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/** Same address rule as PROTOCOL.md: `0x` + 64 lowercase hex. */
export function normalizeSuiAddress(value: string): string | null {
  const v = value.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
  return `0x${v.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function isSuisTick(value: string): boolean {
  return TICK_RE.test(value);
}

export function isPositiveUint(value: string): boolean {
  if (!UINT_RE.test(value) || value === '0' || value.length > 39) return false;
  try {
    return BigInt(value) <= UINT128_MAX;
  } catch {
    return false;
  }
}

export function suisLocation(
  sub: 'list' | 'holders' | 'mine' | 'inscribe',
  tick?: string | null,
): string {
  if (sub === 'holders') {
    return tick ? `#/suis/holders/${encodeURIComponent(tick)}` : '#/suis/holders';
  }
  if (sub === 'mine') return '#/suis/mine';
  if (sub === 'inscribe') return '#/suis/inscribe';
  return '#/ticks';
}

export function readSuisLocation(): { sub: 'list' | 'holders' | 'mine' | 'inscribe'; tick: string | null } {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/');
  if (parts[0] === 'ticks' || parts[0] === 'suis') {
    if (parts[0] === 'ticks' || !parts[1] || parts[1] === 'ticks') {
      return { sub: 'list', tick: null };
    }
  } else {
    return { sub: 'list', tick: null };
  }
  if (parts[1] === 'holders') {
    return { sub: 'holders', tick: parts[2] ? decodeURIComponent(parts[2]) : null };
  }
  if (parts[1] === 'mine' || parts[1] === 'inscribe') return { sub: parts[1], tick: null };
  return { sub: 'list', tick: null };
}

export async function loadSuisIndex(): Promise<SuisIndex> {
  const res = await fetch(`${import.meta.env.BASE_URL}suis/ticks.json`);
  if (!res.ok) throw new Error('无法加载 suis 索引 ticks.json');
  const data = (await res.json()) as TickFile;
  const map = data.ticks && typeof data.ticks === 'object' ? data.ticks : {};
  const ticks = Object.keys(map).map((name) => {
    const row = map[name] || {};
    return {
      tick: asString(row.tick, name),
      max: asString(row.max, '0'),
      lim: asString(row.lim, '0'),
      minted: asString(row.minted, '0'),
      holderCount: asString(row.holder_count, '0'),
      deployer: asString(row.deployer),
      deployCheckpoint: asString(row.deploy_checkpoint, '0'),
      deployDigest: asString(row.deploy_digest),
    };
  });
  return { rules: asString(data.rules, SUIS_RULES), ticks };
}

export async function loadSuisHolders(tick: string): Promise<{
  tick: string;
  minted: string;
  holders: SuisHolder[];
}> {
  const res = await fetch(`${import.meta.env.BASE_URL}suis/holders/${encodeURIComponent(tick)}.json`);
  if (!res.ok) throw new Error(`暂无 ${tick} 持有者快照`);
  const data = (await res.json()) as {
    tick?: string;
    minted?: string;
    holders?: Record<string, string>;
  };
  const holders = Object.entries(data.holders || {}).map(([owner, balance]) => ({
    owner,
    balance: String(balance),
  }));
  return {
    tick: data.tick || tick,
    minted: String(data.minted ?? '0'),
    holders,
  };
}

export async function loadSuisBalances(address: string): Promise<{ tick: string; balance: string }[]> {
  const me = normalizeSuiAddress(address);
  if (!me) return [];
  const { ticks } = await loadSuisIndex();
  const rows = await Promise.all(
    ticks.map(async (tick) => {
      try {
        const file = await loadSuisHolders(tick.tick);
        const hit = file.holders.find((holder) => holder.owner === me);
        if (!hit || hit.balance === '0') return null;
        return { tick: tick.tick, balance: hit.balance };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is { tick: string; balance: string } => row !== null);
}

export function suisDeployJson(tick: string, max: string, lim: string): string {
  return JSON.stringify({ p: SUIS_PROTOCOL, op: 'deploy', tick, max, lim });
}

export function suisMintJson(tick: string, amt: string): string {
  return JSON.stringify({ p: SUIS_PROTOCOL, op: 'mint', tick, amt });
}

export function suisTransferJson(tick: string, amt: string, to: string): string {
  return JSON.stringify({ p: SUIS_PROTOCOL, op: 'transfer', tick, amt, to });
}

/** Build a PTB that only emits InscriptionEvent. No balance object is touched. */
export function buildSuisInscribeTx(payload: string): Transaction {
  if (!SUIS_PACKAGE_ID) {
    throw new Error('SUIS_PACKAGE_ID is empty');
  }
  const tx = new Transaction();
  const bytes = Array.from(new TextEncoder().encode(payload));
  tx.moveCall({
    target: `${SUIS_PACKAGE_ID}::inscription::inscribe`,
    arguments: [tx.pure.vector('u8', bytes)],
  });
  return tx;
}