import { coercePayload, normalizeAddress, sortEvents, type InscriptionEvent } from "./protocol.ts";

export interface ScanOptions {
  rpcUrl: string;
  packageId: string;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

interface RpcEvent {
  id?: { txDigest?: string; eventSeq?: string };
  sender?: string;
  checkpoint?: string | number | null;
  parsedJson?: { sender?: unknown; payload?: unknown };
  type?: string;
}

interface QueryPage {
  data?: RpcEvent[];
  nextCursor?: { txDigest: string; eventSeq: string } | null;
  hasNextPage?: boolean;
}

interface Checkpoint {
  transactions?: string[];
}

async function rpcCall(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}`);
  }
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new Error(body.error.message || `RPC ${method} failed`);
  }
  return body.result;
}

function eventType(packageId: string): string {
  const id = normalizeAddress(packageId);
  if (!id) throw new Error(`invalid package id ${packageId}`);
  return `${id}::inscription::InscriptionEvent`;
}

/**
 * Read InscriptionEvents in chain order.
 * Ordering keys come from the checkpoint transaction list and `eventSeq`,
 * not from anything the caller can put in the JSON payload.
 * Events without a checkpoint are skipped until they are checkpointed.
 */
export async function scanInscriptions(options: ScanOptions): Promise<InscriptionEvent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageSize = options.pageSize ?? 50;
  const type = eventType(options.packageId);
  const raw: RpcEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  let pages = 0;
  for (;;) {
    if (options.maxPages !== undefined && pages >= options.maxPages) break;
    const page = (await rpcCall(fetchImpl, options.rpcUrl, "suix_queryEvents", [
      { MoveEventType: type },
      cursor,
      pageSize,
      false,
    ])) as QueryPage;
    pages++;
    for (const event of page.data ?? []) raw.push(event);
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const byCheckpoint = new Map<string, RpcEvent[]>();
  for (const event of raw) {
    if (event.checkpoint === null || event.checkpoint === undefined || event.checkpoint === "") {
      continue;
    }
    const cp = String(event.checkpoint);
    const list = byCheckpoint.get(cp);
    if (list) list.push(event);
    else byCheckpoint.set(cp, [event]);
  }

  const txIndexByCheckpoint = new Map<string, Map<string, number>>();
  for (const cp of byCheckpoint.keys()) {
    const checkpoint = (await rpcCall(fetchImpl, options.rpcUrl, "sui_getCheckpoint", [cp])) as Checkpoint;
    const index = new Map<string, number>();
    (checkpoint.transactions ?? []).forEach((digest, i) => index.set(digest, i));
    txIndexByCheckpoint.set(cp, index);
  }

  const events: InscriptionEvent[] = [];
  for (const [cp, list] of byCheckpoint) {
    const txIndex = txIndexByCheckpoint.get(cp)!;
    for (const event of list) {
      const digest = event.id?.txDigest;
      const seq = event.id?.eventSeq;
      if (!digest || seq === undefined) {
        throw new Error(`event in checkpoint ${cp} is missing id`);
      }
      const position = txIndex.get(digest);
      if (position === undefined) {
        throw new Error(`digest ${digest} not in checkpoint ${cp}`);
      }
      const eventIndex = Number(seq);
      if (!Number.isSafeInteger(eventIndex) || eventIndex < 0) {
        throw new Error(`bad eventSeq ${seq} in ${digest}`);
      }
      const outer = typeof event.sender === "string" ? normalizeAddress(event.sender) : null;
      const inner =
        event.parsedJson && "sender" in event.parsedJson
          ? normalizeAddress(event.parsedJson.sender)
          : null;
      if (!outer) continue;
      if (inner && inner !== outer) continue;
      const payload = coercePayload(event.parsedJson?.payload);
      if (payload === null) continue;
      events.push({
        checkpoint: BigInt(cp),
        txIndex: position,
        eventIndex,
        digest,
        sender: outer,
        payload,
      });
    }
  }
  return sortEvents(events);
}