import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatCompactAmount, formatExactAmount } from '../lib/format';

type Value = string | number | bigint;

type Props = {
  value: Value;
  className?: string;
  title?: string;
};

/** Exact by default; compact only when the box is too narrow. Stable — no observer loops. */
export function SmartAmount({ value, className, title }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const full = useMemo(() => formatExactAmount(value), [value]);
  const short = useMemo(() => formatCompactAmount(value), [value]);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;

    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const room = box.clientWidth;
        if (room <= 0) return;
        const need = probe.scrollWidth > room + 1;
        // Hysteresis: only expand back when there is clear spare room
        let next = compactRef.current;
        if (!compactRef.current && need) next = true;
        else if (compactRef.current && probe.scrollWidth < room - 12) next = false;
        if (next !== compactRef.current) {
          compactRef.current = next;
          setCompact(next);
        }
      });
    };

    sync();
    // Observe the constraining ancestor (cell), never the text node we mutate.
    const target = box.parentElement || box;
    const ro = new ResizeObserver(sync);
    ro.observe(target);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [full, short]);

  return (
    <span
      ref={boxRef}
      className={['smart-amount', className].filter(Boolean).join(' ')}
      title={title ?? full}
    >
      <span ref={probeRef} className="smart-amount-probe" aria-hidden>
        {full}
      </span>
      {compact ? short : full}
    </span>
  );
}

type RangeProps = {
  minted: Value;
  max: Value;
  className?: string;
};

export function SmartAmountRange({ minted, max, className }: RangeProps) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const fullA = useMemo(() => formatExactAmount(minted), [minted]);
  const fullB = useMemo(() => formatExactAmount(max), [max]);
  const shortA = useMemo(() => formatCompactAmount(minted), [minted]);
  const shortB = useMemo(() => formatCompactAmount(max), [max]);
  const full = `${fullA} / ${fullB}`;
  const short = `${shortA} / ${shortB}`;
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;

    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const room = box.clientWidth;
        if (room <= 0) return;
        const need = probe.scrollWidth > room + 1;
        let next = compactRef.current;
        if (!compactRef.current && need) next = true;
        else if (compactRef.current && probe.scrollWidth < room - 12) next = false;
        if (next !== compactRef.current) {
          compactRef.current = next;
          setCompact(next);
        }
      });
    };

    sync();
    const target = box.parentElement || box;
    const ro = new ResizeObserver(sync);
    ro.observe(target);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [full, short]);

  return (
    <span
      ref={boxRef}
      className={['smart-amount', 'smart-amount-range', className].filter(Boolean).join(' ')}
      title={full}
    >
      <span ref={probeRef} className="smart-amount-probe" aria-hidden>
        {full}
      </span>
      {compact ? short : full}
    </span>
  );
}
