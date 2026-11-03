import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { registerSlushWallet } from '@mysten/slush-wallet';
import '@mysten/dapp-kit/dist/index.css';
import './index.css';
import App from './App';
import { NETWORK, SITE_NAME } from './lib/constants';
import { client } from './lib/rpc';
import { PREFERRED_WALLETS } from './lib/wallets';

try {
  registerSlushWallet(SITE_NAME, {
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  });
} catch {
  /* already registered / unsupported env */
}

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={{ [NETWORK]: client }} defaultNetwork={NETWORK}>
        <WalletProvider autoConnect preferredWallets={[...PREFERRED_WALLETS]}>
          <App />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
