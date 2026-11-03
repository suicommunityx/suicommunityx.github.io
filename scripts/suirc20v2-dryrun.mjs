import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

const PKG = '0xcb5bd7a29f458a1b1e0221516fbfaeb182be027033eb8dcb4f33dd540d20bb87';
const GLOBAL = '0xc584d0d14cb3a020f8b1411275abc39d1a3d954a4c922d3efa9d03cba9e86ef9';
const SUIS_TICK = '0xcb3458eb5321190ef961ed27390ca12fd9ccf202b7728048969dc89ccbea837b';
const SENDER = process.env.DRYRUN_SENDER || '0x87d55d66c168e8acec2ffab46bf356d99319b3c9d6dda8fee670e8e3ee62cbeb';
const client = new SuiJsonRpcClient({ url: process.env.SUI_RPC || 'https://mainnet.suiet.app', network: 'mainnet' });

async function run(label, build) {
  const tx = build();
  tx.setSender(SENDER);
  try {
    const bytes = await tx.build({ client });
    const r = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    console.log(JSON.stringify({ label, status: r.effects?.status?.status, error: r.effects?.status?.error || null }));
  } catch (e) {
    console.log(JSON.stringify({ label, status: 'exception', error: (e.message || String(e)).slice(0, 300) }));
  }
}

await run('v2_mint_suis', () => {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.moveCall({ target: `${PKG}::suirc20::mint`, arguments: [tx.object(SUIS_TICK), tx.pure.u64(1n), coin] });
  return tx;
});

await run('v2_transfer_suis', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::suirc20::transfer`,
    arguments: [tx.pure.string('suis'), tx.pure.u64(1n), tx.pure.address(SENDER)],
  });
  return tx;
});

await run('v2_deploy_zzNav', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::suirc20::deploy`,
    arguments: [
      tx.object(GLOBAL),
      tx.pure.string('zzNav' + String(Date.now()).slice(-5)),
      tx.pure.u64(1000n),
      tx.pure.u64(10n),
      tx.pure.u64(0n),
      tx.pure.u8(0),
      tx.pure.u64(1000n),
      tx.object('0x6'),
    ],
  });
  return tx;
});
