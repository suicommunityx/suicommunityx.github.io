import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { RPC_FALLBACKS, RPC_URL, NETWORK } from './constants';

/** Map known SUIRC-20 v2 (cb5::suirc20) abort codes to Chinese hints. */
const SUIRC20_V2_ABORT: Record<number, string> = {
  0: '该 tick 已存在于新版注册表',
  1: '支付的铸造费不足',
  2: '铸造数量超过单次上限（lim）',
  3: '该 tick 为分享铸造模式，不能用此接口铸造',
  4: 'tick 名称长度必须恰好为 4 个字符（按字节）',
  5: '参数不合法：lim 不能大于 max',
  6: '小数位 dec 不能超过 18',
  7: '协议版本过低，请确认调用的是新版合约',
};

function explainMoveAbort(msg: string): string | null {
  const abortMatch = msg.match(/abort code:\s*(\d+)/i) || msg.match(/MoveAbort[^0-9]*(\d+)/i);
  if (!abortMatch) return null;
  const code = Number(abortMatch[1]);
  const inCb5 = /0xcb5bd7a29f458a1b1e0221516fbfaeb182be027033eb8dcb4f/i.test(msg);
  const inSuirc20 = /::suirc20::/i.test(msg) || inCb5;
  const fnMatch = msg.match(/::suirc20::(\w+)/i) || msg.match(/in '0x[0-9a-f]+::(\w+)::(\w+)/i);
  const fn = fnMatch ? (fnMatch[2] || fnMatch[1] || '') : '';

  let meaning = '';
  if (inSuirc20 || inCb5) {
    meaning = SUIRC20_V2_ABORT[code] || '';
  }

  // Generic framing
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
  // Title = Chinese explanation; detail = raw MoveAbort (toast renders as separate lines)
  if (meaning) {
    return `${head}：${meaning}\n${truncated}`;
  }
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
    return '当前节点已停用旧版 JSON-RPC，正在切换备用节点…若仍失败请刷新页面。';
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
