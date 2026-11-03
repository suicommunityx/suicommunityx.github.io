import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatCompactAmount, formatExactAmount } from '../lib/format';

type Value = string | number | bigint;

type Props = {
  value: Value;
  className?: string;
  /** Optional title override; defaults to exact full string. */
  title?: string;
};

function overflows(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1;
}

/** Exact amount by default; switches to K/M/B… only when this element overflows. */
export function SmartAmount({ value, className, title }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const full = useMemo(() => formatExactAmount(value), [value]);
  const short = useMemo(() => formatCompactAmount(value), [value]);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const sync = () => {
      // Measure with full text against the constrained box.
      el.textContent = full;
      const need = overflows(el);
      el.textContent = need ? short : full;
      setCompact((prev) => (prev === need ? prev : need));
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [full, short]);

  return (
    <span
      ref={ref}
      className={['smart-amount', className].filter(Boolean).join(' ')}
      title={title ?? full}
    >
      {compact ? short : full}
    </span>
  );
}

type RangeProps = {
  minted: Value;
  max: Value;
  className?: string;
};

/** "minted / max" as one measurable unit — both sides compact together if the pair overflows. */
export function SmartAmountRange({ minted, max, className }: RangeProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const fullA = useMemo(() => formatExactAmount(minted), [minted]);
  const fullB = useMemo(() => formatExactAmount(max), [max]);
  const shortA = useMemo(() => formatCompactAmount(minted), [minted]);
  const shortB = useMemo(() => formatCompactAmount(max), [max]);
  const full = `${fullA} / ${fullB}`;
  const short = `${shortA} / ${shortB}`;
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const sync = () => {
      el.textContent = full;
      const need = overflows(el);
      el.textContent = need ? short : full;
      setCompact((prev) => (prev === need ? prev : need));
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [full, short]);

  return (
    <span
      ref={ref}
      className={['smart-amount', 'smart-amount-range', className].filter(Boolean).join(' ')}
      title={full}
    >
      {compact ? short : full}
    </span>
  );
}
