import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit';
import type { WalletWithRequiredFeatures } from '@mysten/wallet-standard';
import { shortAddr } from '../lib/format';
import {
  CURATED_WALLETS,
  MOBILE_DEEP_LINK_WALLETS,
  findCuratedForDetected,
  isMobileUa,
  walletNameMatches,
  type CuratedWallet,
} from '../lib/wallets';

type Props = {
  connectText?: string;
};

function walletIcon(wallet: WalletWithRequiredFeatures): string | null {
  const icon = wallet.icon;
  if (!icon) return null;
  if (typeof icon === 'string') return icon;
  return null;
}

type ListRow =
  | {
      kind: 'installed';
      key: string;
      name: string;
      icon: string | null;
      fallbackLetter: string;
      wallet: WalletWithRequiredFeatures;
    }
  | {
      kind: 'install';
      key: string;
      name: string;
      iconSrc: string;
      fallbackLetter: string;
      href: string;
      meta: string;
    }
  | {
      kind: 'deeplink';
      key: string;
      name: string;
      iconSrc?: string;
      fallbackLetter: string;
      href: string;
      meta: string;
    };

function curatedFallback(c: CuratedWallet): string {
  return c.name.slice(0, 1);
}

export function ConnectWalletButton({ connectText = '连接钱包' }: Props) {
  const account = useCurrentAccount();
  const wallets = useWallets();
  const { mutateAsync: connect, isPending } = useConnectWallet();
  const { mutateAsync: disconnect } = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    setMobile(isMobileUa());
  }, []);

  const detectedNames = useMemo(() => wallets.map((w) => w.name), [wallets]);

  const rows = useMemo((): ListRow[] => {
    const out: ListRow[] = [];
    const usedDetected = new Set<string>();

    // 1) Curated wallets in preferred order — installed or install/download link
    for (const curated of CURATED_WALLETS) {
      const detected = wallets.find((w) => walletNameMatches(w.name, curated.matchNames));
      if (detected) {
        usedDetected.add(detected.name);
        out.push({
          kind: 'installed',
          key: `installed-${detected.name}`,
          name: detected.name,
          icon: walletIcon(detected),
          fallbackLetter: curatedFallback(curated),
          wallet: detected,
        });
        continue;
      }

      if (mobile) {
        const deep = MOBILE_DEEP_LINK_WALLETS.find((d) => d.id === curated.id);
        if (deep && !deep.inApp()) {
          const href = typeof window !== 'undefined' ? deep.buildUrl(window.location.href) : '#';
          out.push({
            kind: 'deeplink',
            key: `deeplink-${deep.id}`,
            name: deep.name,
            iconSrc: curated.iconSrc,
            fallbackLetter: curatedFallback(curated),
            href,
            meta: '在 App 中打开',
          });
          continue;
        }
        // Mobile, not deep-linkable: still offer official download
        out.push({
          kind: 'install',
          key: `install-${curated.id}`,
          name: curated.name,
          iconSrc: curated.iconSrc,
          fallbackLetter: curatedFallback(curated),
          href: curated.downloadUrl,
          meta: '未安装',
        });
        continue;
      }

      // Desktop: always show install row for undetected curated wallets
      out.push({
        kind: 'install',
        key: `install-${curated.id}`,
        name: curated.name,
        iconSrc: curated.iconSrc,
        fallbackLetter: curatedFallback(curated),
        href: curated.downloadUrl,
        meta: '未安装',
      });
    }

    // 2) Any other detected Wallet Standard wallets not in curated list
    for (const w of wallets) {
      if (usedDetected.has(w.name)) continue;
      if (findCuratedForDetected(w.name)) continue;
      usedDetected.add(w.name);
      out.push({
        kind: 'installed',
        key: `other-${w.name}`,
        name: w.name,
        icon: walletIcon(w),
        fallbackLetter: w.name.slice(0, 1),
        wallet: w,
      });
    }

    // 3) Mobile deep-link wallets not already covered via curated (safety)
    if (mobile) {
      const href = typeof window !== 'undefined' ? window.location.href : '';
      for (const deep of MOBILE_DEEP_LINK_WALLETS) {
        if (deep.inApp()) continue;
        if (out.some((r) => r.key === `deeplink-${deep.id}` || r.name === deep.name)) continue;
        const already = detectedNames.some((n) => walletNameMatches(n, deep.matchNames));
        if (already) continue;
        const curated = CURATED_WALLETS.find((c) => c.id === deep.id);
        out.push({
          kind: 'deeplink',
          key: `deeplink-${deep.id}`,
          name: deep.name,
          iconSrc: curated?.iconSrc,
          fallbackLetter: deep.name.slice(0, 1),
          href: deep.buildUrl(href),
          meta: '在 App 中打开',
        });
      }
    }

    return out;
  }, [wallets, mobile, detectedNames]);

  const close = useCallback(() => {
    setOpen(false);
    setErr(null);
  }, []);

  async function onPick(wallet: WalletWithRequiredFeatures) {
    setErr(null);
    try {
      await connect({ wallet });
      close();
    } catch (e: any) {
      setErr(e?.message || '连接失败');
    }
  }

  if (account) {
    return (
      <button
        type="button"
        className="wallet-chip"
        title={account.address}
        onClick={() => disconnect()}
      >
        {shortAddr(account.address)}
        <span className="wallet-chip-x" aria-hidden>
          ×
        </span>
      </button>
    );
  }

  return (
    <>
      <button type="button" className="btn wallet-connect-btn" onClick={() => setOpen(true)}>
        {connectText}
      </button>
      {open ? (
        <div className="modal-backdrop wallet-modal-backdrop" onClick={close} role="presentation">
          <div
            className="modal wallet-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wallet-modal-head">
              <h3 id="wallet-modal-title">连接钱包</h3>
              <button type="button" className="wallet-modal-close" onClick={close} aria-label="关闭">
                ×
              </button>
            </div>
            <p className="wallet-modal-hint muted">
              {mobile
                ? '已安装的钱包可直接连接；未安装时可在 App 中打开本站，或前往官方下载页。'
                : '已安装的钱包可直接连接；未安装的会打开官方扩展 / 下载页。'}
            </p>
            <ul className="wallet-list">
              {rows.map((row) => {
                if (row.kind === 'installed') {
                  return (
                    <li key={row.key}>
                      <button
                        type="button"
                        className="wallet-list-item"
                        disabled={isPending}
                        onClick={() => onPick(row.wallet)}
                      >
                        <span className="wallet-list-icon" aria-hidden>
                          {row.icon ? (
                            <img src={row.icon} alt="" width={32} height={32} />
                          ) : (
                            <span className="wallet-list-fallback">{row.fallbackLetter}</span>
                          )}
                        </span>
                        <span className="wallet-list-name">{row.name}</span>
                        <span className="wallet-list-meta muted">已安装</span>
                      </button>
                    </li>
                  );
                }

                return (
                  <li key={row.key}>
                    <a
                      className="wallet-list-item"
                      href={row.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={close}
                    >
                      <span className="wallet-list-icon" aria-hidden>
                        {row.iconSrc ? (
                          <img src={row.iconSrc} alt="" width={32} height={32} />
                        ) : (
                          <span className="wallet-list-fallback">{row.fallbackLetter}</span>
                        )}
                      </span>
                      <span className="wallet-list-name">{row.name}</span>
                      <span className="wallet-list-meta muted">{row.meta}</span>
                    </a>
                  </li>
                );
              })}
              {rows.length === 0 ? (
                <li className="wallet-list-empty muted">
                  未检测到 Sui 钱包。请安装 Slush / OKX / Bitget / Suiet 等扩展，或在手机钱包 App 内打开本站。
                </li>
              ) : null}
            </ul>
            {err ? <p className="wallet-modal-err">{err}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
