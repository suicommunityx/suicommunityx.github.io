const SHANGHAI = 'Asia/Shanghai';

export function formatAmount(n: string | number | bigint): string {
  const v = BigInt(n);
  return v.toLocaleString('zh-CN');
}

export function mistToSui(mist: string | number | bigint, digits = 4): string {
  const v = Number(BigInt(mist)) / 1e9;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function formatShanghai(ms: string | number | bigint | null | undefined): string {
  if (ms === null || ms === undefined || ms === '' || ms === '0') return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d) + ' (Asia/Shanghai)';
}

export function shortAddr(a: string, n = 6): string {
  if (!a) return '';
  return `${a.slice(0, n)}…${a.slice(-4)}`;
}

export function isValidSuiAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(addr.trim());
}

export function progressPct(minted: bigint, supply: bigint): number {
  if (supply === 0n) return 0;
  const p = Number((minted * 10000n) / supply) / 100;
  return Math.min(100, Math.max(0, p));
}


/** Compact amounts for narrow tables: 10B / 21M / 1.2K (bigint-safe). */
export function formatCompactAmount(n: string | number | bigint): string {
  let v: bigint;
  try {
    v = typeof n === 'bigint' ? n : BigInt(String(n).replace(/,/g, ''));
  } catch {
    return String(n);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const sign = neg ? '-' : '';
  const units: [bigint, string][] = [
    [10n ** 12n, 'T'],
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'K'],
  ];
  for (const [div, suffix] of units) {
    if (v >= div) {
      const whole = v / div;
      const frac = ((v % div) * 100n) / div; // 2 decimals
      if (frac === 0n) return sign + whole.toString() + suffix;
      const f = frac.toString().padStart(2, '0').replace(/0+$/, '');
      return sign + whole.toString() + (f ? '.' + f : '') + suffix;
    }
  }
  return sign + v.toString();
}

/** YYYY-MM-DD from ms or Beijing/ISO string; no timezone suffix. */
export function formatShortDate(
  input?: string | number | bigint | null,
): string {
  if (input == null || input === '') return '—';
  let ms: number | null = null;
  if (typeof input === 'bigint' || typeof input === 'number') {
    ms = Number(input);
  } else {
    const s = String(input);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const n = Date.parse(s.replace(' Asia/Shanghai', '+08:00'));
    if (Number.isFinite(n)) ms = n;
  }
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  // Asia/Shanghai calendar date
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const mo = parts.find((p) => p.type === 'month')?.value;
  const da = parts.find((p) => p.type === 'day')?.value;
  return y && mo && da ? `${y}-${mo}-${da}` : '—';
}
