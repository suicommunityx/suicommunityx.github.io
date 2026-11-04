import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { ConfirmModal } from './ConfirmModal';
import { ConnectWalletButton } from './ConnectWalletButton';
import { SearchClearInput } from './SearchClearInput';
import { SmartAmount, SmartAmountRange } from './SmartAmount';
import { useInfiniteSlice } from '../hooks/useInfiniteSlice';
import { dryRun, friendlyRpcError } from '../lib/sui';
import { useToast } from '../lib/toast';
import { shortAddr } from '../lib/format';
import {
  SUIS_PACKAGE_ID,
  SUIS_RULES,
  buildSuisInscribeTx,
  isPositiveUint,
  isSuisTick,
  loadSuisBalances,
  loadSuisHolders,
  loadSuisIndex,
  normalizeSuiAddress,
  readSuisLocation,
  suisDeployJson,
  suisLocation,
  suisMintJson,
  suisTransferJson,
  type SuisHolder,
  type SuisTick,
} from '../lib/suis';

type Sub = 'list' | 'holders' | 'mine' | 'inscribe';

type Pending = {
  title: string;
  summary: ReactNode;
  payload: string;
};

const PAGE = 50;

function shareOf(balance: string, minted: string): string {
  try {
    const b = BigInt(balance || '0');
    const m = BigInt(minted || '0');
    if (m <= 0n) return '0.0%';
    return `${(Number((b * 10000n) / m) / 100).toFixed(1)}%`;
  } catch {
    return '—';
  }
}

function pctOf(minted: string, max: string): number {
  try {
    const m = BigInt(minted || '0');
    const x = BigInt(max || '0');
    if (x <= 0n) return 0;
    return Math.min(100, Math.max(0, Number((m * 10000n) / x) / 100));
  } catch {
    return 0;
  }
}

export function SuisPanel() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const toastApi = useToast();
  const initial = readSuisLocation();

  const [sub, setSub] = useState<Sub>(initial.sub);
  const [hashTick, setHashTick] = useState<string | null>(initial.tick);
  const [rules, setRules] = useState(SUIS_RULES);
  const [ticks, setTicks] = useState<SuisTick[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SuisTick | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const [holders, setHolders] = useState<SuisHolder[]>([]);
  const [holdersMinted, setHoldersMinted] = useState('0');
  const [loadingHolders, setLoadingHolders] = useState(false);
  const [holderPage, setHolderPage] = useState(0);

  const [myRows, setMyRows] = useState<{ tick: string; balance: string }[]>([]);
  const [loadingMine, setLoadingMine] = useState(false);

  const [aTick, setATick] = useState('');
  const [aAmt, setAAmt] = useState('1000');
  const [aTo, setATo] = useState('');
  const [dTick, setDTick] = useState('');
  const [dMax, setDMax] = useState('21000000');
  const [dLim, setDLim] = useState('1000');

  const go = useCallback((next: Sub, tick?: string | null) => {
    setSub(next);
    if (tick !== undefined) setHashTick(tick);
    const hash = suisLocation(next, tick === undefined ? null : tick);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const index = await loadSuisIndex();
      setRules(index.rules);
      setTicks(index.ticks);
      setSelected((prev) => {
        const wanted = hashTick || prev?.tick;
        if (wanted) {
          const found = index.ticks.find((tick) => tick.tick === wanted);
          if (found) return found;
        }
        return index.ticks[0] || null;
      });
    } catch (err: unknown) {
      toastApi.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [hashTick, toastApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onHash = () => {
      const route = readSuisLocation();
      setSub(route.sub);
      setHashTick(route.tick);
      if (route.tick) {
        setSelected((prev) => {
          const found = ticks.find((tick) => tick.tick === route.tick);
          return found || prev;
        });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [ticks]);

  const loadHolders = useCallback(
    async (tick: string) => {
      setLoadingHolders(true);
      setHolderPage(0);
      try {
        const file = await loadSuisHolders(tick);
        setHolders(file.holders);
        setHoldersMinted(file.minted);
      } catch (err: unknown) {
        setHolders([]);
        setHoldersMinted('0');
        toastApi.error(err instanceof Error ? err.message : '加载持有者失败');
      } finally {
        setLoadingHolders(false);
      }
    },
    [toastApi],
  );

  useEffect(() => {
    if (sub !== 'holders' || !selected) return;
    void loadHolders(selected.tick);
  }, [sub, selected, loadHolders]);

  const refreshMine = useCallback(async () => {
    if (!account) {
      setMyRows([]);
      return;
    }
    setLoadingMine(true);
    try {
      setMyRows(await loadSuisBalances(account.address));
    } catch (err: unknown) {
      toastApi.error(err instanceof Error ? err.message : '加载余额失败');
    } finally {
      setLoadingMine(false);
    }
  }, [account, toastApi]);

  useEffect(() => {
    if (sub === 'mine') void refreshMine();
  }, [sub, refreshMine]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return ticks;
    return ticks.filter((tick) => tick.tick.includes(q));
  }, [ticks, query]);

  const { visible, hasMore, sentinelRef, shown, total } = useInfiniteSlice(filtered, PAGE);
  const holderSlice = holders.slice(holderPage * PAGE, holderPage * PAGE + PAGE);

  function requirePackage(): boolean {
    if (SUIS_PACKAGE_ID) return true;
    toastApi.error('主网还没有配置 suis 包地址。发布后填写 src/lib/suis.ts 的 SUIS_PACKAGE_ID。');
    return false;
  }

  async function confirmSign() {
    if (!pending || !account) return;
    setBusy(true);
    try {
      const payload = pending.payload;
      const tx = buildSuisInscribeTx(payload);
      tx.setSender(account.address);
      const dr = await dryRun(tx, account.address);
      if (dr.status !== 'success') {
        throw new Error(dr.error || '链上模拟失败，已取消签名');
      }
      const tx2 = buildSuisInscribeTx(payload);
      const res = await signAndExecute({ transaction: tx2 });
      toastApi.success(`交易已提交：${res.digest}`);
      setPending(null);
      await refresh();
    } catch (err: unknown) {
      toastApi.error(friendlyRpcError(err));
    } finally {
      setBusy(false);
    }
  }

  const packageLabel = SUIS_PACKAGE_ID
    ? `${SUIS_PACKAGE_ID.slice(0, 10)}…`
    : '未发布';

  return (
    <>
      <section className="hero">
        <h1>suis</h1>
        <p className="subtitle">Sui 上的铭文 · 只认 deploy、mint、transfer</p>
      </section>
      <div className="suis-meta">
        <span>
          {rules} · 大小写敏感 · 余额来自事件重放 · 包 {packageLabel}
        </span>
        <button type="button" className="btn ghost small" onClick={() => go('inscribe')}>
          铭刻
        </button>
      </div>

      <nav className="tabbar tabbar-sub suirc-subnav" aria-label="suis 子导航">
        <div className="tabbar-inner tabbar-sub-inner">
          {(
            [
              ['list', '铭文列表'],
              ['holders', '持有者'],
              ['mine', '我的铭文'],
              ['inscribe', '铭刻'],
            ] as [Sub, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab-btn ${sub === key ? 'active' : ''}`}
              onClick={() => go(key, key === 'holders' ? selected?.tick || hashTick : null)}
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
              <SearchClearInput value={query} onChange={setQuery} />
              <button
                type="button"
                className="btn ghost small suirc-refresh"
                onClick={() => void refresh()}
                disabled={loading}
              >
                刷新索引
              </button>
            </div>
          </div>
          {loading ? (
            <div className="card muted">加载中…</div>
          ) : ticks.length === 0 ? (
            <div className="card suis-empty">
              <strong>还没有 deploy</strong>
              <p className="muted">
                这是空快照，不是加载失败。SuiMint Operation 和市场成交不会出现在这张表里。
              </p>
              <button type="button" className="btn" onClick={() => go('inscribe')}>
                去铭刻
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="tick-col">Tick</th>
                    <th>铸造进度</th>
                    <th className="num">持有者</th>
                    <th className="num">单次上限</th>
                    <th>检查点</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((tick) => {
                    const pct = pctOf(tick.minted, tick.max);
                    return (
                      <tr key={tick.tick}>
                        <td>
                          <button
                            type="button"
                            className="tick-link suis-tick"
                            onClick={() => {
                              setSelected(tick);
                              go('holders', tick.tick);
                            }}
                          >
                            {tick.tick}
                          </button>
                        </td>
                        <td className="mint-progress-cell">
                          <div className="mint-progress">
                            <div className="mint-progress-bar" aria-hidden>
                              <div className="mint-progress-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="mint-progress-meta">
                              <span className="mint-progress-amt">
                                <SmartAmountRange minted={tick.minted} max={tick.max} />
                              </span>
                              <span className="mint-progress-pct">{pct.toFixed(1)}%</span>
                            </div>
                          </div>
                        </td>
                        <td className="num">
                          <SmartAmount value={tick.holderCount} />
                        </td>
                        <td className="num">
                          <SmartAmount value={tick.lim} />
                        </td>
                        <td className="num">{tick.deployCheckpoint}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {hasMore ? <div ref={sentinelRef} className="infinite-sentinel" aria-hidden /> : null}
              <div className="infinite-status">
                {hasMore ? `已显示 ${shown} / ${total} · 上滑加载更多` : total ? `共 ${total} 条` : '暂无数据'}
              </div>
            </div>
          )}
        </section>
      )}

      {sub === 'holders' && (
        <section className="section">
          <div className="section-head">
            <h2>持有者 {selected ? `· ${selected.tick}` : ''}</h2>
            <div className="row gap wrap">
              <select
                className="select"
                value={selected?.tick || ''}
                aria-label="选择铭文"
                onChange={(event) => {
                  const tick = ticks.find((item) => item.tick === event.target.value);
                  if (!tick) return;
                  setSelected(tick);
                  go('holders', tick.tick);
                }}
              >
                {ticks.map((tick) => (
                  <option key={tick.tick} value={tick.tick}>
                    {tick.tick}
                  </option>
                ))}
              </select>
              <button
                className="btn ghost small"
                type="button"
                onClick={() => selected && void loadHolders(selected.tick)}
                disabled={loadingHolders || !selected}
              >
                刷新
              </button>
            </div>
          </div>
          {!selected ? (
            <div className="card muted">{loading ? '加载中…' : '暂无 tick'}</div>
          ) : loadingHolders ? (
            <div className="card muted">加载持有者…</div>
          ) : (
            <>
              <p className="hint">
                已铸造 <SmartAmount value={holdersMinted} /> · 共 {holders.length.toLocaleString()} 个地址
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>地址</th>
                      <th>余额</th>
                      <th className="num">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holderSlice.map((holder, index) => (
                      <tr key={holder.owner}>
                        <td>{holderPage * PAGE + index + 1}</td>
                        <td title={holder.owner}>{shortAddr(holder.owner)}</td>
                        <td className="num">
                          <SmartAmount value={holder.balance} />
                        </td>
                        <td className="num">{shareOf(holder.balance, holdersMinted)}</td>
                      </tr>
                    ))}
                    {!holderSlice.length && (
                      <tr>
                        <td colSpan={4} className="muted">
                          没有非零余额
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
                  onClick={() => setHolderPage((page) => Math.max(0, page - 1))}
                >
                  上一页
                </button>
                <span className="muted">
                  {holderPage + 1} / {Math.max(1, Math.ceil(holders.length / PAGE))}
                </span>
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={(holderPage + 1) * PAGE >= holders.length}
                  onClick={() => setHolderPage((page) => page + 1)}
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
            <h2>我的 suis</h2>
            {!account && <ConnectWalletButton connectText="连接钱包" />}
            {account && (
              <button className="btn ghost small" type="button" onClick={() => void refreshMine()} disabled={loadingMine}>
                刷新
              </button>
            )}
          </div>
          {!account ? (
            <div className="card muted">连接钱包后，从持有者快照里查找这个地址</div>
          ) : loadingMine ? (
            <div className="card muted">加载中…</div>
          ) : myRows.length === 0 ? (
            <div className="card muted">当前 suis 快照里没有这个地址的余额</div>
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
                  {myRows.map((row) => (
                    <tr key={row.tick}>
                      <td>
                        <strong>{row.tick}</strong>
                      </td>
                      <td className="num">
                        <SmartAmount value={row.balance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {sub === 'inscribe' && (
        <section className="section narrow">
          <h2>铭刻</h2>
          <p className="muted">
            调用 <code>inscription::inscribe</code>，参数是 UTF-8 JSON 的字节。签名前会 dry-run。
            索引器忽略非法、超额和余额不足的整条铭文，不会部分入账。
          </p>
          {!SUIS_PACKAGE_ID && (
            <div className="card muted" style={{ marginBottom: 16 }}>
              主网包地址尚未写入 <code>SUIS_PACKAGE_ID</code>。可以先看载荷，还不能签名。
            </div>
          )}
          {!account && (
            <div className="card muted" style={{ marginBottom: 16 }}>
              <ConnectWalletButton connectText="连接钱包" />
            </div>
          )}

          <div className="card">
            <h3>铸造</h3>
            <label className="field">
              Tick（区分大小写，4–8 位字母或数字）
              <input value={aTick} onChange={(event) => setATick(event.target.value)} />
            </label>
            <label className="field">
              amt
              <input value={aAmt} onChange={(event) => setAAmt(event.target.value)} />
            </label>
            <pre className="hint">{suisMintJson(aTick, aAmt)}</pre>
            <button
              className="btn"
              type="button"
              disabled={!account || busy || !SUIS_PACKAGE_ID}
              onClick={() => {
                if (!requirePackage()) return;
                if (!isSuisTick(aTick)) {
                  toastApi.error('tick 须为 4–8 位字母或数字，区分大小写');
                  return;
                }
                if (!isPositiveUint(aAmt)) {
                  toastApi.error('amt 须为不带前导零的正整数字符串');
                  return;
                }
                const tick = aTick;
                const amt = aAmt;
                setPending({
                  title: '确认铸造',
                  summary: (
                    <>
                      inscribe mint <strong>{tick}</strong> amt={amt}
                    </>
                  ),
                  payload: suisMintJson(tick, amt),
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
              <input value={aTick} onChange={(event) => setATick(event.target.value)} />
            </label>
            <label className="field">
              amt
              <input value={aAmt} onChange={(event) => setAAmt(event.target.value)} />
            </label>
            <label className="field">
              to
              <input value={aTo} onChange={(event) => setATo(event.target.value)} placeholder="0x…" />
            </label>
            <button
              className="btn"
              type="button"
              disabled={!account || busy || !SUIS_PACKAGE_ID}
              onClick={() => {
                if (!requirePackage()) return;
                if (!isSuisTick(aTick) || !isPositiveUint(aAmt)) {
                  toastApi.error('tick 或 amt 不符合 suis-20');
                  return;
                }
                const to = normalizeSuiAddress(aTo);
                if (!to) {
                  toastApi.error('收款地址无效');
                  return;
                }
                const tick = aTick;
                const amt = aAmt;
                setPending({
                  title: '确认转账',
                  summary: (
                    <>
                      inscribe transfer <strong>{tick}</strong> amt={amt} → {shortAddr(to)}
                    </>
                  ),
                  payload: suisTransferJson(tick, amt, to),
                });
              }}
            >
              转账
            </button>
          </div>

          <div className="card">
            <h3>部署</h3>
            <label className="field">
              tick
              <input value={dTick} onChange={(event) => setDTick(event.target.value)} />
            </label>
            <label className="field">
              max
              <input value={dMax} onChange={(event) => setDMax(event.target.value)} />
            </label>
            <label className="field">
              lim
              <input value={dLim} onChange={(event) => setDLim(event.target.value)} />
            </label>
            <pre className="hint">{suisDeployJson(dTick, dMax, dLim)}</pre>
            <button
              className="btn"
              type="button"
              disabled={!account || busy || !SUIS_PACKAGE_ID}
              onClick={() => {
                if (!requirePackage()) return;
                if (!isSuisTick(dTick) || !isPositiveUint(dMax) || !isPositiveUint(dLim)) {
                  toastApi.error('deploy 需要合法 tick、max、lim');
                  return;
                }
                const tick = dTick;
                const max = dMax;
                const lim = dLim;
                setPending({
                  title: '确认部署',
                  summary: <code>{suisDeployJson(tick, max, lim)}</code>,
                  payload: suisDeployJson(tick, max, lim),
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
        onCancel={() => {
          if (!busy) setPending(null);
        }}
        onConfirm={() => void confirmSign()}
      />
    </>
  );
}