import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

const PKG = '0xe09b37505173ae119a0ae3b1fdf9050a6b029391f9d9f10a3fff27e3f3115727';
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
    console.log(JSON.stringify({ label, status: 'exception', error: e.message || String(e) }));
  }
}

await run('mint_suis_fee0', () => {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.moveCall({
    target: `${PKG}::Operation::mint`,
    arguments: [coin, tx.pure.string(JSON.stringify({ p: 'suirc-20', op: 'mint', tick: 'suis', amt: '10000' }))],
  });
  return tx;
});

await run('transfer_suis', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::Operation::transfer`,
    arguments: [
      tx.pure.string(JSON.stringify({ p: 'suirc-20', op: 'transfer', tick: 'suis', amt: '1', to: SENDER })),
    ],
  });
  return tx;
});

await run('deploy_zzqq', () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::Operation::deploy`,
    arguments: [
      tx.pure.string(
        JSON.stringify({ p: 'suirc-20', op: 'deploy', tick: 'zzqq', max: '1000', lim: '10', fee: '0', freq: '10' }),
      ),
    ],
  });
  return tx;
});
