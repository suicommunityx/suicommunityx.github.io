import type { TickInfo } from '../lib/sui';
import { formatCompactAmount, formatShortDate, mistToSui, progressPct } from '../lib/format';

type Props = {
  ticks: TickInfo[];
  loading: boolean;
  onSelect: (t: TickInfo) => void;
  /** Open holders for this tick (exact case). */
  onView?: (t: TickInfo) => void;
  selected?: string;
};

export function TickList({ ticks, loading, onSelect, onView, selected }: Props) {
  if (loading) return <div className="card muted">加载铭文列表…</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="tick-col">名称</th>
            <th>铸造进度</th>
            <th className="num hide-narrow">费</th>
            <th>创建</th>
          </tr>
        </thead>
        <tbody>
          {ticks.map((t) => {
            const pct = progressPct(t.currentSupply, t.totalSupply);
            const closed = t.remain === 0n;
            return (
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
                        {formatCompactAmount(t.currentSupply)} / {formatCompactAmount(t.totalSupply)}
                      </span>
                      <span className="mint-progress-pct">
                        {pct.toFixed(1)}%{closed ? ' · 罄' : ''}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="num hide-narrow">
                  {t.mintFee == null ? '—' : t.mintFee === 0n ? '0' : mistToSui(t.mintFee)}
                </td>
                <td>{formatShortDate(t.startTimeMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
