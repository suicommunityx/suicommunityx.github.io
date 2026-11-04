import { Transaction } from '@mysten/sui/transactions';
import {
  CALL_PACKAGE,
  CACHE_TTL_MS,
  CLOCK,
  DEPLOY_RECORD,
  DEPLOY_TABLE,
  KNOWN_MARKETS,
  MARKET_CALL_PACKAGE,
  MARKET_TYPE_PACKAGE,
  MARKETPLACE_HOUSE,
  MOVESCRIPTION_TYPE,
  TYPE_PACKAGE,
} from './constants';
import { readInscriptionName, readMoveString } from './inscriptionName';
import {
  cacheGet,
  cacheSet,
  client,
  friendlyRpcError,
  serializeBig,
  withRetry,
} from './rpc';

export { client, friendlyRpcError };

export const TICK_RECORD_V2 =
  '0x1daf3c01d08c3068cee9419a8f3f542382d5adf72f4fb31fe1bd32c7187981a0';

export type TickInfo = {
  tick: string;
  recordId: string;
  isV2: boolean;
  totalSupply: bigint;
  currentSupply: bigint;
  remain: bigint;
  mintFee: bigint | null;
  startTimeMs: bigint | null;
  mintFactory: string | null;
  totalTx: bigint | null;
  marketId: string | null;
  deployer?: string | null;
};

/** Movescriptions: SUIS pinned #1 only; others by creation time oldest→newest. */
export function pinTickOrder(
  a: string,
  b: string,
  aTime?: bigint | number | null,
  bTime?: bigint | number | null,
): number {
  const rank = (t: string) => (t === 'SUIS' ? 0 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const ta = aTime == null ? Number.POSITIVE_INFINITY : Number(aTime);
  const tb = bTime == null ? Number.POSITIVE_INFINITY : Number(bTime);
  if (ta !== tb) return ta - tb;
  return a.localeCompare(b);
}

export function pinTicksFirst<T extends { tick: string; startTimeMs?: bigint | number | null }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) =>
    pinTickOrder(a.tick, b.tick, a.startTimeMs ?? null, b.startTimeMs ?? null),
  ) as T[];
}

const START_TIME_CACHE = 'moves:tick-start-times:v1';

/** Fill missing startTimeMs from TickRecord start_time_ms or object previousTransaction time. Cached. */
export async function enrichTickStartTimes(ticks: TickInfo[]): Promise<TickInfo[]> {
  const cached = cacheGet<Record<string, string>>(START_TIME_CACHE, 7 * 24 * 60 * 60 * 1000) || {};
  const out = ticks.map((t) => {
    if (t.startTimeMs != null) return t;
    const c = cached[t.recordId];
    return c ? { ...t, startTimeMs: BigInt(c) } : t;
  });
  const still = out.filter((t) => t.startTimeMs == null && t.recordId);
  if (!still.length) return pinTicksFirst(out);

  const GQL = 'https://graphql.mainnet.sui.io/graphql';
  const map = { ...cached };
  for (let i = 0; i < still.length; i += 10) {
    const slice = still.slice(i, i + 10);
    await Promise.all(
      slice.map(async (t) => {
        try {
          // Prefer on-chain start_time_ms via RPC batch path already used elsewhere
          const obj = await withRetry((c) =>
            c.getObject({ id: t.recordId, options: { showContent: true } }),
          );
          const f = fieldsOf(obj.data);
          if (f.start_time_ms != null) {
            map[t.recordId] = String(f.start_time_ms);
            return;
          }
          const q = `query($id:SuiAddress!){ object(address:$id){ previousTransaction { effects { timestamp } } } }`;
          const res = await fetch(GQL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: q, variables: { id: t.recordId } }),
          });
          const j = await res.json();
          const ts = j?.data?.object?.previousTransaction?.effects?.timestamp;
          if (ts) map[t.recordId] = String(Date.parse(ts));
        } catch {
          /* ignore one tick */
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
  }
  cacheSet(START_TIME_CACHE, map);
  return pinTicksFirst(
    out.map((t) =>
      t.startTimeMs != null
        ? t
        : map[t.recordId]
          ? { ...t, startTimeMs: BigInt(map[t.recordId]) }
          : t,
    ),
  );
}

export type MovescriptionHolding = {
  objectId: string;
  /** Protocol tick (`MOVE`, `TICK`, …). Case-sensitive. TICK/NAME objects do not store the inscribed string here. */
  tick: string;
  /**
   * Human-readable string from metadata (e.g. a TICK name such as `SUIFRENS`, or a NAME such as `berich`).
   * Null when the object has no text metadata — use `tick` for ordinary inscriptions.
   */
  inscriptionName: string | null;
  amount: bigint;
  acc: bigint;
  version: string;
};

export type MarketListing = {
  objectId: string;
  amount: bigint;
  unitPrice: bigint;
  totalPrice: bigint;
  seller: string;
  acc: bigint;
};

function fieldsOf(obj: any): any {
  return obj?.content?.fields ?? obj?.data?.content?.fields ?? {};
}

export async function loadAllTicks(opts?: { deep?: boolean }): Promise<TickInfo[]> {
  const cacheKey = 'suirc20:ticks:v1';
  if (!opts?.deep) {
    const cached = cacheGet<any[]>(cacheKey, CACHE_TTL_MS);
    if (cached?.length) {
      return cached.map((x) => ({
        ...x,
        totalSupply: BigInt(x.totalSupply),
        currentSupply: BigInt(x.currentSupply),
        remain: BigInt(x.remain),
        mintFee: x.mintFee == null ? null : BigInt(x.mintFee),
        startTimeMs: x.startTimeMs == null ? null : BigInt(x.startTimeMs),
        totalTx: x.totalTx == null ? null : BigInt(x.totalTx),
      }));
    }
  }

  const entries: { tick: string; dfId: string }[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await withRetry((c) =>
      c.getDynamicFields({
        parentId: DEPLOY_TABLE,
        cursor: cursor ?? null,
        limit: 50,
      }),
    );
    for (const df of page.data) {
      const name = (df.name as any)?.value as string;
      if (name) entries.push({ tick: name, dfId: df.objectId });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
    await new Promise((r) => setTimeout(r, 80));
  } while (cursor);

  const resolved: { tick: string; recordId: string }[] = [];
  for (let i = 0; i < entries.length; i += 25) {
    const slice = entries.slice(i, i + 25);
    const objs = await withRetry((c) =>
      c.multiGetObjects({
        ids: slice.map((s) => s.dfId),
        options: { showContent: true },
      }),
    );
    objs.forEach((o, idx) => {
      const recordId = fieldsOf(o.data)?.value as string;
      if (recordId) resolved.push({ tick: slice[idx].tick, recordId });
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  // Prefer seeded markets; optional house crawl only in deep mode
  const markets = opts?.deep ? await loadMarketIndex() : { ...KNOWN_MARKETS };
  const results: TickInfo[] = [];
  // Batch record objects
  for (let i = 0; i < resolved.length; i += 20) {
    const slice = resolved.slice(i, i + 20);
    const objs = await withRetry((c) =>
      c.multiGetObjects({
        ids: slice.map((s) => s.recordId),
        options: { showContent: true, showType: true },
      }),
    );
    objs.forEach((obj, idx) => {
      const e = slice[idx];
      results.push(parseTickDetail(e.tick, e.recordId, obj, markets));
    });
    await new Promise((r) => setTimeout(r, 200));
  }
  results.sort((a, b) => pinTickOrder(a.tick, b.tick, a.startTimeMs, b.startTimeMs));
  cacheSet(cacheKey, serializeBig(results));
  return results;
}

async function loadMarketIndex(): Promise<Record<string, string>> {
  const map: Record<string, string> = { ...KNOWN_MARKETS };
  try {
    const house = await withRetry((c) =>
      c.getObject({
        id: MARKETPLACE_HOUSE,
        options: { showContent: true },
      }),
    );
    const infoTable = fieldsOf(house.data)?.market_info?.fields?.id?.id as string | undefined;
    if (!infoTable) return map;
    let cursor: string | null | undefined = null;
    do {
      const page = await withRetry((c) =>
        c.getDynamicFields({
          parentId: infoTable,
          cursor: cursor ?? null,
          limit: 50,
        }),
      );
      const dfIds = page.data.map((df) => df.objectId);
      const dfObjs = dfIds.length
        ? await withRetry((c) => c.multiGetObjects({ ids: dfIds, options: { showContent: true } }))
        : [];
      page.data.forEach((df, i) => {
        const tick = (df.name as any)?.value as string;
        const marketId = fieldsOf(dfObjs[i]?.data)?.value as string;
        if (tick && marketId) map[tick.toUpperCase()] = marketId;
      });
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
  } catch {
    /* keep known */
  }
  return map;
}

function parseTickDetail(
  tick: string,
  recordId: string,
  obj: any,
  markets: Record<string, string>,
): TickInfo {
  const typ = obj?.data?.type || '';
  const f = fieldsOf(obj?.data);
  const isV2 = typ.includes('TickRecordV2');
  let totalSupply = BigInt(f.total_supply || 0);
  let currentSupply = 0n;
  let remain = 0n;
  let totalTx: bigint | null = null;
  let mintFee: bigint | null = f.mint_fee != null ? BigInt(f.mint_fee) : null;
  let startTimeMs: bigint | null = f.start_time_ms != null ? BigInt(f.start_time_ms) : null;
  let mintFactory: string | null = f.mint_factory ?? null;

  if (isV2) {
    const stat = f.stat?.fields || f.stat || {};
    currentSupply = BigInt(stat.current_supply || 0);
    remain = BigInt(stat.remain || 0);
    totalTx = BigInt(stat.total_transactions || 0);
  } else {
    currentSupply = BigInt(f.current_supply || 0);
    remain = BigInt(f.remain || 0);
    totalTx = f.total_transactions != null ? BigInt(f.total_transactions) : null;
  }

  return {
    tick,
    recordId,
    isV2,
    totalSupply,
    currentSupply,
    remain,
    mintFee,
    startTimeMs,
    mintFactory,
    totalTx,
    marketId: markets[tick.toUpperCase()] || null,
  };
}

export async function loadOwnedMovescriptions(owner: string): Promise<MovescriptionHolding[]> {
  const out: MovescriptionHolding[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await withRetry((c) =>
      c.getOwnedObjects({
        owner,
        cursor: cursor ?? null,
        limit: 50,
        filter: { StructType: MOVESCRIPTION_TYPE },
        options: { showContent: true },
      }),
    );
    for (const row of page.data) {
      const f = fieldsOf(row.data);
      const accRaw = f.acc;
      const acc =
        typeof accRaw === 'object'
          ? BigInt(accRaw?.fields?.balance ?? accRaw?.fields?.value ?? 0)
          : BigInt(accRaw || 0);
      out.push({
        objectId: row.data!.objectId,
        tick: readMoveString(f.tick),
        inscriptionName: readInscriptionName(f.metadata),
        amount: BigInt(f.amount || 0),
        acc,
        version: String(row.data!.version),
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return out;
}

export async function loadFloorListings(
  marketId: string,
  from = 0,
  limit = 30,
  opts?: { bypassCache?: boolean },
): Promise<MarketListing[]> {
  const cacheKey = `suirc20:floor:${marketId}:${from}:${limit}`;
  if (!opts?.bypassCache) {
    const cached = cacheGet<any[]>(cacheKey, CACHE_TTL_MS);
    if (cached) {
      return cached.map((x) => ({
        objectId: x.objectId,
        amount: BigInt(x.amount),
        unitPrice: BigInt(x.unitPrice),
        totalPrice: BigInt(x.totalPrice),
        seller: x.seller,
        acc: BigInt(x.acc || 0),
      }));
    }
  }

  const list = await withRetry(async (c) => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${MARKET_CALL_PACKAGE}::market::floor_listing`,
      arguments: [tx.object(marketId), tx.pure.u64(from), tx.pure.u64(limit)],
    });
    const r = await c.devInspectTransactionBlock({
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
      transactionBlock: tx,
    });
    const ev = r.events?.find((e) => e.type.includes('FloorPriceEvent'))?.parsedJson as any;
    if (!ev?.object_id) return [] as MarketListing[];
    const out: MarketListing[] = [];
    for (let i = 0; i < ev.object_id.length; i++) {
      out.push({
        objectId: ev.object_id[i],
        amount: BigInt(ev.amt[i]),
        unitPrice: BigInt(ev.unit_price[i]),
        totalPrice: BigInt(ev.price[i]),
        seller: ev.seller[i],
        acc: BigInt(ev.acc[i] || 0),
      });
    }
    return out;
  });

  cacheSet(cacheKey, serializeBig(list));
  return list;
}

export function buildDeployTx(params: {
  tickNameObjectId: string;
  totalSupply: bigint;
  initLockedSui: bigint;
  startTimeMs: bigint;
  epochCount: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CALL_PACKAGE}::epoch_bus_factory::deploy`,
    arguments: [
      tx.object(DEPLOY_RECORD),
      tx.object(TICK_RECORD_V2),
      tx.object(params.tickNameObjectId),
      tx.pure.u64(params.totalSupply),
      tx.pure.u64(params.initLockedSui),
      tx.pure.u64(params.startTimeMs),
      tx.pure.u64(params.epochCount),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildMintTickNameTx(params: {
  moveObjectId: string;
  tickName: string;
}): Transaction {
  const tx = new Transaction();
  const bytes = Array.from(new TextEncoder().encode(params.tickName.toUpperCase()));
  tx.moveCall({
    target: `${CALL_PACKAGE}::tick_factory::mint`,
    arguments: [
      tx.object(TICK_RECORD_V2),
      tx.object(params.moveObjectId),
      tx.pure.vector('u8', bytes),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildMintTx(params: {
  recordId: string;
  isV2: boolean;
  mintFactory: string | null;
  lockedSuiMist: bigint;
}): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.lockedSuiMist)]);
  if (params.isV2) {
    const factory = (params.mintFactory || '').toLowerCase();
    let module = 'epoch_bus_factory';
    if (factory.includes('mint_get')) module = 'mint_get_factory';
    else if (factory.includes('mint_ratio')) module = 'mint_ratio_50_factory';
    else if (factory.includes('tick_factory')) module = 'tick_factory';

    if (module === 'mint_get_factory') {
      tx.moveCall({
        target: `${CALL_PACKAGE}::mint_get_factory::mint`,
        arguments: [tx.object(params.recordId)],
      });
    } else if (module === 'mint_ratio_50_factory') {
      tx.moveCall({
        target: `${CALL_PACKAGE}::mint_ratio_50_factory::mint_v2`,
        arguments: [tx.object(params.recordId), coin, tx.object(CLOCK)],
      });
    } else {
      tx.moveCall({
        target: `${CALL_PACKAGE}::epoch_bus_factory::mint`,
        arguments: [tx.object(params.recordId), coin, tx.object(CLOCK)],
      });
    }
  } else {
    tx.moveCall({
      target: `${CALL_PACKAGE}::movescription::mint`,
      arguments: [
        tx.object(params.recordId),
        tx.pure.vector('u8', []),
        coin,
        tx.object(CLOCK),
      ],
    });
  }
  return tx;
}

export function buildTransferTx(objectId: string, recipient: string): Transaction {
  const tx = new Transaction();
  tx.transferObjects([tx.object(objectId)], recipient);
  return tx;
}

/** Split amount off a Movescription via movescription::do_split, then transfer the piece. */
export function buildSplitTransferTx(
  objectId: string,
  amount: bigint,
  recipient: string,
): Transaction {
  const tx = new Transaction();
  const piece = tx.moveCall({
    target: `${CALL_PACKAGE}::movescription::do_split`,
    arguments: [tx.object(objectId), tx.pure.u64(amount)],
  });
  tx.transferObjects([piece], recipient);
  return tx;
}

export function buildListTx(marketId: string, objectId: string, unitPriceMist: bigint): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${MARKET_CALL_PACKAGE}::market::list`,
    arguments: [tx.object(marketId), tx.object(objectId), tx.pure.u64(unitPriceMist)],
  });
  return tx;
}

export function buildDelistTx(
  marketId: string,
  objectId: string,
  unitPriceMist: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${MARKET_CALL_PACKAGE}::market::delist`,
    arguments: [tx.object(marketId), tx.pure.id(objectId), tx.pure.u64(unitPriceMist)],
  });
  return tx;
}

export function buildBuyTxTo(params: {
  marketId: string;
  objectId: string;
  unitPriceMist: bigint;
  totalPriceMist: bigint;
  buyer: string;
}): Transaction {
  const tx = new Transaction();
  const [paid] = tx.splitCoins(tx.gas, [tx.pure.u64(params.totalPriceMist)]);
  const inscription = tx.moveCall({
    target: `${MARKET_CALL_PACKAGE}::market::buy`,
    arguments: [
      tx.object(params.marketId),
      tx.pure.id(params.objectId),
      paid,
      tx.pure.u64(params.unitPriceMist),
      tx.object(CLOCK),
    ],
  });
  tx.transferObjects([inscription, paid], params.buyer);
  return tx;
}

export async function dryRun(tx: Transaction, sender: string) {
  return withRetry(async (c) => {
    tx.setSender(sender);
    const bytes = await tx.build({ client: c });
    const r = await c.dryRunTransactionBlock({ transactionBlock: bytes });
    return {
      status: r.effects?.status?.status,
      error: r.effects?.status?.error,
      gasUsed: r.effects?.gasUsed,
      effects: r.effects,
    };
  });
}

export { TYPE_PACKAGE, CALL_PACKAGE, MARKET_CALL_PACKAGE, MARKET_TYPE_PACKAGE, MOVESCRIPTION_TYPE };
