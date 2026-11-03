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
            <th className="num">进度</th>
            <th className="num">已铸</th>
            <th className="num hide-narrow">剩余</th>
            <th className="num hide-narrow">总量</th>
            <th className="hide-narrow">创建</th>
            <th className="num hide-narrow">费</th>
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
                <td className="num">
                  <span className="bar-label">{pct.toFixed(1)}%</span>
                  {closed ? <span className="pill danger">罄</span> : null}
                </td>
                <td className="num">{formatCompactAmount(t.currentSupply)}</td>
                <td className="num hide-narrow">{formatCompactAmount(t.remain)}</td>
                <td className="num hide-narrow">{formatCompactAmount(t.totalSupply)}</td>
                <td className="hide-narrow">{formatShortDate(t.startTimeMs)}</td>
                <td className="num hide-narrow">
                  {t.mintFee == null ? '—' : t.mintFee === 0n ? '0' : mistToSui(t.mintFee)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
