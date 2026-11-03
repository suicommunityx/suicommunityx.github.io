import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { ConnectWalletButton } from './components/ConnectWalletButton';
import { TickList } from './components/TickList';
import { ConfirmModal } from './components/ConfirmModal';
import { FormModal } from './components/FormModal';
import { HoldersPanel } from './components/HoldersPanel';
import { Suirc20Panel } from './components/Suirc20Panel';
import type { TickInfo, MovescriptionHolding, MarketListing } from './lib/sui';
import {
  loadAllTicks,
  loadOwnedMovescriptions,
  loadFloorListings,
  buildDeployTx,
  buildMintTickNameTx,
  buildMintTx,
  buildTransferTx,
  buildSplitTransferTx,
  buildListTx,
  buildDelistTx,
  buildBuyTxTo,
  dryRun,
  friendlyRpcError,
  pinTicksFirst,
  enrichTickStartTimes,
} from './lib/sui';
import { formatAmount, formatShanghai, isValidSuiAddress, mistToSui, shortAddr } from './lib/format';
import { SITE_NAME } from './lib/constants';
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import type { Transaction } from '@mysten/sui/transactions';


type Section = 'suimint' | 'moves';
type Tab = 'suimint' | 'ticks' | 'deploy' | 'mine' | 'market' | 'holders';

const TAB_SET = new Set<Tab>(['suimint', 'ticks', 'deploy', 'mine', 'market', 'holders']);

function parseRoute(): { section: Section; tab: Tab; holdersTick: string | null } {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  if (!raw || raw === 'suimint' || raw.startsWith('suimint/')) {
    return { section: 'suimint', tab: 'suimint', holdersTick: null };
  }
  const holdersMatch = raw.match(/^holders(?:\/([^/?#]+))?$/i);
  if (holdersMatch) {
    return {
      section: 'moves',
      tab: 'holders',
      // Keep exact tick casing (suis vs SUIS)
      holdersTick: holdersMatch[1] ? decodeURIComponent(holdersMatch[1]) : null,
    };
  }
  const tab = raw.split('/')[0].toLowerCase() as Tab;
  if (tab === 'suimint') return { section: 'suimint', tab: 'suimint', holdersTick: null };
  if (TAB_SET.has(tab)) return { section: 'moves', tab, holdersTick: null };
  return { section: 'suimint', tab: 'suimint', holdersTick: null };
}

function writeRoute(tab: Tab, holdersTick?: string | null) {
  let next = '';
  if (tab === 'suimint') {
    next = '#/suimint';
  } else if (tab === 'holders') {
    next = holdersTick ? `#/holders/${encodeURIComponent(holdersTick)}` : '#/holders';
  } else if (tab !== 'ticks') {
    next = `#/${tab}`;
  } else {
    next = '#/ticks';
  }
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}


type Pending = {
  title: string;
  summary: React.ReactNode;
  build: () => Transaction;
};

export default function App() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const initialRoute = parseRoute();
  const [section, setSection] = useState<Section>(initialRoute.section);
  const [tab, setTab] = useState<Tab>(initialRoute.tab);
  const [ticks, setTicks] = useState<TickInfo[]>([]);
  const [loadingTicks, setLoadingTicks] = useState(true);
  const [selected, setSelected] = useState<TickInfo | null>(null);
  const [holdersTick, setHoldersTick] = useState<string>(
    initialRoute.holdersTick || 'SUIS',
  );
  /** Snapshot holder counts (public/holders/counts.json); no per-tick RPC. */
  const [holderCounts, setHolderCounts] = useState<Record<string, number>>({});
  const [holdings, setHoldings] = useState<MovescriptionHolding[]>([]);
  const [loadingMine, setLoadingMine] = useState(false);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [listingsError, setListingsError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // deploy form (requires burning a TICK-name Movescription)
  const [dTickObj, setDTickObj] = useState('');
  const [dSupply, setDSupply] = useState('21000000');
  const [dEpochs, setDEpochs] = useState('1000');
  const [dInitSui, setDInitSui] = useState('0');
  const [dStart, setDStart] = useState(() => String(Date.now()));
  const [dNewName, setDNewName] = useState('');
  const [dMoveObj, setDMoveObj] = useState('');

  // mint / actions
  const [mintMist, setMintMist] = useState('100000000'); // 0.1 SUI
  const [aTick, setATick] = useState('SUIS');
  const [tickQuery, setTickQuery] = useState('');

  // transfer / list
  const [xferTo, setXferTo] = useState('');
  const [xferObj, setXferObj] = useState('');
  const [xferAmt, setXferAmt] = useState(''); // empty = whole object

  /** Dedicated transfer / list sheets (我的铭文) — not always-visible page fields */
  const [xferSheet, setXferSheet] = useState<null | {
    objectId: string;
    tick: string;
    amount: bigint;
  }>(null);
  const [listSheet, setListSheet] = useState<null | {
    objectId: string;
    tick: string;
    amount: bigint;
    marketId: string;
  }>(null);
  const [sheetTo, setSheetTo] = useState('');
  const [sheetAmt, setSheetAmt] = useState('');
  const [sheetPrice, setSheetPrice] = useState('1000');
  const [sheetErr, setSheetErr] = useState<string | null>(null);

  const refreshTicks = useCallback(async (deep = false) => {
    setLoadingTicks(true);
    setErr(null);
    try {
      // Snapshot first — avoids flooding public RPC (429). Live crawl only on explicit deep refresh.
      try {
        const snap = await fetch(`${import.meta.env.BASE_URL}ticks-snapshot.json`).then((r) => r.json());
        if (snap?.ticks?.length) {
          const mapped = snap.ticks.map((x: any) => ({
            ...x,
            totalSupply: BigInt(x.totalSupply),
            currentSupply: BigInt(x.currentSupply),
            remain: BigInt(x.remain),
            mintFee: x.mintFee == null ? null : BigInt(x.mintFee),
            startTimeMs: x.startTimeMs == null ? null : BigInt(x.startTimeMs),
            totalTx: x.totalTx == null ? null : BigInt(x.totalTx),
            deployer: x.deployer || null,
          }));
          const pinned = pinTicksFirst(mapped as TickInfo[]);
          setTicks(pinned);
          setLoadingTicks(false);
          // Fill missing deploy times in background (cached)
          enrichTickStartTimes(pinned)
            .then((enriched) => setTicks(enriched))
            .catch(() => {});
          setSelected((prev) => {
            if (prev) return prev;
            const suis = mapped.find((x: any) => x.tick === 'SUIS');
            return suis || mapped[0];
          });
        }
      } catch {
        /* ignore snapshot miss */
      }
      if (deep) {
        const live = await loadAllTicks({ deep: true });
        const livePinned = await enrichTickStartTimes(pinTicksFirst(live));
        setTicks(livePinned);
        setSelected((prev) => {
          if (prev) {
            return live.find((x) => x.tick === prev.tick) || prev;
          }
          return live.find((x) => x.tick === 'SUIS') || live[0] || null;
        });
      }
    } catch (e: any) {
      setErr(friendlyRpcError(e));
    } finally {
      setLoadingTicks(false);
    }
  }, []);

  useEffect(() => {
    refreshTicks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHash = () => {
      const r = parseRoute();
      setSection(r.section);
      setTab(r.tab);
      if (r.holdersTick) {
        setHoldersTick(r.holdersTick);
        setSelected((prev) => {
          if (prev?.tick === r.holdersTick) return prev;
          const found = ticks.find((t) => t.tick === r.holdersTick);
          return found || prev;
        });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [ticks]);

  useEffect(() => {
    if (tab !== 'holders') return;
    if (!holdersTick && selected?.tick) setHoldersTick(selected.tick);
  }, [tab, holdersTick, selected]);

  const refreshMine = useCallback(async () => {
    if (!account) {
      setHoldings([]);
      return;
    }
    setLoadingMine(true);
    try {
      setHoldings(await loadOwnedMovescriptions(account.address));
    } catch (e: any) {
      setErr(friendlyRpcError(e));
    } finally {
      setLoadingMine(false);
    }
  }, [account]);

    useEffect(() => {
    if (selected?.tick) setATick(selected.tick);
  }, [selected?.tick]);

useEffect(() => {
    if (tab === 'mine' || tab === 'deploy') refreshMine();
  }, [tab, refreshMine]);

  const refreshListings = useCallback(async (marketId: string | null, bypassCache = false) => {
    if (!marketId) {
      setListings([]);
      setListingsError(null);
      return;
    }
    setLoadingListings(true);
    setListingsError(null);
    try {
      const rows = await loadFloorListings(marketId, 0, 30, { bypassCache });
      setListings(rows);
    } catch (e: any) {
      const msg = friendlyRpcError(e);
      setListingsError(msg);
      setErr(msg);
      // Keep previous listings if any; never pretend "暂无挂单" on failure
    } finally {
      setLoadingListings(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'market' && selected?.marketId) refreshListings(selected.marketId);
  }, [tab, selected, refreshListings]);

  const grouped = useMemo(() => {
    const m = new Map<string, MovescriptionHolding[]>();
    for (const h of holdings) {
      const arr = m.get(h.tick) || [];
      arr.push(h);
      m.set(h.tick, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [holdings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetch(`${import.meta.env.BASE_URL}holders/counts.json`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
        if (!cancelled && data?.counts && typeof data.counts === 'object') {
          setHolderCounts(data.counts as Record<string, number>);
        }
      } catch {
        /* optional — missing ticks show — */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredMovesTicks = useMemo(() => {
    const s = tickQuery.trim();
    if (!s) return ticks;
    return ticks.filter((t) => t.tick.toLowerCase().includes(s.toLowerCase()));
  }, [ticks, tickQuery]);

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
      // rebuild because previous build was consumed
      const tx2 = pending.build();
      const res = await signAndExecute({ transaction: tx2 });
      setToast(`交易已提交：${res.digest}`);
      setPending(null);
      await Promise.all([refreshMine(), refreshTicks()]);
      if (selected?.marketId) refreshListings(selected.marketId);
    } catch (e: any) {
      setErr(friendlyRpcError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="app-chrome">
        <header className="header">
          <div className="brand">
            <span className="logo">{SITE_NAME}</span>
            <span className="tag">Mainnet</span>
          </div>
          <div className="header-actions">
            <ConnectWalletButton connectText="连接钱包" />
          </div>
        </header>
        <nav className="tabbar tabbar-top" aria-label="主导航">
          <div className="tabbar-inner tabbar-top-inner">
            <button
              type="button"
              className={`tab-btn ${section === 'suimint' ? 'active' : ''}`}
              onClick={() => {
                setSection('suimint');
                setTab('suimint');
                writeRoute('suimint');
              }}
            >
              SuiMint
            </button>
            <button
              type="button"
              className={`tab-btn ${section === 'moves' ? 'active' : ''}`}
              onClick={() => {
                const next: Tab = section === 'suimint' || tab === 'suimint' ? 'ticks' : tab;
                setSection('moves');
                setTab(next);
                if (next === 'holders') {
                  const t = holdersTick || selected?.tick || 'SUIS';
                  setHoldersTick(t);
                  writeRoute('holders', t);
                } else {
                  writeRoute(next);
                }
              }}
            >
              Movescriptions
            </button>
          </div>
        </nav>
      </div>

      <main className="main">
        {section === 'suimint' ? (
          <Suirc20Panel />
        ) : (
          <>
        <section className="hero">
          <h1>Movescriptions</h1>
          <p className="subtitle">Movescriptions 铭文浏览器与交易面板</p>
        </section>

        <nav className="tabbar tabbar-sub" aria-label="Movescriptions 子导航">
          <div className="tabbar-inner">
            {(
              [
                ['ticks', '铭文列表'],
                ['holders', '持有者'],
                ['mine', '我的铭文'],
                ['deploy', '部署·铸造·转账'],
                ['market', '市场'],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`tab-btn ${tab === k ? 'active' : ''}`}
                onClick={() => {
                  setSection('moves');
                  setTab(k);
                  if (k === 'holders') {
                    const t = holdersTick || selected?.tick || 'SUIS';
                    setHoldersTick(t);
                    writeRoute('holders', t);
                  } else {
                    writeRoute(k);
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>

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

        {tab === 'ticks' && (
          <section className="section">
            <div className="section-head">
              <h2>铭文列表</h2>
              <div className="row gap wrap" style={{ alignItems: 'center' }}>
                <input
                  className="search-input"
                  style={{ maxWidth: 220 }}
                  placeholder="搜索 tick"
                  value={tickQuery}
                  onChange={(e) => setTickQuery(e.target.value)}
                />
                <button className="btn ghost small" onClick={() => refreshTicks(true)} disabled={loadingTicks} title="从链上刷新（可能较慢）">
                  刷新
                </button>
              </div>
            </div>
            <TickList
              ticks={filteredMovesTicks}
              loading={loadingTicks}
              selected={selected?.tick}
              holderCounts={holderCounts}
              onSelect={(t) => {
                setSelected(t);
              }}
              onView={(t) => {
                setSelected(t);
                setHoldersTick(t.tick);
                setTab('holders');
                writeRoute('holders', t.tick);
              }}
            />
            {selected && (
              <div className="card detail">
                <h3>{selected.tick}</h3>
                <dl className="grid-dl">
                  <div>
                    <dt>总量</dt>
                    <dd>{formatAmount(selected.totalSupply)}</dd>
                  </div>
                  <div>
                    <dt>已铸造</dt>
                    <dd>{formatAmount(selected.currentSupply)}</dd>
                  </div>
                  <div>
                    <dt>剩余</dt>
                    <dd>{formatAmount(selected.remain)}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatShanghai(selected.startTimeMs ?? undefined)}</dd>
                  </div>
                  <div>
                    <dt>铸造费</dt>
                    <dd>
                      {selected.mintFee == null
                        ? '—'
                        : selected.mintFee === 0n
                          ? '0 SUI'
                          : `${mistToSui(selected.mintFee)} SUI`}
                    </dd>
                  </div>
                  <div>
                    <dt>记录对象</dt>
                    <dd className="mono">{shortAddr(selected.recordId, 10)}</dd>
                  </div>
                </dl>
                <div className="row gap wrap">
                  {selected.remain === 0n ? (
                    <button className="btn" disabled>
                      已售罄，无法铸造
                    </button>
                  ) : (
                    <>
                      <label className="field inline">
                        锁定 SUI (MIST)
                        <input value={mintMist} onChange={(e) => setMintMist(e.target.value)} />
                      </label>
                      <button
                        className="btn primary"
                        disabled={!account}
                        onClick={() =>
                          ask({
                            title: `铸造 ${selected.tick}`,
                            summary: (
                              <ul className="summary">
                                <li>Tick：{selected.tick}</li>
                                <li>锁定 SUI：{mistToSui(mintMist)} SUI</li>
                                <li>剩余可铸：{formatAmount(selected.remain)}</li>
                                <li>调用：{selected.isV2 ? 'epoch_bus_factory::mint' : 'movescription::mint'}</li>
                              </ul>
                            ),
                            build: () =>
                              buildMintTx({
                                recordId: selected.recordId,
                                isV2: selected.isV2,
                                mintFactory: selected.mintFactory,
                                lockedSuiMist: BigInt(mintMist || '0'),
                              }),
                          })
                        }
                      >
                        铸造
                      </button>
                    </>
                  )}
                  {!account && <span className="hint">连接钱包后可铸造</span>}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === 'deploy' && (
          <section className="section narrow">
            <h2>钱包操作</h2>
            <p className="muted">
              Movescriptions 合约：部署用 <code>epoch_bus_factory::deploy</code>，铸造按 tick 工厂路由
              （默认 <code>epoch_bus_factory::mint</code> / 旧版 <code>movescription::mint</code>），
              转账用对象转移或 <code>movescription::do_split</code> 后转移。签名前 dry-run。
            </p>
            {!account && (
              <div className="card muted" style={{ marginBottom: 16 }}>
                <ConnectWalletButton connectText="连接钱包" />
              </div>
            )}

            <div className="card form">
              <h3>铸造</h3>
              <label className="field">
                Tick
                <select
                  className="select"
                  value={aTick}
                  onChange={(e) => {
                    setATick(e.target.value);
                    const tck = ticks.find((x) => x.tick === e.target.value);
                    if (tck) setSelected(tck);
                  }}
                >
                  {ticks.slice(0, 200).map((tck) => (
                    <option key={tck.tick} value={tck.tick}>
                      {tck.tick}
                      {tck.remain === 0n ? ' · 罄' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                锁定 SUI (MIST)
                <input value={mintMist} onChange={(e) => setMintMist(e.target.value)} />
              </label>
              {(() => {
                const tck = ticks.find((x) => x.tick === aTick) || selected;
                if (!tck) return <p className="muted">请选择 tick</p>;
                const factoryHint = tck.isV2
                  ? tck.mintFactory?.includes('mint_get')
                    ? 'mint_get_factory::mint'
                    : tck.mintFactory?.includes('mint_ratio')
                      ? 'mint_ratio_50_factory::mint_v2'
                      : 'epoch_bus_factory::mint'
                  : 'movescription::mint';
                return (
                  <p className="muted">
                    剩余 {formatAmount(tck.remain)} · 调用 {factoryHint}
                    {tck.mintFee != null ? ` · 建议锁定 ≥ ${mistToSui(tck.mintFee)} SUI` : ''}
                  </p>
                );
              })()}
              <button
                className="btn primary"
                type="button"
                disabled={!account || busy || !(ticks.find((x) => x.tick === aTick) || selected)}
                onClick={() => {
                  const tck = ticks.find((x) => x.tick === aTick) || selected;
                  if (!tck) {
                    setErr('请选择 tick');
                    return;
                  }
                  if (tck.remain === 0n) {
                    setErr('该 tick 已铸完');
                    return;
                  }
                  ask({
                    title: `铸造 ${tck.tick}`,
                    summary: (
                      <ul className="summary">
                        <li>Tick：{tck.tick}</li>
                        <li>记录：{shortAddr(tck.recordId, 10)}</li>
                        <li>锁定 SUI：{mistToSui(mintMist)} SUI</li>
                        <li>
                          调用：
                          {tck.isV2
                            ? tck.mintFactory?.includes('mint_get')
                              ? 'mint_get_factory::mint'
                              : tck.mintFactory?.includes('mint_ratio')
                                ? 'mint_ratio_50_factory::mint_v2'
                                : 'epoch_bus_factory::mint'
                            : 'movescription::mint'}
                        </li>
                      </ul>
                    ),
                    build: () =>
                      buildMintTx({
                        recordId: tck.recordId,
                        isV2: tck.isV2,
                        mintFactory: tck.mintFactory,
                        lockedSuiMist: BigInt(mintMist || '0'),
                      }),
                  });
                }}
              >
                铸造
              </button>
            </div>

            <div className="card form" style={{ marginTop: 16 }}>
              <h3>转账</h3>
              <label className="field">
                Movescription 对象 ID
                <select
                  className="select"
                  value={xferObj}
                  onChange={(e) => setXferObj(e.target.value)}
                >
                  <option value="">选择钱包中的铭文对象</option>
                  {holdings.map((h) => (
                    <option key={h.objectId} value={h.objectId}>
                      {h.tick} · {formatAmount(h.amount)} · {shortAddr(h.objectId, 8)}
                    </option>
                  ))}
                </select>
                <input
                  value={xferObj}
                  onChange={(e) => setXferObj(e.target.value.trim())}
                  placeholder="或粘贴对象 ID"
                />
              </label>
              <label className="field">
                数量（留空=整枚转移；填写则先 do_split 再转移）
                <input
                  value={xferAmt}
                  onChange={(e) => setXferAmt(e.target.value)}
                  placeholder="可选"
                />
              </label>
              <label className="field">
                收款地址
                <textarea
                  className="addr-input"
                  rows={2}
                  value={xferTo}
                  onChange={(e) => setXferTo(e.target.value.replace(/\s+/g, ''))}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button
                className="btn"
                type="button"
                disabled={!account || busy || !xferObj || !xferTo}
                onClick={() => {
                  if (!isValidSuiAddress(xferTo)) {
                    setErr('收款地址无效');
                    return;
                  }
                  const amtStr = xferAmt.trim();
                  if (amtStr) {
                    const amt = BigInt(amtStr);
                    if (amt <= 0n) {
                      setErr('拆分数量须为正整数');
                      return;
                    }
                    ask({
                      title: '拆分并转账',
                      summary: (
                        <ul className="summary">
                          <li>对象：{xferObj}</li>
                          <li>拆分数量：{formatAmount(amt)}</li>
                          <li>收款：{shortAddr(xferTo)}</li>
                          <li>调用：movescription::do_split → transferObjects</li>
                        </ul>
                      ),
                      build: () => buildSplitTransferTx(xferObj, amt, xferTo),
                    });
                    return;
                  }
                  ask({
                    title: '转账铭文对象',
                    summary: (
                      <ul className="summary">
                        <li>对象：{xferObj}</li>
                        <li>收款：{shortAddr(xferTo)}</li>
                        <li>调用：transferObjects（整枚）</li>
                      </ul>
                    ),
                    build: () => buildTransferTx(xferObj, xferTo),
                  });
                }}
              >
                转账
              </button>
            </div>

            <div className="card form" style={{ marginTop: 16 }}>
              <h3>部署新 Tick</h3>
              <p className="hint">
                使用 <code>epoch_bus_factory::deploy</code>：消耗一个 <strong>TICK</strong>{' '}
                名称铭文对象创建新 tick。
              </p>
              <label className="field">
                TICK 名称铭文对象 ID
                <select
                  className="select"
                  value={dTickObj}
                  onChange={(e) => setDTickObj(e.target.value)}
                >
                  <option value="">选择钱包中的 TICK 对象</option>
                  {holdings
                    .filter((h) => h.tick === 'TICK')
                    .map((h) => (
                      <option key={h.objectId} value={h.objectId}>
                        {h.objectId.slice(0, 10)}…{h.objectId.slice(-6)}
                      </option>
                    ))}
                </select>
                <input
                  value={dTickObj}
                  onChange={(e) => setDTickObj(e.target.value.trim())}
                  placeholder="或粘贴对象 ID"
                />
              </label>
              <label className="field">
                总供应量
                <input value={dSupply} onChange={(e) => setDSupply(e.target.value)} />
              </label>
              <label className="field">
                Epoch 数量（≥120）
                <input value={dEpochs} onChange={(e) => setDEpochs(e.target.value)} />
              </label>
              <label className="field">
                初始锁定 SUI (MIST)
                <input value={dInitSui} onChange={(e) => setDInitSui(e.target.value)} />
              </label>
              <label className="field">
                开始时间 (ms)
                <input value={dStart} onChange={(e) => setDStart(e.target.value)} />
              </label>
              <button
                className="btn primary"
                type="button"
                disabled={!account || busy || !dTickObj}
                onClick={() =>
                  ask({
                    title: '部署新铭文',
                    summary: (
                      <ul className="summary">
                        <li>TICK 名称对象：{dTickObj}</li>
                        <li>总量：{dSupply}</li>
                        <li>Epochs：{dEpochs}</li>
                        <li>初始锁定：{mistToSui(dInitSui || '0')} SUI</li>
                        <li>开始：{formatShanghai(dStart)}</li>
                        <li>调用：epoch_bus_factory::deploy</li>
                      </ul>
                    ),
                    build: () =>
                      buildDeployTx({
                        tickNameObjectId: dTickObj,
                        totalSupply: BigInt(dSupply || '0'),
                        initLockedSui: BigInt(dInitSui || '0'),
                        startTimeMs: BigInt(dStart || '0'),
                        epochCount: BigInt(dEpochs || '0'),
                      }),
                  })
                }
              >
                部署
              </button>

              <h3 style={{ marginTop: 20 }}>可选：先铸造 TICK 名称</h3>
              <p className="hint">
                <code>tick_factory::mint</code>（需锁定一枚 MOVE 铭文）。
              </p>
              <label className="field">
                新 Tick 名称
                <input
                  value={dNewName}
                  onChange={(e) => setDNewName(e.target.value.toUpperCase())}
                  maxLength={32}
                />
              </label>
              <label className="field">
                MOVE 铭文对象 ID
                <input
                  value={dMoveObj}
                  onChange={(e) => setDMoveObj(e.target.value.trim())}
                  placeholder="tick 为 MOVE 的对象"
                />
              </label>
              <button
                className="btn"
                type="button"
                disabled={!account || busy || !dNewName || !dMoveObj}
                onClick={() =>
                  ask({
                    title: `铸造 TICK 名称 ${dNewName}`,
                    summary: (
                      <ul className="summary">
                        <li>名称：{dNewName}</li>
                        <li>锁定 MOVE：{dMoveObj}</li>
                        <li>调用：tick_factory::mint</li>
                      </ul>
                    ),
                    build: () =>
                      buildMintTickNameTx({ moveObjectId: dMoveObj, tickName: dNewName }),
                  })
                }
              >
                铸造名称铭文
              </button>
            </div>
          </section>
        )}

        {tab === 'mine' && (
          <section className="section">
            <div className="section-head">
              <h2>我的铭文</h2>
              <button className="btn ghost small" onClick={refreshMine} disabled={!account || loadingMine}>
                刷新
              </button>
            </div>
            {!account && <div className="card muted">请先连接钱包</div>}
            {account && loadingMine && <div className="card muted">加载中…</div>}
            {account && !loadingMine && holdings.length === 0 && (
              <div className="card muted">当前钱包没有 Movescription 铭文对象</div>
            )}
            {grouped.map(([tick, items]) => {
              const total = items.reduce((s, x) => s + x.amount, 0n);
              const marketId = ticks.find((t) => t.tick === tick)?.marketId || null;
              return (
                <div className="card" key={tick}>
                  <div className="section-head">
                    <h3>
                      {tick}{' '}
                      <span className="muted">合计 {formatAmount(total)}</span>
                    </h3>
                  </div>
                  <ul className="obj-list">
                    {items.map((h) => (
                      <li key={h.objectId}>
                        <div>
                          <div className="mono">{shortAddr(h.objectId, 10)}</div>
                          <div className="muted">数量 {formatAmount(h.amount)}</div>
                        </div>
                        <div className="row gap wrap">
                          <button
                            className="btn small"
                            onClick={() => {
                              setSheetErr(null);
                              setSheetTo('');
                              setSheetAmt('');
                              setXferSheet({
                                objectId: h.objectId,
                                tick: h.tick,
                                amount: h.amount,
                              });
                            }}
                          >
                            转账
                          </button>
                          <button
                            className="btn small"
                            disabled={!marketId}
                            title={marketId ? '' : '该 tick 暂无已知市场'}
                            onClick={() => {
                              if (!marketId) return;
                              setSheetErr(null);
                              setSheetPrice('1000');
                              setListSheet({
                                objectId: h.objectId,
                                tick: h.tick,
                                amount: h.amount,
                                marketId,
                              });
                            }}
                          >
                            挂单
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        )}

        {tab === 'market' && (
          <section className="section">
            <div className="section-head">
              <h2>市场 {selected ? `· ${selected.tick}` : ''}</h2>
              <div className="row gap">
                <select
                  className="select"
                  value={selected?.tick || ''}
                  onChange={(e) => {
                    const t = ticks.find((x) => x.tick === e.target.value);
                    if (t) setSelected(t);
                  }}
                >
                  {pinTicksFirst(ticks.filter((t) => t.marketId)).map((t) => (
                    <option key={t.tick} value={t.tick}>
                      {t.tick}
                    </option>
                  ))}
                  {ticks.filter((t) => t.marketId).length === 0 && (
                    <option value="SUIS">SUIS</option>
                  )}
                </select>
                <button
                  className="btn ghost small"
                  disabled={!selected?.marketId || loadingListings}
                  onClick={() => selected?.marketId && refreshListings(selected.marketId, true)}
                >
                  刷新挂单
                </button>
              </div>
            </div>
            {!selected?.marketId && <div className="card muted">该铭文没有已注册的 Marketplace</div>}
            {loadingListings && <div className="card muted">加载挂单…</div>}
            {!loadingListings && listingsError && (
              <div className="card error-card">
                <p>{listingsError}</p>
                <button
                  className="btn small primary"
                  onClick={() => selected?.marketId && refreshListings(selected.marketId, true)}
                >
                  重试加载挂单
                </button>
              </div>
            )}
            {!loadingListings && !listingsError && selected?.marketId && (
              <>
              <div className="table-wrap market-table-wrap">
                <div className="scroll-hint">左右滑动查看更多 →</div>
                <table className="table market-table">
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>数量</th>
                      <th>单价 (SUI)</th>
                      <th>总价 (SUI)</th>
                      <th>卖家</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map((l) => (
                      <tr key={l.objectId}>
                        <td className="mono">{shortAddr(l.objectId, 8)}</td>
                        <td>{formatAmount(l.amount)}</td>
                        <td>{mistToSui(l.unitPrice, 6)}</td>
                        <td>{mistToSui(l.totalPrice, 4)}</td>
                        <td className="mono">{shortAddr(l.seller)}</td>
                        <td className="row gap">
                          <button
                            className="btn small primary"
                            disabled={!account}
                            onClick={() =>
                              ask({
                                title: `购买 ${selected.tick}`,
                                summary: (
                                  <ul className="summary">
                                    <li>对象：{l.objectId}</li>
                                    <li>数量：{formatAmount(l.amount)}</li>
                                    <li>单价：{mistToSui(l.unitPrice, 6)} SUI</li>
                                    <li>总价：{mistToSui(l.totalPrice, 4)} SUI</li>
                                    <li>市场费率约 2%（合约内部分配）</li>
                                  </ul>
                                ),
                                build: () =>
                                  buildBuyTxTo({
                                    marketId: selected.marketId!,
                                    objectId: l.objectId,
                                    unitPriceMist: l.unitPrice,
                                    totalPriceMist: l.totalPrice,
                                    buyer: account!.address,
                                  }),
                              })
                            }
                          >
                            购买
                          </button>
                          {account && l.seller.toLowerCase() === account.address.toLowerCase() && (
                            <button
                              className="btn small"
                              onClick={() =>
                                ask({
                                  title: '下架',
                                  summary: (
                                    <ul className="summary">
                                      <li>对象：{l.objectId}</li>
                                      <li>单价：{mistToSui(l.unitPrice, 6)} SUI</li>
                                    </ul>
                                  ),
                                  build: () =>
                                    buildDelistTx(selected.marketId!, l.objectId, l.unitPrice),
                                })
                              }
                            >
                              下架
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {listings.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted">
                          暂无挂单
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="market-cards">
                {listings.length === 0 && <div className="card muted">暂无挂单</div>}
                {listings.map((l) => (
                  <div className="market-card" key={`card-${l.objectId}`}>
                    <div className="market-card-row">
                      <span className="muted">对象</span>
                      <span className="mono">{shortAddr(l.objectId, 8)}</span>
                    </div>
                    <div className="market-card-grid">
                      <div>
                        <div className="muted">数量</div>
                        <div>{formatAmount(l.amount)}</div>
                      </div>
                      <div>
                        <div className="muted">单价</div>
                        <div>{mistToSui(l.unitPrice, 6)} SUI</div>
                      </div>
                      <div>
                        <div className="muted">总价</div>
                        <div className="price-strong">{mistToSui(l.totalPrice, 4)} SUI</div>
                      </div>
                    </div>
                    <div className="market-card-row">
                      <span className="muted">卖家</span>
                      <span className="mono">{shortAddr(l.seller)}</span>
                    </div>
                    <div className="market-card-actions">
                      <button
                        className="btn small primary"
                        disabled={!account}
                        onClick={() =>
                          ask({
                            title: `购买 ${selected.tick}`,
                            summary: (
                              <ul className="summary">
                                <li>对象：{l.objectId}</li>
                                <li>数量：{formatAmount(l.amount)}</li>
                                <li>单价：{mistToSui(l.unitPrice, 6)} SUI</li>
                                <li>总价：{mistToSui(l.totalPrice, 4)} SUI</li>
                                <li>市场费率约 2%（合约内部分配）</li>
                              </ul>
                            ),
                            build: () =>
                              buildBuyTxTo({
                                marketId: selected.marketId!,
                                objectId: l.objectId,
                                unitPriceMist: l.unitPrice,
                                totalPriceMist: l.totalPrice,
                                buyer: account!.address,
                              }),
                          })
                        }
                      >
                        购买
                      </button>
                      {account && l.seller.toLowerCase() === account.address.toLowerCase() && (
                        <button
                          className="btn small"
                          onClick={() =>
                            ask({
                              title: '下架',
                              summary: (
                                <ul className="summary">
                                  <li>对象：{l.objectId}</li>
                                  <li>单价：{mistToSui(l.unitPrice, 6)} SUI</li>
                                </ul>
                              ),
                              build: () =>
                                buildDelistTx(selected.marketId!, l.objectId, l.unitPrice),
                            })
                          }
                        >
                          下架
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              </>
            )}
          </section>
        )}

        {tab === 'holders' && (
          <HoldersPanel
            tick={holdersTick || selected?.tick || 'SUIS'}
            tickInfo={
              ticks.find((t) => t.tick === (holdersTick || selected?.tick || 'SUIS')) ||
              selected ||
              null
            }
            tickOptions={
              ticks.length
                ? pinTicksFirst(ticks).map((t) => t.tick)
                : ['SUIS', 'DGEN', 'MOVE', 'IKUN', 'GAME', 'SUIZ']
            }
            onTickChange={(t) => {
              setHoldersTick(t);
              const found = ticks.find((x) => x.tick === t);
              if (found) setSelected(found);
              writeRoute('holders', t);
            }}
          />
        )}
          </>
        )}
      </main>

      <footer className="footer">
        <p>
          <strong>{SITE_NAME}</strong> 是独立的社区前端：首页为 SuiMint SUIRC-20
          索引浏览器；Movescriptions 标签页与链上 Movescriptions / market
          合约交互。与 SuiMint、Movescriptions 官方无隶属或合作关系。
        </p>
        <p className="muted">交易由你的钱包签名发送 · Mainnet · 不托管私钥 · 无 SuiMint 市场</p>
      </footer>


      <FormModal
        open={!!xferSheet}
        title="转账铭文"
        subtitle={xferSheet ? `${xferSheet.tick} · 数量 ${formatAmount(xferSheet.amount)}` : undefined}
        busy={busy}
        onClose={() => {
          if (!busy) {
            setXferSheet(null);
            setSheetErr(null);
          }
        }}
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setXferSheet(null);
                setSheetErr(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !xferSheet || !account}
              onClick={() => {
                if (!xferSheet || !account) return;
                const to = (sheetTo.trim() || account.address).trim();
                if (!isValidSuiAddress(to)) {
                  setSheetErr('请输入合法的 0x + 64 位十六进制地址');
                  return;
                }
                const amtStr = sheetAmt.trim();
                const h = xferSheet;
                setXferSheet(null);
                setSheetErr(null);
                if (amtStr) {
                  let amt: bigint;
                  try {
                    amt = BigInt(amtStr);
                  } catch {
                    setErr('拆分数量须为正整数');
                    return;
                  }
                  if (amt <= 0n || amt > h.amount) {
                    setErr('拆分数量须大于 0 且不超过持有数量');
                    return;
                  }
                  ask({
                    title: '拆分并转账',
                    summary: (
                      <ul className="summary">
                        <li>Tick：{h.tick}</li>
                        <li>
                          对象：<span className="mono-break">{h.objectId}</span>
                        </li>
                        <li>拆分数量：{formatAmount(amt)}</li>
                        <li>
                          收款：<span className="mono-break">{to}</span>
                        </li>
                      </ul>
                    ),
                    build: () => buildSplitTransferTx(h.objectId, amt, to),
                  });
                  return;
                }
                ask({
                  title: '转账铭文',
                  summary: (
                    <ul className="summary">
                      <li>Tick：{h.tick}</li>
                      <li>
                        对象：<span className="mono-break">{h.objectId}</span>
                      </li>
                      <li>数量：{formatAmount(h.amount)}（整枚）</li>
                      <li>
                        收款：<span className="mono-break">{to}</span>
                      </li>
                    </ul>
                  ),
                  build: () => buildTransferTx(h.objectId, to),
                });
              }}
            >
              下一步
            </button>
          </>
        }
      >
        {xferSheet && (
          <>
            <div className="sheet-meta">
              <div className="sheet-meta-row">
                <span className="label">铭文</span>
                <span className="value">{xferSheet.tick}</span>
              </div>
              <div className="sheet-meta-row">
                <span className="label">数量</span>
                <span className="value">{formatAmount(xferSheet.amount)}</span>
              </div>
              <div className="sheet-meta-row">
                <span className="label">对象</span>
                <span className="value mono">{xferSheet.objectId}</span>
              </div>
            </div>
            <label className="field">
              收款地址
              <textarea
                className="addr-input"
                rows={2}
                value={sheetTo}
                onChange={(e) => setSheetTo(e.target.value.replace(/\s+/g, ''))}
                placeholder={account?.address || '0x…'}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="field-help">留空则转给当前连接的钱包（便于自测）。地址会完整换行显示，不会被裁切。</p>
            </label>
            <label className="field">
              转账数量（可选）
              <input
                value={sheetAmt}
                onChange={(e) => setSheetAmt(e.target.value)}
                placeholder={`留空=整枚 ${formatAmount(xferSheet.amount)}`}
                inputMode="numeric"
              />
              <p className="field-help">填写后会先拆分再转移；留空则转移整枚对象。</p>
            </label>
            {sheetErr && <p className="wallet-modal-err">{sheetErr}</p>}
          </>
        )}
      </FormModal>

      <FormModal
        open={!!listSheet}
        title={listSheet ? `挂单 ${listSheet.tick}` : '挂单'}
        subtitle="设置单价后确认签名"
        busy={busy}
        onClose={() => {
          if (!busy) {
            setListSheet(null);
            setSheetErr(null);
          }
        }}
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setListSheet(null);
                setSheetErr(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !listSheet || !account}
              onClick={() => {
                if (!listSheet) return;
                let unit: bigint;
                try {
                  unit = BigInt((sheetPrice || '0').trim());
                } catch {
                  setSheetErr('单价须为非负整数（MIST）');
                  return;
                }
                if (unit < 0n) {
                  setSheetErr('单价须为非负整数（MIST）');
                  return;
                }
                const h = listSheet;
                setListSheet(null);
                setSheetErr(null);
                ask({
                  title: `挂单 ${h.tick}`,
                  summary: (
                    <ul className="summary">
                      <li>
                        对象：<span className="mono-break">{h.objectId}</span>
                      </li>
                      <li>单价：{mistToSui(unit)} SUI / 单位</li>
                      <li>总价：{mistToSui(unit * h.amount)} SUI</li>
                      <li>
                        市场：<span className="mono-break">{h.marketId}</span>
                      </li>
                    </ul>
                  ),
                  build: () => buildListTx(h.marketId, h.objectId, unit),
                });
              }}
            >
              下一步
            </button>
          </>
        }
      >
        {listSheet && (
          <>
            <div className="sheet-meta">
              <div className="sheet-meta-row">
                <span className="label">铭文</span>
                <span className="value">{listSheet.tick}</span>
              </div>
              <div className="sheet-meta-row">
                <span className="label">数量</span>
                <span className="value">{formatAmount(listSheet.amount)}</span>
              </div>
              <div className="sheet-meta-row">
                <span className="label">对象</span>
                <span className="value mono">{listSheet.objectId}</span>
              </div>
            </div>
            <label className="field">
              挂单单价（MIST / 单位）
              <input
                value={sheetPrice}
                onChange={(e) => setSheetPrice(e.target.value)}
                inputMode="numeric"
                placeholder="1000"
              />
              <p className="field-help">1 SUI = 1,000,000,000 MIST。下方会实时换算总价。</p>
            </label>
            <div className="sheet-preview">
              <span>预估总价</span>
              <strong>
                {(() => {
                  try {
                    const u = BigInt((sheetPrice || '0').trim() || '0');
                    return `${mistToSui(u * listSheet.amount)} SUI`;
                  } catch {
                    return '—';
                  }
                })()}
              </strong>
            </div>
            {sheetErr && <p className="wallet-modal-err">{sheetErr}</p>}
          </>
        )}
      </FormModal>


      <ConfirmModal
        open={!!pending}
        title={pending?.title || ''}
        summary={pending?.summary}
        busy={busy}
        onCancel={() => !busy && setPending(null)}
        onConfirm={confirmSign}
      />
    </div>
  );
}
