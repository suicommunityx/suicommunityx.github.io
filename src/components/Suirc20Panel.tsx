import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import type { Transaction } from '@mysten/sui/transactions';
import { ConfirmModal } from './ConfirmModal';
import { formatAmount, isValidSuiAddress, shortAddr } from '../lib/format';
import { dryRun, friendlyRpcError } from '../lib/sui';
import {
  buildSuirc20DeployTx,
  buildSuirc20MintTx,
  buildSuirc20TransferTx,
  buildSuirc20V2DeployTx,
  buildSuirc20V2MintTx,
  buildSuirc20V2TransferTx,
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

export function Suirc20Panel() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [sub, setSub] = useState<SubTab>('list');
  const [meta, setMeta] = useState<Suirc20Meta | null>(null);
  const [ticks, setTicks] = useState<Suirc20Tick[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Suirc20Tick | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await loadSuirc20Ticks();
      setMeta(data.meta);
      setTicks(data.ticks);
      setSelected((prev) => {
        if (prev) return data.ticks.find((t) => t.tick === prev.tick) || prev;
        return data.ticks.find((t) => t.tick === 'suis') || data.ticks[0] || null;
      });
    } catch (e: any) {
      setErr(friendlyRpcError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const s = q.trim();
    if (!s) return ticks;
    return ticks.filter((t) => t.tick.toLowerCase().includes(s.toLowerCase()));
  }, [ticks, q]);

  const loadHolders = useCallback(async (tick: string, preferV2 = false) => {
    setLoadingHolders(true);
    setErr(null);
    try {
      const data = await loadSuirc20Holders(tick, preferV2);
      setHolders(data.holders || []);
      setHoldersTotal(data.totalHolders || data.holders?.length || 0);
      setHolderPage(0);
    } catch (e: any) {
      setHolders([]);
      setHoldersTotal(0);
      setErr(friendlyRpcError(e));
    } finally {
      setLoadingHolders(false);
    }
  }, []);

  useEffect(() => {
    if (sub === 'holders' && selected) loadHolders(selected.tick, selected.version === 'v2');
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
      setErr(friendlyRpcError(e));
    } finally {
      setLoadingMine(false);
    }
  }, [account]);

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
    setErr(null);
    setPending(p);
  }

  async function confirmSign() {
    if (!pending || !account) return;
    setBusy(true);
    setErr(null);
    try {
      const tx = pending.build();
      tx.setSender(account.address);
      const dr = await dryRun(tx, account.address);
      if (dr.status !== 'success') {
        throw new Error(dr.error || '链上模拟失败，已取消签名');
      }
      const tx2 = pending.build();
      const res = await signAndExecute({ transaction: tx2 });
      setToast(`交易已提交：${res.digest}`);
      setPending(null);
      await Promise.all([refreshMine(), refresh()]);
    } catch (e: any) {
      setErr(friendlyRpcError(e));
    } finally {
      setBusy(false);
    }
  }

  const feeForTick = (tickName: string) => {
    const t = ticks.find((x) => x.tick === tickName);
    return t ? BigInt(t.fee || '0') : 0n;
  };

  return (
    <>
      <section className="hero">
        <h1>SuiMint</h1>
        <p className="subtitle">SUIRC-20 · Operation 见证 + 链上新版 · 无市场</p>
      </section>

      {meta && (
        <div className="banner ok" style={{ cursor: 'default' }}>
          {meta.progressLabel}
          {meta.tickCount != null ? ` · 合并 ${meta.tickCount} ticks` : ''}
          {meta.v2?.tickCount != null ? ` · 新版链上 ${meta.v2.tickCount}` : ''}
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            {meta.cb5Note ||
              '余额来自本站索引；同名 tick 优先显示链上新版并标「新版」。不包含信任最小化市场。'}
          </div>
        </div>
      )}

      {err && (
        <div className="banner error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}
      {toast && (
        <div className="banner ok" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      <div className="tabbar-inner" style={{ paddingLeft: 0, marginBottom: 8 }}>
        {(
          [
            ['list', '铭文列表'],
            ['holders', '持有者'],
            ['mine', '我的铭文'],
            ['actions', '部署 / 铸造 / 转账'],
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
        <button type="button" className="btn ghost small" onClick={() => refresh()} disabled={loading}>
          刷新索引
        </button>
      </div>

      {sub === 'list' && (
        <section className="section">
          <div className="section-head">
            <h2>铭文列表</h2>
            <input
              
              className="search-input" style={{ maxWidth: 220 }}
              placeholder="搜索 tick"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {loading ? (
            <div className="card muted">加载中…</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tick</th>
                    <th>进度</th>
                    <th>已铸造</th>
                    <th>上限</th>
                    <th>单次限额</th>
                    <th>持有者</th>
                    <th>部署时间</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr
                      key={t.tick}
                      className={selected?.tick === t.tick ? 'selected' : ''}
                      onClick={() => setSelected(t)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <strong>{t.tick}</strong>
                        {t.badge ? <span className="tag v2">{t.badge}</span> : null}
                        {t.tick === 'suis' || t.tick === 'dgen' ? (
                          <span className="tag" style={{ marginLeft: 6 }}>
                            置顶
                          </span>
                        ) : null}
                      </td>
                      <td>{t.progress.toFixed(2)}%</td>
                      <td>{formatAmount(BigInt(t.minted))}</td>
                      <td>{formatAmount(BigInt(t.max))}</td>
                      <td>{formatAmount(BigInt(t.lim))}</td>
                      <td>{t.holderCount}</td>
                      <td className="muted">{t.deployTimeBeijing || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <div className="card detail">
              <h3>
                {selected.tick}
                {selected.badge ? <span className="tag v2">{selected.badge}</span> : null}
              </h3>
              <dl className="grid-dl">
                <div>
                  <dt>Max</dt>
                  <dd>{formatAmount(BigInt(selected.max))}</dd>
                </div>
                <div>
                  <dt>Lim</dt>
                  <dd>{formatAmount(BigInt(selected.lim))}</dd>
                </div>
                <div>
                  <dt>Fee (MIST)</dt>
                  <dd>{selected.fee}</dd>
                </div>
                <div>
                  <dt>Decimals</dt>
                  <dd>{selected.dec}</dd>
                </div>
                <div>
                  <dt>已铸造</dt>
                  <dd>
                    {formatAmount(BigInt(selected.minted))}（{selected.mintCount} 次）
                  </dd>
                </div>
                <div>
                  <dt>持有者</dt>
                  <dd>{selected.holderCount}</dd>
                </div>
                <div>
                  <dt>部署者</dt>
                  <dd title={selected.deployer}>{shortAddr(selected.deployer)}</dd>
                </div>
                <div>
                  <dt>部署时间</dt>
                  <dd>{selected.deployTimeBeijing}</dd>
                </div>
              </dl>
              <div className="row-actions" style={{ marginTop: 12 }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setATick(selected.tick);
                    setSub('actions');
                  }}
                >
                  去铸造 / 转账
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setSub('holders');
                  }}
                >
                  查看持有者
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {sub === 'holders' && (
        <section className="section">
          <div className="section-head">
            <h2>持有者 · {selected?.tick || '—'}</h2>
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
                        <td>{formatAmount(BigInt(h.balance))}</td>
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
            {!account && <ConnectButton connectText="连接钱包" />}
            {account && (
              <button className="btn ghost small" type="button" onClick={refreshMine} disabled={loadingMine}>
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
                      <td>{formatAmount(BigInt(r.balance))}</td>
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
            默认按所选 tick 版本调用：旧版 <code>Operation::*</code>，新版{' '}
            <code>suirc20::deploy/mint/transfer</code>（包 cb5…）。签名前 dry-run。
          </p>
          {!account && (
            <div className="card muted" style={{ marginBottom: 16 }}>
              <ConnectButton connectText="连接钱包" />
            </div>
          )}

          <div className="card">
            <h3>铸造</h3>
            <label className="field">Tick（区分大小写）
              <input value={aTick} onChange={(e) => setATick(e.target.value)} /></label>
            <label className="field">数量 amt
              <input value={aAmt} onChange={(e) => setAAmt(e.target.value)} /></label>
            <p className="muted">
              Mint fee：{feeForTick(aTick).toString()} MIST
              {(() => {
                const t = ticks.find((x) => x.tick === aTick);
                return t?.version === 'v2' ? ' · 新版 suirc20::mint' : ' · 旧版 Operation::mint';
              })()}
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
                if (t?.version === 'v2') {
                  if (!t.tickId) {
                    setErr('该新版 tick 缺少 tickId，无法铸造');
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
                  title: '确认铸造',
                  summary: (
                    <>
                      mint <strong>{tick}</strong> amt={amt} fee={fee.toString()} MIST
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
            <label className="field">Tick
              <input value={aTick} onChange={(e) => setATick(e.target.value)} /></label>
            <label className="field">数量
              <input value={aAmt} onChange={(e) => setAAmt(e.target.value)} /></label>
            <label className="field">收款地址 to
              <input value={aTo} onChange={(e) => setATo(e.target.value)} placeholder="0x…" /></label>
            <button
              className="btn"
              type="button"
              disabled={!account || busy}
              onClick={() => {
                if (!isValidSuiAddress(aTo)) {
                  setErr('收款地址无效');
                  return;
                }
                const tick = aTick;
                const amt = aAmt;
                const to = aTo;
                const t = ticks.find((x) => x.tick === tick);
                if (t?.version === 'v2') {
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
                  title: '确认转账',
                  summary: (
                    <>
                      transfer <strong>{tick}</strong> amt={amt} → {shortAddr(to)}
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
            <label className="field">tick
              <input value={dTick} onChange={(e) => setDTick(e.target.value)} /></label>
            <label className="field">max
              <input value={dMax} onChange={(e) => setDMax(e.target.value)} /></label>
            <label className="field">lim
              <input value={dLim} onChange={(e) => setDLim(e.target.value)} /></label>
            <label className="field">fee (MIST)
              <input value={dFee} onChange={(e) => setDFee(e.target.value)} /></label>
            <label className="field">freq
              <input value={dFreq} onChange={(e) => setDFreq(e.target.value)} /></label>
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
                // Prefer Operation witness deploy for new names; offer v2 when tick already exists as v2 only via actions note.
                ask({
                  title: '确认部署（Operation）',
                  summary: <code>{JSON.stringify(payload)}</code>,
                  build: () => buildSuirc20DeployTx(payload),
                });
              }}
            >
              部署（旧版 Operation）
            </button>
            <button
              className="btn ghost"
              type="button"
              style={{ marginTop: 10 }}
              disabled={!account || busy}
              onClick={() => {
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
