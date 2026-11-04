import { parseJsonValue } from "./jsoncheck.ts";

/** Rules version written into every output file. */
export const RULES_VERSION = "suis-20-v1";

/** Required `p` value. `brc-20` and `suirc-20` are different protocols. */
export const PROTOCOL_ID = "suis-20";

export const MAX_PAYLOAD_BYTES = 4096;

/** Inclusive upper bound for max, lim, and amt. */
export const UINT128_MAX = (1n << 128n) - 1n;

const TICK_RE = /^[A-Za-z0-9]{4,8}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

const DEPLOY_KEYS = ["p", "op", "tick", "max", "lim"];
const MINT_KEYS = ["p", "op", "tick", "amt"];
const TRANSFER_KEYS = ["p", "op", "tick", "amt", "to"];

export interface InscriptionEvent {
  checkpoint: bigint;
  txIndex: number;
  eventIndex: number;
  digest: string;
  sender: string;
  /** UTF-8 JSON text. Invalid text is ignored, not fatal. */
  payload: string;
}

export interface TickState {
  tick: string;
  max: bigint;
  lim: bigint;
  minted: bigint;
  deployer: string;
  deployCheckpoint: bigint;
  deployTxIndex: number;
  deployEventIndex: number;
  deployDigest: string;
  balances: Map<string, bigint>;
}

export interface ReplayState {
  ticks: Map<string, TickState>;
}

export function emptyState(): ReplayState {
  return { ticks: new Map() };
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function parseUintString(value: unknown): bigint | null {
  if (typeof value !== "string" || !UINT_RE.test(value)) return null;
  if (value.length > 39) return null;
  const n = BigInt(value);
  if (n > UINT128_MAX) return null;
  return n;
}

function parsePositive(value: unknown): bigint | null {
  const n = parseUintString(value);
  if (n === null || n === 0n) return null;
  return n;
}

/** Normalize a Sui address to `0x` + 64 lowercase hex digits. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return null;
  const hex = value.slice(2).toLowerCase().padStart(64, "0");
  return `0x${hex}`;
}

function exactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(obj);
  if (got.length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  }
  return true;
}

function payloadBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Payload as UTF-8 text.
 * A string is taken as-is. A byte array is decoded.
 * `null` means the bytes are not valid UTF-8 or not a payload; the inscription is ignored.
 */
export function coercePayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!Array.isArray(payload)) return null;
  const bytes = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    const n = payload[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseCheckpoint(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string" || !UINT_RE.test(value)) return null;
  return BigInt(value);
}

function parseIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * Validate an indexer input row. Throws EnvelopeError when the row cannot be
 * ordered. A bad inscription payload is still returned and later ignored.
 */
export function readEnvelope(row: unknown): InscriptionEvent {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new EnvelopeError("event row must be an object");
  }
  const rec = row as Record<string, unknown>;
  const checkpoint = parseCheckpoint(rec.checkpoint);
  const txIndex = parseIndex(rec.tx_index);
  const eventIndex = parseIndex(rec.event_index);
  const digest = rec.digest;
  const sender = rec.sender;
  if (checkpoint === null) throw new EnvelopeError("checkpoint must be an unsigned integer");
  if (txIndex === null) throw new EnvelopeError("tx_index must be a non-negative integer");
  if (eventIndex === null) throw new EnvelopeError("event_index must be a non-negative integer");
  if (typeof digest !== "string" || digest.length < 1 || digest.length > 128) {
    throw new EnvelopeError("digest must be a non-empty string up to 128 chars");
  }
  if ([...digest].some((ch) => ch.charCodeAt(0) < 0x20)) {
    throw new EnvelopeError("digest must not contain control characters");
  }
  if (typeof sender !== "string") throw new EnvelopeError("sender must be a string");
  if (!Object.prototype.hasOwnProperty.call(rec, "payload")) {
    throw new EnvelopeError("payload is required");
  }
  // Invalid UTF-8 or a non-payload shape is ignored as an inscription, not a fatal envelope.
  const payload = coercePayload(rec.payload) ?? "";
  return { checkpoint, txIndex, eventIndex, digest, sender, payload };
}

export function eventKey(event: InscriptionEvent): string {
  return `${event.checkpoint.toString(10)}:${event.txIndex}:${event.eventIndex}`;
}

export function compareEvents(a: InscriptionEvent, b: InscriptionEvent): number {
  if (a.checkpoint < b.checkpoint) return -1;
  if (a.checkpoint > b.checkpoint) return 1;
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
  return a.eventIndex - b.eventIndex;
}

/** Sort by checkpoint, transaction index, then event sequence. Reject duplicate positions. */
export function sortEvents(events: InscriptionEvent[]): InscriptionEvent[] {
  const sorted = [...events].sort(compareEvents);
  const seen = new Set<string>();
  for (const event of sorted) {
    const key = eventKey(event);
    if (seen.has(key)) {
      throw new EnvelopeError(`duplicate event position ${key}`);
    }
    seen.add(key);
  }
  return sorted;
}

function credit(tick: TickState, address: string, amount: bigint) {
  tick.balances.set(address, (tick.balances.get(address) ?? 0n) + amount);
}

function debit(tick: TickState, address: string, amount: bigint) {
  const next = (tick.balances.get(address) ?? 0n) - amount;
  if (next === 0n) tick.balances.delete(address);
  else tick.balances.set(address, next);
}

/**
 * Apply one event. Invalid, over-limit, and insufficient inscriptions are
 * ignored as a whole: amounts are never clamped. Other events are untouched.
 */
export function applyEvent(state: ReplayState, event: InscriptionEvent): void {
  if (payloadBytes(event.payload) > MAX_PAYLOAD_BYTES) return;
  const sender = normalizeAddress(event.sender);
  if (!sender) return;
  const parsed = parseJsonValue(event.payload);
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const body = parsed as Record<string, unknown>;
  if (body.p !== PROTOCOL_ID) return;
  if (body.op !== "deploy" && body.op !== "mint" && body.op !== "transfer") return;
  if (typeof body.tick !== "string" || !TICK_RE.test(body.tick)) return;
  const tickName = body.tick;

  if (body.op === "deploy") {
    if (!exactKeys(body, DEPLOY_KEYS)) return;
    const max = parsePositive(body.max);
    const lim = parsePositive(body.lim);
    if (max === null || lim === null) return;
    if (state.ticks.has(tickName)) return;
    state.ticks.set(tickName, {
      tick: tickName,
      max,
      lim,
      minted: 0n,
      deployer: sender,
      deployCheckpoint: event.checkpoint,
      deployTxIndex: event.txIndex,
      deployEventIndex: event.eventIndex,
      deployDigest: event.digest,
      balances: new Map(),
    });
    return;
  }

  if (body.op === "mint") {
    if (!exactKeys(body, MINT_KEYS)) return;
    const amt = parsePositive(body.amt);
    if (amt === null) return;
    const tick = state.ticks.get(tickName);
    if (!tick) return;
    if (amt > tick.lim) return;
    if (tick.minted + amt > tick.max) return;
    tick.minted += amt;
    credit(tick, sender, amt);
    return;
  }

  if (!exactKeys(body, TRANSFER_KEYS)) return;
  const amt = parsePositive(body.amt);
  const to = normalizeAddress(body.to);
  if (amt === null || to === null) return;
  const tick = state.ticks.get(tickName);
  if (!tick) return;
  const balance = tick.balances.get(sender) ?? 0n;
  if (balance < amt) return;
  if (sender === to) return;
  debit(tick, sender, amt);
  credit(tick, to, amt);
}

export function replayEvents(events: InscriptionEvent[]): ReplayState {
  const state = emptyState();
  for (const event of sortEvents(events)) applyEvent(state, event);
  return state;
}