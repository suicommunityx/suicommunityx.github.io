/** Preferred order in connect modal; any other Wallet Standard Sui wallet follows. */
export const PREFERRED_WALLETS = [
  'Slush',
  'OKX Wallet',
  'Bitget Wallet',
  'Suiet',
  'Nightly',
  'Phantom',
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

export function walletNameMatches(walletName: string, matchNames: string[]): boolean {
  const n = walletName.trim().toLowerCase();
  return matchNames.some((m) => m.trim().toLowerCase() === n || n.includes(m.trim().toLowerCase()));
}
