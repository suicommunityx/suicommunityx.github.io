import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { RPC_FALLBACKS, RPC_URL, NETWORK } from './constants';

function explainMoveAbort(msg: string): string | null {
  const abortMatch = msg.match(/abort code:\s*(\d+)/i) || msg.match(/MoveAbort[^0-9]*(\d+)/i);
  if (!abortMatch) return null;
  const code = abortMatch[1];
  const fnMatch = msg.match(/::(\w+)::(\w+)/);
  const fn = fnMatch?.[2] || '';

  let head = `交易模拟失败：合约拒绝（abort code ${code}）`;
  if (fn === 'deploy' || /::deploy'/i.test(msg)) {
    head = `部署失败：合约拒绝（abort code ${code}）`;
  } else if (fn === 'mint' || /::mint'/i.test(msg)) {
    head = `铸造失败：合约拒绝（abort code ${code}）`;
  } else if (fn === 'transfer' || /::transfer'/i.test(msg)) {
    head = `转账失败：合约拒绝（abort code ${code}）`;
  }

  const detail = msg.replace(/^Transaction resolution failed:\s*/i, '').trim();
  const truncated = detail.length > 180 ? `${detail.slice(0, 180)}…` : detail;
  return `${head}\n${truncated}`;
}

export function friendlyRpcError(err: unknown): string {
  const msg = String((err as any)?.message || err || '');
  if (/429|rate|too many/i.test(msg)) {
    return '节点繁忙（请求过于频繁），请稍后再试。可点击重试。';
  }
  if (/503|502|504|timeout|network|failed to fetch|FetchError/i.test(msg)) {
    return '网络或节点暂时不可用，请稍后重试。';
  }
  if (/Method not found|deprecated/i.test(msg)) {
    return '当前节点不支持该 JSON-RPC 方法，正在切换备用节点…若仍失败请刷新页面。';
  }

  const moveHint = explainMoveAbort(msg);
  if (moveHint) return moveHint;

  // strip noisy prefixes
  const cleaned = msg.replace(/^Unexpected status code:\s*/i, '节点返回错误：');
  if (cleaned.length > 220) return cleaned.slice(0, 220) + '…';
  return cleaned || '读取链上数据失败，请重试。';
}

function isRateLimited(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /429|rate|too many/i.test(msg);
}

let endpointIndex = 0;
const endpoints = Array.from(new Set([RPC_URL, ...RPC_FALLBACKS].filter(Boolean)));

export function currentRpcUrl(): string {
  return endpoints[endpointIndex % endpoints.length];
}

export function rotateRpc(): string {
  endpointIndex = (endpointIndex + 1) % endpoints.length;
  return currentRpcUrl();
}

export function makeClient(url = currentRpcUrl()): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url, network: NETWORK });
}

/** Shared mutable client; rotated on sustained 429s. */
export let client = makeClient();

export function resetClient(url?: string): SuiJsonRpcClient {
  if (url) {
    const i = endpoints.indexOf(url);
    if (i >= 0) endpointIndex = i;
  }
  client = makeClient(currentRpcUrl());
  return client;
}

export async function withRetry<T>(
  fn: (c: SuiJsonRpcClient) => Promise<T>,
  tries = 6,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(client);
    } catch (e) {
      last = e;
      const rate = isRateLimited(e);
      const transient = rate || /503|502|504|timeout|network|fetch/i.test(String((e as any)?.message || e));
      if (!transient && i >= 1) break;
      // rotate endpoint on rate limit when alternatives exist
      if (rate && endpoints.length > 1) {
        rotateRpc();
        resetClient();
      }
      const backoff = Math.min(8000, 500 * Math.pow(2, i)) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

type CacheEntry = { at: number; data: string };

export function cacheGet<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (Date.now() - parsed.at > ttlMs) return null;
    return JSON.parse(parsed.data) as T;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    const entry: CacheEntry = { at: Date.now(), data: JSON.stringify(value) };
    sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* quota / private mode */
  }
}

export function serializeBig(obj: unknown): unknown {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
