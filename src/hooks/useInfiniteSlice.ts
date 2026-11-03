import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BATCH_DEFAULT = 50;

/** Incremental window over a (possibly filtered) list; grows when sentinel enters view. */
export function useInfiniteSlice<T>(items: T[], batchSize = BATCH_DEFAULT) {
  const [limit, setLimit] = useState(batchSize);
  const itemsLen = items.length;

  // Reset window whenever the filtered dataset identity/size changes.
  useEffect(() => {
    setLimit(batchSize);
  }, [items, batchSize]);

  const visible = useMemo(() => items.slice(0, limit), [items, limit]);
  const hasMore = limit < itemsLen;
  const ioRef = useRef<IntersectionObserver | null>(null);

  const loadMore = useCallback(() => {
    setLimit((n) => Math.min(n + batchSize, itemsLen));
  }, [batchSize, itemsLen]);

  // Callback ref: (re)bind observer whenever the sentinel mounts (e.g. tab switch).
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (ioRef.current) {
        ioRef.current.disconnect();
        ioRef.current = null;
      }
      if (!node || !hasMore) return;
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { root: null, rootMargin: '320px 0px', threshold: 0 },
      );
      io.observe(node);
      ioRef.current = io;
    },
    [hasMore, loadMore],
  );

  useEffect(() => () => {
    ioRef.current?.disconnect();
    ioRef.current = null;
  }, []);

  return { visible, hasMore, sentinelRef, shown: visible.length, total: itemsLen };
}
