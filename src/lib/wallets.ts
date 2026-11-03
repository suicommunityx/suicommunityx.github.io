/** Preferred order in connect modal; any other Wallet Standard Sui wallet follows. */
export const PREFERRED_WALLETS = [
  'Slush',
  'OKX Wallet',
  'Bitget Wallet',
  'Suiet',
  'Nightly',
  'Surf',
] as const;

export function isMobileUa(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /iphone|ipad|ipod|ios|android|XiaoMi|MiuiBrowser/i.test(ua);
}

export function isOkxInApp(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /OKApp/i.test(ua);
}

export function isBitgetInApp(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /BitKeep|Bitget/i.test(ua);
}

/**
 * Official OKX universal link (docs: web3.okx.com … app-universal-link):
 * okx://wallet/dapp/url?dappUrl=<encoded>
 * wrapped as https://web3.okx.com/download?deeplink=<encoded deep link>
 */
export function okxDappOpenUrl(dappUrl: string): string {
  const deepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(dappUrl)}`;
  return `https://web3.okx.com/download?deeplink=${encodeURIComponent(deepLink)}`;
}

/**
 * Official Bitget BKConnect open-dapp (docs: web3.bitget.com … configuration/deeplink):
 * https://bkcode.vip?action=dapp&url=<url> (Android-supported universal form)
 * also bitkeep://bkconnect?action=dapp&url=<url>
 */
export function bitgetDappOpenUrl(dappUrl: string): string {
  return `https://bkcode.vip?action=dapp&url=${encodeURIComponent(dappUrl)}`;
}

export type DeepLinkWallet = {
  id: string;
  /** Display name in our modal */
  name: string;
  /** Wallet Standard names that mean "already injected" */
  matchNames: string[];
  buildUrl: (dappUrl: string) => string;
  /** Skip deep-link row when already inside that app */
  inApp: () => boolean;
};

/** Only wallets with official documented “open dApp URL” deep links. */
export const MOBILE_DEEP_LINK_WALLETS: DeepLinkWallet[] = [
  {
    id: 'okx',
    name: 'OKX Wallet',
    matchNames: ['OKX Wallet', 'OKX'],
    buildUrl: okxDappOpenUrl,
    inApp: () => isOkxInApp(),
  },
  {
    id: 'bitget',
    name: 'Bitget Wallet',
    matchNames: ['Bitget Wallet', 'Bitget', 'BitKeep', 'BitKeep Wallet'],
    buildUrl: bitgetDappOpenUrl,
    inApp: () => isBitgetInApp(),
  },
];

/**
 * Curated popular Sui wallets always shown on desktop (and as install fallbacks on mobile).
 * Phantom omitted: official docs say Sui support ended 2026-09-24.
 * Suiet still listed while Chrome extension remains available (API sunset after 2026-11-14).
 * downloadUrl values are official Chrome Web Store / vendor download pages (verified 2026-11-03).
 */
export type CuratedWallet = {
  id: string;
  name: string;
  matchNames: string[];
  /** Official extension / download page */
  downloadUrl: string;
  /** Local fallback icon under /wallet-icons (no hotlinking) */
  iconSrc: string;
};

export const CURATED_WALLETS: CuratedWallet[] = [
  {
    id: 'slush',
    name: 'Slush',
    matchNames: ['Slush', 'Sui Wallet'],
    downloadUrl:
      'https://chromewebstore.google.com/detail/slush-%E2%80%94-a-sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil',
    iconSrc: '/wallet-icons/slush.svg',
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    matchNames: ['OKX Wallet', 'OKX'],
    downloadUrl: 'https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge',
    iconSrc: '/wallet-icons/okx.svg',
  },
  {
    id: 'bitget',
    name: 'Bitget Wallet',
    matchNames: ['Bitget Wallet', 'Bitget', 'BitKeep', 'BitKeep Wallet'],
    downloadUrl:
      'https://chromewebstore.google.com/detail/bitget-wallet-crypto-web3/jiidiaalihmmhddjgbnbgdfflelocpak',
    iconSrc: '/wallet-icons/bitget.svg',
  },
  {
    id: 'suiet',
    name: 'Suiet',
    matchNames: ['Suiet', 'Suiet Wallet'],
    downloadUrl: 'https://chromewebstore.google.com/detail/suiet-sui-wallet/khpkpbbcccdmmclmpigdgddabeilkdpd',
    iconSrc: '/wallet-icons/suiet.svg',
  },
  {
    id: 'nightly',
    name: 'Nightly',
    matchNames: ['Nightly', 'Nightly Wallet'],
    downloadUrl: 'https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa',
    iconSrc: '/wallet-icons/nightly.svg',
  },
  {
    id: 'surf',
    name: 'Surf',
    matchNames: ['Surf', 'Surf Wallet'],
    downloadUrl: 'https://chromewebstore.google.com/detail/surf-wallet/emeeapjkbcbpbpgaagfchmcgglmebnen',
    iconSrc: '/wallet-icons/surf.svg',
  },
];

export function walletNameMatches(walletName: string, matchNames: string[]): boolean {
  const n = walletName.trim().toLowerCase();
  return matchNames.some((m) => m.trim().toLowerCase() === n || n.includes(m.trim().toLowerCase()));
}

export function findCuratedForDetected(walletName: string): CuratedWallet | undefined {
  return CURATED_WALLETS.find((c) => walletNameMatches(walletName, c.matchNames));
}
