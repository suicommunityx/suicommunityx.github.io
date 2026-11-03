import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatAmount, formatShanghai, mistToSui, progressPct, shortAddr } from '../lib/format';
import { SmartAmount } from './SmartAmount';
import type { TickInfo } from '../lib/sui';

export type HolderRow = {
  address: string;
  amount: string;
  objects: number;
  pct: number;
};

export type HoldersSnapshot = {
  tick: string;
  updatedAt: string;
  timezoneNote?: string;
  totalSupply: string;
  currentSupply: string;
  scannedObjects: number;
  holderCount: number;
  marketEscrow?: {
    note: string;
    amount: string;
    objects: number;
  };
  holders: HolderRow[];
  complete?: boolean;
  coverage?: unknown;
};

type Props = {
  tick: string;
  tickInfo?: TickInfo | null;
  /** Optional tick picker shown in the section head. */
  tickOptions?: string[];
  onTickChange?: (tick: string) => void;
};

const PAGE = 50;

export function HoldersPanel({ tick, tickInfo, tickOptions, onTickChange }: Props) {
  const [data, setData] = useState<HoldersSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    if (!tick) return;
    setLoading(true);
    setErr(null);
    setMissing(false);
    try {
      const url = `${import.meta.env.BASE_URL}holders/${tick.toUpperCase()}.json?t=${Date.now()}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          setData(null);
          setMissing(true);
          setPage(0);
          return;
        }
        throw new Error(`加载失败（HTTP ${res.status}）`);
      }
      const json = (await res.json()) as HoldersSnapshot;
      setData(json);
      setPage(0);
    } catch (e: any) {
      setData(null);
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [tick]);

  useEffect(() => {
    load();
  }, [load]);

  const pages = useMemo(() => {
    const n = data?.holders.length || 0;
    return Math.max(1, Math.ceil(n / PAGE));
  }, [data]);

  const slice = useMemo(() => {
    if (!data) return [];
    const start = page * PAGE;
    return data.holders.slice(start, start + PAGE);
  }, [data, page]);

  async function copyAddr(addr: string) {
    try {
      await navigator.clipboard.writeText(addr);
    } catch {
      /* ignore */
    }
  }

  const totalSupply = tickInfo?.totalSupply ?? (data ? BigInt(data.totalSupply || 0) : 0n);
  const currentSupply =
    tickInfo?.currentSupply ?? (data ? BigInt(data.currentSupply || 0) : 0n);
  const remain = tickInfo?.remain ?? (totalSupply > currentSupply ? totalSupply - currentSupply : 0n);
  const pct = progressPct(currentSupply, totalSupply);
  const closed = remain === 0n;
  const recordId = tickInfo?.recordId;
  const deployer = tickInfo?.deployer;
  const mintFee = tickInfo?.mintFee ?? null;
  const startTimeMs = tickInfo?.startTimeMs ?? null;
  const mintFactory = tickInfo?.mintFactory ?? null;
  const holderCount = data?.holderCount;

  return (
    <section className="section">
      <div className="section-head">
        <h2>持有者榜单 {tick ? `· ${tick}` : ''}</h2>
        <div className="row gap wrap">
          {tickOptions && tickOptions.length > 0 && onTickChange && (
            <select
              className="select"
              value={tick}
              onChange={(e) => onTickChange(e.target.value)}
              aria-label="选择铭文"
            >
              {tickOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <button className="btn ghost small" onClick={load} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="card detail holders-detail">
        <h3>{tick || '—'}</h3>
        <dl className="grid-dl">
          <div>
            <dt>总量</dt>
            <dd>{totalSupply > 0n ? formatAmount(totalSupply) : '—'}</dd>
          </div>
          <div>
            <dt>已铸造</dt>
            <dd>
              {formatAmount(currentSupply)}
              {totalSupply > 0n ? (
                <span className="muted">（{pct.toFixed(2)}%）</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>进度</dt>
            <dd>
              <div className="bar" style={{ width: 120 }}>
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="bar-label">{pct.toFixed(1)}%</span>
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              {closed ? (
                <span className="pill danger">已结束铸造</span>
              ) : (
                <span className="pill ok">铸造中</span>
              )}
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatShanghai(startTimeMs ?? undefined)}</dd>
          </div>
          <div>
            <dt>部署者</dt>
            <dd className="mono">
              {deployer ? (
                <a
                  className="addr-link"
                  href={`https://suiscan.xyz/mainnet/account/${deployer}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(deployer, 8)}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>持有地址数</dt>
            <dd>{holderCount != null ? <SmartAmount value={holderCount} /> : '—'}</dd>
          </div>
          <div>
            <dt>铸造费</dt>
            <dd>
              {mintFee == null ? '—' : mintFee === 0n ? '0 SUI' : `${mistToSui(mintFee)} SUI`}
            </dd>
          </div>
          <div>
            <dt>铸造工厂 / Epoch</dt>
            <dd className="mono small-wrap">
              {mintFactory
                ? mintFactory.includes('::')
                  ? mintFactory.split('::').slice(-1)[0]
                  : mintFactory
                : '—'}
            </dd>
          </div>
          <div>
            <dt>TickRecord</dt>
            <dd className="mono">
              {recordId ? (
                <a
                  className="addr-link"
                  href={`https://suiscan.xyz/mainnet/object/${recordId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(recordId, 10)}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
      </div>

      {loading && <div className="card muted">加载持有者快照…</div>}
      {missing && !loading && (
        <div className="card muted">
          暂无 {tick} 的持有者快照。定时任务每 6 小时刷新一次，或等待本地/工作流生成{' '}
          <code>public/holders/{tick.toUpperCase()}.json</code> 后再试。
        </div>
      )}
      {err && !missing && (
        <div className="card error-card">
          <p>{err}</p>
          <button className="btn small primary" onClick={load}>
            重试
          </button>
        </div>
      )}

      {!loading && !err && !missing && data && (
        <>
          <p className="hint">
            更新于 {formatShanghai(BigInt(Date.parse(data.updatedAt)))} · 共{' '}
            {data.holderCount.toLocaleString()} 个地址 · 扫描对象{' '}
            {data.scannedObjects.toLocaleString()}
            {data.complete === false
              ? ' · 快照扫描未完成（双向分页合并中）'
              : ' · 完整快照'}
            {data.marketEscrow ? (
              <>
                {' '}
                · 市场托管/挂单对象已排除：{formatAmount(BigInt(data.marketEscrow.amount))}（
                {data.marketEscrow.objects} 个）
              </>
            ) : null}
          </p>

          <div className="table-wrap holders-table-wrap">
            <div className="scroll-hint">左右滑动查看更多 →</div>
            <table className="table holders-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>地址</th>
                  <th>持有量</th>
                  <th>占比</th>
                  <th>对象数</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((h, i) => {
                  const rank = page * PAGE + i + 1;
                  return (
                    <tr key={h.address}>
                      <td>{rank}</td>
                      <td className="mono">
                        <a
                          className="addr-link"
                          href={`https://suiscan.xyz/mainnet/account/${h.address}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddr(h.address, 8)}
                        </a>{' '}
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() => copyAddr(h.address)}
                          title="复制地址"
                        >
                          复制
                        </button>
                      </td>
                      <td className="num"><SmartAmount value={h.amount} /></td>
                      <td>{h.pct.toFixed(2)}%</td>
                      <td>{h.objects}</td>
                    </tr>
                  );
                })}
                {slice.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      快照中暂无地址持有者
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="market-cards holders-cards">
            {slice.map((h, i) => {
              const rank = page * PAGE + i + 1;
              return (
                <div className="market-card" key={`hcard-${h.address}`}>
                  <div className="market-card-row">
                    <span className="pill-rank">#{rank}</span>
                    <a
                      className="addr-link mono"
                      href={`https://suiscan.xyz/mainnet/account/${h.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(h.address, 8)}
                    </a>
                  </div>
                  <div className="market-card-grid">
                    <div>
                      <div className="muted">持有量</div>
                      <div className="num"><SmartAmount value={h.amount} /></div>
                    </div>
                    <div>
                      <div className="muted">占比</div>
                      <div>{h.pct.toFixed(2)}%</div>
                    </div>
                    <div>
                      <div className="muted">对象数</div>
                      <div>{h.objects}</div>
                    </div>
                  </div>
                  <button type="button" className="btn small ghost" onClick={() => copyAddr(h.address)}>
                    复制地址
                  </button>
                </div>
              );
            })}
          </div>

          <div className="pager row gap wrap">
            <button className="btn small" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span className="muted">
              {page + 1} / {pages}
            </span>
            <button
              className="btn small"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
