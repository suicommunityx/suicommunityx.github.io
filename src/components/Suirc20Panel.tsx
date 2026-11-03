import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteSlice } from '../hooks/useInfiniteSlice';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { ConnectWalletButton } from './ConnectWalletButton';
import { SearchClearInput } from './SearchClearInput';
import type { Transaction } from '@mysten/sui/transactions';
import { ConfirmModal } from './ConfirmModal';
import { formatShortDate, isValidSuiAddress, shortAddr } from '../lib/format';
import { SmartAmount, SmartAmountRange } from './SmartAmount';
import { dryRun, friendlyRpcError } from '../lib/sui';
import { useToast } from '../lib/toast';
import {
  buildSuirc20DeployTx,
  buildSuirc20MintTx,
  buildSuirc20TransferTx,
  buildSuirc20V2DeployTx,
  buildSuirc20V2MintTx,
  buildSuirc20V2TransferTx,
  loadSuirc20Balances,
  loadSuirc20Holders,
  loadSuirc20TicksByVersion,
  type Suirc20Holder,
  type Suirc20Meta,
  type Suirc20Tick,
  type Suirc20Version,
} from '../lib/suirc20';

type SubTab = 'list' | 'holders' | 'mine' | 'actions';

type Pending = {
  title: string;
  summary: React.ReactNode;
  build: () => Transaction;
};

const PAGE = 50;

export function Suirc20Panel() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const toastApi = useToast();

  /** Default 旧版 — historical suis balances live there. */
  const [version, setVersion] = useState<Suirc20Version>('v1');
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
  const [holderPage, setHolderPage] = useState(0);
  const [loadingHolders, setLoadingHolders] = useState(false);

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

  const isV2 = version === 'v2';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadSuirc20TicksByVersion(version);
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
  }, [toastApi, version]);

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
    async (tick: string, ver: Suirc20Version) => {
      setLoadingHolders(true);
      try {
        const data = await loadSuirc20Holders(tick, ver);
        setHolders(data.holders || []);
        setHoldersTotal(data.totalHolders || data.holders?.length || 0);
        setHolderPage(0);
      } catch (e: any) {
        setHolders([]);
        setHoldersTotal(0);
        toastApi.error(friendlyRpcError(e));
      } finally {
        setLoadingHolders(false);
      }
    },
    [toastApi],
  );

  useEffect(() => {
    if (sub === 'holders' && selected) {
      loadHolders(selected.tick, version);
    }
  }, [sub, selected, version, loadHolders]);

  const refreshMine = useCallback(async () => {
    if (!account) {
      setMyBal({});
      return;
    }
    setLoadingMine(true);
    try {
      setMyBal(await loadSuirc20Balances(account.address, version));
    } catch (e: any) {
      toastApi.error(friendlyRpcError(e));
    } finally {
      setLoadingMine(false);
    }
  }, [account, toastApi, version]);

  useEffect(() => {
    if (sub === 'mine' || sub === 'actions') refreshMine();
  }, [sub, refreshMine]);

  const holderSlice = useMemo(() => {
    const start = holderPage * PAGE;
    return holders.slice(start, start + PAGE);
  }, [holders, holderPage]);

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

  function switchVersion(next: Suirc20Version) {
    if (next === version) return;
    setVersion(next);
    setQ('');
    setSelected(null);
    setHolders([]);
    setHoldersTotal(0);
    setMyBal({});
    // keep aTick default suis; path follows version via builders
  }

  return (
    <>
      <section className="hero">
        <h1>SuiMint</h1>
        <p className="subtitle">SUIRC-20 · 旧版 Operation / 新版 cb5 · 无市场</p>
      </section>

      <div className="version-switch-wrap" role="group" aria-label="SuiMint 版本">
        <span className="version-switch-label">版本</span>
        <div className="version-switch">
          <button
            type="button"
            className={`version-btn ${version === 'v1' ? 'active' : ''}`}
            onClick={() => switchVersion('v1')}
          >
            旧版
          </button>
          <button
            type="button"
            className={`version-btn ${version === 'v2' ? 'active' : ''}`}
            onClick={() => switchVersion('v2')}
          >
            新版
          </button>
        </div>
      </div>

      {meta && (
        <div className="banner ok progress-card" style={{ cursor: 'default' }}>
          {isV2 ? (
            <>
              当前：<strong>新版</strong>
              {meta.tickCount != null ? ` · ${meta.tickCount} ticks` : ''}
              {meta.updatedAtBeijing ? ` · ${meta.updatedAtBeijing}` : ''}
              <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                数据源：<strong>cb5 链上注册表 / 事件索引</strong>
                （包 cb5…）。进度与持有者来自 v2 快照（索引未完成时可能不完整）；铸造 / 转账 / 部署走{' '}
                <code>suirc20::*</code>。
              </div>
            </>
          ) : (
            <>
              当前：<strong>旧版</strong>
              {meta.progressLabel ? ` · ${meta.progressLabel}` : ''}
              {meta.tickCount != null ? ` · ${meta.tickCount} ticks` : ''}
              <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                数据源：<strong>Operation 见证索引</strong>
                （包 e09b…）。进度 / 持有者 / 我的铭文均来自旧版快照；铸造 / 转账 / 部署走{' '}
                <code>Operation::*</code>。历史 suis 余额在此版本。
              </div>
            </>
          )}
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
                    const pinned =
                      version === 'v1'
                        ? t.tick === 'suis' || t.tick === 'dgen'
                        : t.tick === 'suis';
                    return (
                      <tr key={`${version}:${t.tick}`}>
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
            <h2>
              持有者 · {selected?.tick || '—'}
              <span className="muted" style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
                （{isV2 ? '新版' : '旧版'}）
              </span>
            </h2>
            <label className="field" style={{ maxWidth: 200 }}>
              选择 tick
              <select
                className="select"
                value={selected?.tick || ''}
                onChange={(e) => {
                  const t = ticks.find((x) => x.tick === e.target.value);
                  if (t) setSelected(t);
                }}
              >
                {ticks.slice(0, 80).map((t) => (
                  <option key={t.tick} value={t.tick}>
                    {t.tick}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loadingHolders ? (
            <div className="card muted">加载持有者…</div>
          ) : (
            <>
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
            <h2>
              我的 SUIRC-20
              <span className="muted" style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
                （{isV2 ? '新版' : '旧版'}）
              </span>
            </h2>
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
          <h2>钱包操作 · {isV2 ? '新版' : '旧版'}</h2>
          <p className="muted">
            {isV2 ? (
              <>
                当前版本调用 <code>suirc20::deploy/mint/transfer</code>（包 cb5…）。签名前 dry-run。
              </>
            ) : (
              <>
                当前版本调用 <code>Operation::*</code>（包 e09b…）。签名前 dry-run。
              </>
            )}
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
              Mint fee：{feeForTick(aTick).toString()} MIST
              {isV2 ? ' · 新版 suirc20::mint' : ' · 旧版 Operation::mint'}
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
                if (isV2) {
                  if (!t?.tickId) {
                    toastApi.error('该新版 tick 缺少 tickId，无法铸造');
                    return;
                  }
                  const tickId = t.tickId;
                  ask({
                    title: '确认铸造（新版）',
                    summary: (
                      <>
                        suirc20::mint <strong>{tick}</strong> amt={amt} fee={fee.toString()} MIST
                      </>
                    ),
                    build: () => buildSuirc20V2MintTx(tickId, amt, fee),
                  });
                  return;
                }
                ask({
                  title: '确认铸造（旧版）',
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
                if (isV2) {
                  ask({
                    title: '确认转账（新版）',
                    summary: (
                      <>
                        suirc20::transfer <strong>{tick}</strong> amt={amt} → {shortAddr(to)}
                      </>
                    ),
                    build: () => buildSuirc20V2TransferTx(tick, amt, to),
                  });
                  return;
                }
                ask({
                  title: '确认转账（旧版）',
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
            {isV2 ? (
              <button
                className="btn"
                type="button"
                disabled={!account || busy}
                onClick={() => {
                  const tickBytes = new TextEncoder().encode(dTick);
                  if (tickBytes.length !== 4) {
                    toastApi.error('新版部署要求 tick 名称恰好 4 个字符（按字节，例如 suis）');
                    return;
                  }
                  try {
                    const maxN = BigInt(dMax || '0');
                    const limN = BigInt(dLim || '0');
                    if (limN > maxN) {
                      toastApi.error('lim 不能大于 max');
                      return;
                    }
                  } catch {
                    toastApi.error('max/lim 须为非负整数');
                    return;
                  }
                  ask({
                    title: '确认部署（新版 suirc20）',
                    summary: (
                      <code>
                        {JSON.stringify({
                          tick: dTick,
                          max: dMax,
                          lim: dLim,
                          fee: dFee,
                          freq: dFreq,
                          dec: 0,
                        })}
                      </code>
                    ),
                    build: () =>
                      buildSuirc20V2DeployTx({
                        tick: dTick,
                        max: dMax,
                        lim: dLim,
                        fee: dFee,
                        freq: dFreq,
                        dec: 0,
                      }),
                  });
                }}
              >
                部署（新版 cb5）
              </button>
            ) : (
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
                    title: '确认部署（旧版 Operation）',
                    summary: <code>{JSON.stringify(payload)}</code>,
                    build: () => buildSuirc20DeployTx(payload),
                  });
                }}
              >
                部署（旧版 Operation）
              </button>
            )}
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
