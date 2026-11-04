import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteSlice } from '../hooks/useInfiniteSlice';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { ConnectWalletButton } from './ConnectWalletButton';
import { SearchClearInput } from './SearchClearInput';
import type { Transaction } from '@mysten/sui/transactions';
import { ConfirmModal } from './ConfirmModal';
import {
  formatAmount,
  formatShanghai,
  formatShortDate,
  isValidSuiAddress,
  mistToSui,
  progressPct,
  shortAddr,
} from '../lib/format';
import { SmartAmount, SmartAmountRange } from './SmartAmount';
import { dryRun, friendlyRpcError } from '../lib/sui';
import { useToast } from '../lib/toast';
import {
  buildSuirc20DeployTx,
  buildSuirc20MintTx,
  buildSuirc20TransferTx,
  loadSuirc20Balances,
  loadSuirc20Holders,
  loadSuirc20Ticks,
  type Suirc20Holder,
  type Suirc20Meta,
  type Suirc20Tick,
} from '../lib/suirc20';

type SubTab = 'list' | 'holders' | 'mine' | 'actions';

type Pending = {
  title: string;
  summary: React.ReactNode;
  build: () => Transaction;
};

const PAGE = 50;

/** Same source order as the list's 创建时间: UTC, then Beijing string, then createdTs. */
function tickTimeMs(
  t: Pick<Suirc20Tick, 'deployTimeUtc' | 'deployTimeBeijing' | 'createdTs'>,
): number | null {
  if (t.deployTimeUtc) {
    const n = Date.parse(t.deployTimeUtc);
    if (Number.isFinite(n)) return n;
  }
  if (t.deployTimeBeijing) {
    const m = String(t.deployTimeBeijing).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (m) {
      const n = Date.parse(`${m[1]}T${m[2]}+08:00`);
      if (Number.isFinite(n)) return n;
    }
  }
  if (t.createdTs != null && t.createdTs !== '') {
    const n = Number(t.createdTs);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function formatFeeSui(fee: string | null | undefined): string {
  if (fee == null || String(fee).trim() === '') return '—';
  try {
    const v = BigInt(String(fee).trim());
    return v === 0n ? '0 SUI' : `${mistToSui(v)} SUI`;
  } catch {
    return '—';
  }
}

/** Snapshot stamps are already Beijing clock time; render like Movescriptions. */
function formatStamp(raw: string | null | undefined): string {
  if (!raw) return '—';
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) {
    const n = Date.parse(`${m[1]}T${m[2]}+08:00`);
    if (Number.isFinite(n)) return formatShanghai(n);
  }
  const n = Date.parse(raw);
  return Number.isFinite(n) ? formatShanghai(n) : raw;
}

function asBig(v: string | number | null | undefined): bigint {
  try {
    const raw = String(v ?? '0').trim();
    return BigInt(raw || '0');
  } catch {
    return 0n;
  }
}

/** Chain cursor as Shanghai time. No index-progress percentage — that figure was capped and misleading. */
function formatScannedTo(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatShanghai(ms);
}

export function Suirc20Panel() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const toastApi = useToast();

  const [sub, setSub] = useState<SubTab>('list');
  const [meta, setMeta] = useState<Suirc20Meta | null>(null);
  const [ticks, setTicks] = useState<Suirc20Tick[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Suirc20Tick | null>(null);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const [holders, setHolders] = useState<Suirc20Holder[]>([]);
  const [holdersTotal, setHoldersTotal] = useState(0);
  const [holdersUpdatedAt, setHoldersUpdatedAt] = useState<string | null>(null);
  const [holdersReady, setHoldersReady] = useState(false);
  const [holderPage, setHolderPage] = useState(0);
  const [loadingHolders, setLoadingHolders] = useState(false);
  const holdersReq = useRef(0);

  const [myBal, setMyBal] = useState<Record<string, string>>({});
  const [loadingMine, setLoadingMine] = useState(false);

  // action forms
  const [aTick, setATick] = useState('suis');
  const [aAmt, setAAmt] = useState('10000');
  const [aTo, setATo] = useState('');
  const [dTick, setDTick] = useState('');
  const [dMax, setDMax] = useState('21000000');
  const [dLim, setDLim] = useState('1000');
  const [dFee, setDFee] = useState('0');
  const [dFreq, setDFreq] = useState('1000');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadSuirc20Ticks();
      setMeta(data.meta);
      setTicks(data.ticks);
      setSelected((prev) => {
        if (prev) {
          const same = data.ticks.find((t) => t.tick === prev.tick);
          if (same) return same;
        }
        return data.ticks.find((t) => t.tick === 'suis') || data.ticks[0] || null;
      });
    } catch (e: any) {
      toastApi.error(friendlyRpcError(e));
    } finally {
      setLoading(false);
    }
  }, [toastApi]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const s = q.trim();
    if (!s) return ticks;
    return ticks.filter((t) => t.tick.includes(s));
  }, [ticks, q]);

  const {
    visible: listVisible,
    hasMore: listHasMore,
    sentinelRef: listSentinelRef,
    shown: listShown,
    total: listTotal,
  } = useInfiniteSlice(filtered, PAGE);

  const loadHolders = useCallback(
    async (tick: string) => {
      const req = ++holdersReq.current;
      setLoadingHolders(true);
      setHoldersReady(false);
      setHoldersUpdatedAt(null);
      try {
        const data = await loadSuirc20Holders(tick);
        if (req !== holdersReq.current) return;
        setHolders(data.holders || []);
        setHoldersTotal(data.totalHolders || data.holders?.length || 0);
        setHoldersUpdatedAt(data.updatedAtBeijing ?? null);
        setHoldersReady(true);
        setHolderPage(0);
      } catch (e: any) {
        if (req !== holdersReq.current) return;
        setHolders([]);
        setHoldersTotal(0);
        setHoldersUpdatedAt(null);
        setHoldersReady(false);
        toastApi.error(friendlyRpcError(e));
      } finally {
        if (req === holdersReq.current) setLoadingHolders(false);
      }
    },
    [toastApi],
  );

  useEffect(() => {
    if (sub === 'holders' && selected) {
      loadHolders(selected.tick);
    }
  }, [sub, selected, loadHolders]);

  const refreshMine = useCallback(async () => {
    if (!account) {
      setMyBal({});
      return;
    }
    setLoadingMine(true);
    try {
      setMyBal(await loadSuirc20Balances(account.address));
    } catch (e: any) {
      toastApi.error(friendlyRpcError(e));
    } finally {
      setLoadingMine(false);
    }
  }, [account, toastApi]);

  useEffect(() => {
    if (sub === 'mine' || sub === 'actions') refreshMine();
  }, [sub, refreshMine]);

  const holderSlice = useMemo(() => {
    const start = holderPage * PAGE;
    return holders.slice(start, start + PAGE);
  }, [holders, holderPage]);

  const holderTickOptions = useMemo(() => {
    if (selected && !ticks.some((t) => t.tick === selected.tick)) return [selected, ...ticks];
    return ticks;
  }, [ticks, selected]);

  const myRows = useMemo(() => {
    return Object.entries(myBal)
      .map(([tick, balance]) => ({ tick, balance }))
      .sort((a, b) => {
        if (a.tick === 'suis') return -1;
        if (b.tick === 'suis') return 1;
        if (a.tick === 'dgen') return -1;
        if (b.tick === 'dgen') return 1;
        return a.tick.localeCompare(b.tick);
      });
  }, [myBal]);

  function ask(p: Pending) {
    setPending(p);
  }

  async function confirmSign() {
    if (!pending || !account) return;
    setBusy(true);
    try {
      const tx = pending.build();
      tx.setSender(account.address);
      const dr = await dryRun(tx, account.address);
      if (dr.status !== 'success') {
        throw new Error(dr.error || '链上模拟失败，已取消签名');
      }
      const tx2 = pending.build();
      const res = await signAndExecute({ transaction: tx2 });
      toastApi.success(`交易已提交：${res.digest}`);
      setPending(null);
      await Promise.all([refreshMine(), refresh()]);
    } catch (e: any) {
      toastApi.error(friendlyRpcError(e));
    } finally {
      setBusy(false);
    }
  }

  const feeForTick = (tickName: string) => {
    const t = ticks.find((x) => x.tick === tickName);
    return t ? BigInt(t.fee || '0') : 0n;
  };

  const scannedLabel = formatScannedTo(meta?.scannedTo);

  return (
    <>
      <section className="hero">
        <h1>SuiMint</h1>
        <p className="subtitle">SUIRC-20 · Operation · 无市场</p>
      </section>

      {meta && (
        <div className="banner ok progress-card" style={{ cursor: 'default' }}>
          Operation 索引
          {meta.tickCount != null ? ` · ${meta.tickCount} ticks` : ''}
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            {meta.updatedAtBeijing ? <>最近更新：{meta.updatedAtBeijing}</> : null}
            {scannedLabel ? (
              <>
                {meta.updatedAtBeijing ? ' · ' : null}
                扫描到 {scannedLabel}
              </>
            ) : null}
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            数据源：<strong>Operation 见证索引</strong>
            （包 e09b…）。列表、持有者与我的铭文来自索引快照；铸造、转账、部署调用{' '}
            <code>Operation::*</code>。
          </div>
        </div>
      )}

      <nav className="tabbar tabbar-sub suirc-subnav" aria-label="SuiMint 子导航">
        <div className="tabbar-inner tabbar-sub-inner">
          {(
            [
              ['list', '铭文列表'],
              ['holders', '持有者'],
              ['mine', '我的铭文'],
              ['actions', '部署·铸造·转账'],
            ] as [SubTab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tab-btn ${sub === k ? 'active' : ''}`}
              onClick={() => setSub(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {sub === 'list' && (
        <section className="section">
          <div className="section-head">
            <h2>铭文列表</h2>
            <div className="suirc-search-row">
              <SearchClearInput value={q} onChange={setQ} />
              <button
                type="button"
                className="btn ghost small suirc-refresh"
                onClick={() => refresh()}
                disabled={loading}
              >
                刷新索引
              </button>
            </div>
          </div>
          {loading ? (
            <div className="card muted">加载中…</div>
          ) : (
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
                  {listVisible.map((t) => {
                    const max = BigInt(t.max || '0');
                    const minted = BigInt(t.minted || '0');
                    const pct =
                      max > 0n
                        ? Math.min(100, Math.max(0, Number((minted * 10000n) / max) / 100))
                        : Number(t.progress || 0);
                    const pinned = t.tick === 'suis' || t.tick === 'dgen';
                    return (
                      <tr key={t.tick}>
                        <td>
                          <button
                            type="button"
                            className="tick-link"
                            onClick={() => {
                              setSelected(t);
                              setSub('holders');
                            }}
                          >
                            {t.tick}
                          </button>
                          {pinned ? (
                            <span className="tag" style={{ marginLeft: 6 }}>
                              置顶
                            </span>
                          ) : null}
                        </td>
                        <td className="mint-progress-cell">
                          <div className="mint-progress">
                            <div className="mint-progress-bar" aria-hidden>
                              <div className="mint-progress-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="mint-progress-meta">
                              <span className="mint-progress-amt">
                                <SmartAmountRange minted={t.minted} max={t.max} />
                              </span>
                              <span className="mint-progress-pct">{pct.toFixed(1)}%</span>
                            </div>
                          </div>
                        </td>
                        <td className="num">
                          <SmartAmount value={t.holderCount} />
                        </td>
                        <td>
                          {formatShortDate(t.deployTimeUtc ?? t.deployTimeBeijing ?? t.createdTs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {listHasMore ? (
                <div ref={listSentinelRef} className="infinite-sentinel" aria-hidden />
              ) : null}
              <div className="infinite-status">
                {listHasMore
                  ? `已显示 ${listShown} / ${listTotal} · 上滑加载更多`
                  : listTotal
                    ? `共 ${listTotal} 条`
                    : '暂无数据'}
              </div>
            </div>
          )}
        </section>
      )}

      {sub === 'holders' && (
        <section className="section">
          <div className="section-head">
            <h2>持有者榜单 {selected?.tick ? `· ${selected.tick}` : ''}</h2>
            <div className="row gap wrap">
              <select
                className="select"
                value={selected?.tick || ''}
                aria-label="选择铭文"
                onChange={(e) => {
                  const t = ticks.find((x) => x.tick === e.target.value);
                  if (t) setSelected(t);
                }}
              >
                {holderTickOptions.map((t) => (
                  <option key={t.tick} value={t.tick}>
                    {t.tick}
                  </option>
                ))}
              </select>
              <button
                className="btn ghost small"
                type="button"
                onClick={() => selected && loadHolders(selected.tick)}
                disabled={loadingHolders || !selected}
              >
                刷新
              </button>
            </div>
          </div>
          {!selected ? (
            <div className="card muted">{loading ? '加载中…' : '暂无 tick'}</div>
          ) : (
            <Suirc20HolderStats
              tick={selected}
              holderCount={holdersReady ? holdersTotal : selected.holderCount}
            />
          )}
          {loadingHolders ? (
            <div className="card muted">加载持有者…</div>
          ) : (
            <>
              {holdersReady && (
                <p className="hint">
                  更新于 {formatStamp(holdersUpdatedAt)} · 共 {holdersTotal.toLocaleString()} 个地址
                  {meta?.complete === false
                    ? ' · 索引扫描未完成'
                    : meta?.complete
                      ? ' · 完整快照'
                      : ''}
                </p>
              )}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>地址</th>
                      <th>余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holderSlice.map((h, i) => (
                      <tr key={h.owner}>
                        <td>{holderPage * PAGE + i + 1}</td>
                        <td title={h.owner}>{shortAddr(h.owner)}</td>
                        <td className="num">
                          <SmartAmount value={h.balance} />
                        </td>
                      </tr>
                    ))}
                    {!holderSlice.length && (
                      <tr>
                        <td colSpan={3} className="muted">
                          暂无持有者数据（索引尚未扫到或该 tick 无快照）
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="row-actions" style={{ marginTop: 12 }}>
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={holderPage <= 0}
                  onClick={() => setHolderPage((p) => Math.max(0, p - 1))}
                >
                  上一页
                </button>
                <span className="muted">
                  {holderPage + 1} / {Math.max(1, Math.ceil(holdersTotal / PAGE))}
                </span>
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={(holderPage + 1) * PAGE >= holdersTotal}
                  onClick={() => setHolderPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {sub === 'mine' && (
        <section className="section">
          <div className="section-head">
            <h2>我的 SUIRC-20</h2>
            {!account && <ConnectWalletButton connectText="连接钱包" />}
            {account && (
              <button
                className="btn ghost small"
                type="button"
                onClick={refreshMine}
                disabled={loadingMine}
              >
                刷新
              </button>
            )}
          </div>
          {!account ? (
            <div className="card muted">连接钱包后查看索引余额</div>
          ) : loadingMine ? (
            <div className="card muted">加载中…</div>
          ) : myRows.length === 0 ? (
            <div className="card muted">当前索引快照中暂无余额</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tick</th>
                    <th>余额</th>
                  </tr>
                </thead>
                <tbody>
                  {myRows.map((r) => (
                    <tr key={r.tick}>
                      <td>
                        <strong>{r.tick}</strong>
                      </td>
                      <td className="num">
                        <SmartAmount value={r.balance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {sub === 'actions' && (
        <section className="section narrow">
          <h2>钱包操作</h2>
          <p className="muted">
            调用 <code>Operation::*</code>（包 e09b…）。签名前 dry-run。
          </p>
          {!account && (
            <div className="card muted" style={{ marginBottom: 16 }}>
              <ConnectWalletButton connectText="连接钱包" />
            </div>
          )}

          <div className="card">
            <h3>铸造</h3>
            <label className="field">
              Tick（区分大小写）
              <input value={aTick} onChange={(e) => setATick(e.target.value)} />
            </label>
            <label className="field">
              数量 amt
              <input value={aAmt} onChange={(e) => setAAmt(e.target.value)} />
            </label>
            <p className="muted">
              Mint fee：{feeForTick(aTick).toString()} MIST · Operation::mint
            </p>
            <button
              className="btn"
              type="button"
              disabled={!account || busy}
              onClick={() => {
                const tick = aTick;
                const amt = aAmt;
                const fee = feeForTick(tick);
                const t = ticks.find((x) => x.tick === tick);
                try {
                  const amtN = BigInt(amt || '0');
                  if (amtN <= 0n) {
                    toastApi.error('铸造数量须为正整数');
                    return;
                  }
                  if (t?.lim) {
                    const limN = BigInt(t.lim);
                    if (amtN > limN) {
                      toastApi.error(`铸造数量超过单次上限 lim=${t.lim}`);
                      return;
                    }
                  }
                } catch {
                  toastApi.error('铸造数量须为正整数');
                  return;
                }
                ask({
                  title: '确认铸造',
                  summary: (
                    <>
                      Operation::mint <strong>{tick}</strong> amt={amt} fee={fee.toString()} MIST
                    </>
                  ),
                  build: () => buildSuirc20MintTx(tick, amt, fee),
                });
              }}
            >
              铸造
            </button>
          </div>

          <div className="card">
            <h3>转账</h3>
            <label className="field">
              Tick
              <input value={aTick} onChange={(e) => setATick(e.target.value)} />
            </label>
            <label className="field">
              数量
              <input value={aAmt} onChange={(e) => setAAmt(e.target.value)} />
            </label>
            <label className="field">
              收款地址 to
              <input value={aTo} onChange={(e) => setATo(e.target.value)} placeholder="0x…" />
            </label>
            <button
              className="btn"
              type="button"
              disabled={!account || busy}
              onClick={() => {
                if (!isValidSuiAddress(aTo)) {
                  toastApi.error('收款地址无效');
                  return;
                }
                const tick = aTick;
                const amt = aAmt;
                const to = aTo;
                ask({
                  title: '确认转账',
                  summary: (
                    <>
                      Operation::transfer <strong>{tick}</strong> amt={amt} → {shortAddr(to)}
                    </>
                  ),
                  build: () => buildSuirc20TransferTx(tick, amt, to),
                });
              }}
            >
              转账
            </button>
          </div>

          <div className="card">
            <h3>部署新 Tick</h3>
            <label className="field">
              tick
              <input value={dTick} onChange={(e) => setDTick(e.target.value)} />
            </label>
            <label className="field">
              max
              <input value={dMax} onChange={(e) => setDMax(e.target.value)} />
            </label>
            <label className="field">
              lim
              <input value={dLim} onChange={(e) => setDLim(e.target.value)} />
            </label>
            <label className="field">
              fee (MIST)
              <input value={dFee} onChange={(e) => setDFee(e.target.value)} />
            </label>
            <label className="field">
              freq
              <input value={dFreq} onChange={(e) => setDFreq(e.target.value)} />
            </label>
            <button
              className="btn"
              type="button"
              disabled={!account || busy}
              onClick={() => {
                const payload = {
                  p: 'suirc-20',
                  op: 'deploy',
                  tick: dTick,
                  max: dMax,
                  lim: dLim,
                  fee: dFee,
                  freq: dFreq,
                };
                ask({
                  title: '确认部署',
                  summary: <code>{JSON.stringify(payload)}</code>,
                  build: () => buildSuirc20DeployTx(payload),
                });
              }}
            >
              部署
            </button>
          </div>
        </section>
      )}

      <ConfirmModal
        open={!!pending}
        title={pending?.title || ''}
        summary={pending?.summary}
        busy={busy}
        onCancel={() => !busy && setPending(null)}
        onConfirm={confirmSign}
      />
    </>
  );
}

/** Holders summary, same card set as Movescriptions. Operation has no epoch factory or TickRecord. */
function Suirc20HolderStats({ tick, holderCount }: { tick: Suirc20Tick; holderCount: number }) {
  const max = asBig(tick.max);
  const minted = asBig(tick.minted);
  const pct = progressPct(minted, max);
  const remain = max > minted ? max - minted : 0n;
  const closed = remain === 0n;
  const deployer = tick.deployer?.trim() || '';

  return (
    <div className="card detail holders-detail">
      <h3>{tick.tick || '—'}</h3>
      <dl className="grid-dl">
        <div>
          <dt>总量</dt>
          <dd>{max > 0n ? formatAmount(max) : '—'}</dd>
        </div>
        <div>
          <dt>已铸造</dt>
          <dd>
            {formatAmount(minted)}
            {max > 0n ? <span className="muted">（{pct.toFixed(2)}%）</span> : null}
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
          <dd>{formatShanghai(tickTimeMs(tick) ?? undefined)}</dd>
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
          <dd>
            <SmartAmount value={holderCount} />
          </dd>
        </div>
        <div>
          <dt>铸造费</dt>
          <dd>{formatFeeSui(tick.fee)}</dd>
        </div>
        <div>
          <dt>铸造工厂 / Epoch</dt>
          <dd className="muted" title="Operation 索引没有铸造工厂">
            —
          </dd>
        </div>
        <div>
          <dt>TickRecord</dt>
          <dd className="muted" title="Operation 索引没有 TickRecord">
            —
          </dd>
        </div>
      </dl>
    </div>
  );
}
