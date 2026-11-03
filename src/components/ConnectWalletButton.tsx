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
  MOBILE_DEEP_LINK_WALLETS,
  isMobileUa,
  walletNameMatches,
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

  const deepLinkRows = useMemo(() => {
    if (!mobile) return [];
    const href = typeof window !== 'undefined' ? window.location.href : '';
    return MOBILE_DEEP_LINK_WALLETS.filter((w) => {
      if (w.inApp()) return false;
      const already = detectedNames.some((n) => walletNameMatches(n, w.matchNames));
      return !already;
    }).map((w) => ({ ...w, url: w.buildUrl(href) }));
  }, [mobile, detectedNames]);

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
              检测到的 Sui 钱包会自动列出；未安装扩展时可在手机上用 App 打开本站。
            </p>
            <ul className="wallet-list">
              {wallets.map((w) => {
                const icon = walletIcon(w);
                return (
                  <li key={w.name}>
                    <button
                      type="button"
                      className="wallet-list-item"
                      disabled={isPending}
                      onClick={() => onPick(w)}
                    >
                      <span className="wallet-list-icon" aria-hidden>
                        {icon ? (
                          <img src={icon} alt="" width={32} height={32} />
                        ) : (
                          <span className="wallet-list-fallback">{w.name.slice(0, 1)}</span>
                        )}
                      </span>
                      <span className="wallet-list-name">{w.name}</span>
                      <span className="wallet-list-meta muted">已安装</span>
                    </button>
                  </li>
                );
              })}
              {deepLinkRows.map((w) => (
                <li key={`deeplink-${w.id}`}>
                  <a
                    className="wallet-list-item"
                    href={w.url}
                    rel="noopener noreferrer"
                    onClick={close}
                  >
                    <span className="wallet-list-icon" aria-hidden>
                      <span className="wallet-list-fallback">{w.name.slice(0, 1)}</span>
                    </span>
                    <span className="wallet-list-name">{w.name}</span>
                    <span className="wallet-list-meta muted">在 App 中打开</span>
                  </a>
                </li>
              ))}
              {wallets.length === 0 && deepLinkRows.length === 0 ? (
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
