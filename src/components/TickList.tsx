import type { TickInfo } from '../lib/sui';
import { formatAmount, formatShanghai, mistToSui, progressPct } from '../lib/format';

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
            <th>名称</th>
            <th>总量</th>
            <th>已铸 / 剩余</th>
            <th>进度</th>
            <th>创建时间</th>
            <th>铸造费</th>
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
                <td>{formatAmount(t.totalSupply)}</td>
                <td>
                  {formatAmount(t.currentSupply)} / {formatAmount(t.remain)}
                </td>
                <td>
                  <div className="bar">
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="bar-label">{pct.toFixed(1)}%</span>
                  {closed && <span className="pill danger">已售罄</span>}
                </td>
                <td className="nowrap">{formatShanghai(t.startTimeMs ?? undefined)}</td>
                <td>
                  {t.mintFee == null ? '—' : t.mintFee === 0n ? '0' : `${mistToSui(t.mintFee)} SUI`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
