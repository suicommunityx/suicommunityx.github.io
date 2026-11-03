import { useMemo } from 'react';
import type { TickInfo } from '../lib/sui';
import { formatShortDate, progressPct } from '../lib/format';
import { useInfiniteSlice } from '../hooks/useInfiniteSlice';
import { SmartAmount, SmartAmountRange } from './SmartAmount';

type Props = {
  ticks: TickInfo[];
  loading: boolean;
  onSelect: (t: TickInfo) => void;
  /** Open holders for this tick (exact case). */
  onView?: (t: TickInfo) => void;
  selected?: string;
  /** Snapshot holder counts keyed by tick (exact or upper). Missing → '—'. */
  holderCounts?: Record<string, number>;
};

function lookupHolders(tick: string, map?: Record<string, number>): number | null {
  if (!map) return null;
  if (tick in map) return map[tick];
  const up = tick.toUpperCase();
  if (up in map) return map[up];
  const hit = Object.entries(map).find(([k]) => k.toUpperCase() === up);
  return hit ? hit[1] : null;
}

const BATCH = 50;

export function TickList({ ticks, loading, onSelect, onView, selected, holderCounts }: Props) {
  const { visible, hasMore, sentinelRef, shown, total } = useInfiniteSlice(ticks, BATCH);

  const rows = useMemo(
    () =>
      visible.map((t) => {
        const pct = progressPct(t.currentSupply, t.totalSupply);
        const holders = lookupHolders(t.tick, holderCounts);
        return { t, pct, holders };
      }),
    [visible, holderCounts],
  );

  if (loading) return <div className="card muted">加载铭文列表…</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="tick-col">名称</th>
            <th>铸造进度</th>
            <th className="num">持有者</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, pct, holders }) => (
            <tr
              key={t.tick}
              className={selected === t.tick ? 'selected' : ''}
              onClick={() => onSelect(t)}
            >
              <td className="tick">
                <button
                  type="button"
                  className="tick-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    (onView || onSelect)(t);
                  }}
                >
                  {t.tick}
                </button>
              </td>
              <td className="mint-progress-cell">
                <div className="mint-progress">
                  <div className="mint-progress-bar" aria-hidden>
                    <div className="mint-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mint-progress-meta">
                    <span className="mint-progress-amt">
                      <SmartAmountRange minted={t.currentSupply} max={t.totalSupply} />
                    </span>
                    <span className="mint-progress-pct">{pct.toFixed(1)}%</span>
                  </div>
                </div>
              </td>
              <td className="num">{holders == null ? '—' : <SmartAmount value={holders} />}</td>
              <td>{formatShortDate(t.startTimeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore ? <div ref={sentinelRef} className="infinite-sentinel" aria-hidden /> : null}
      <div className="infinite-status">
        {hasMore ? `已显示 ${shown} / ${total} · 上滑加载更多` : total ? `共 ${total} 条` : '暂无数据'}
      </div>
    </div>
  );
}
