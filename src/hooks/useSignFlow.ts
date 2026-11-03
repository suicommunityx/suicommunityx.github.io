import { useState } from 'react';
import { useSignAndExecuteTransaction, useCurrentAccount } from '@mysten/dapp-kit';
import type { Transaction } from '@mysten/sui/transactions';
import { dryRun } from '../lib/sui';
import { friendlyRpcError } from '../lib/rpc';

export function useSignFlow() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  async function run(tx: Transaction, opts?: { skipDryRun?: boolean }) {
    if (!account) throw new Error('请先连接钱包');
    setBusy(true);
    setError(null);
    setLastDigest(null);
    try {
      tx.setSender(account.address);
      if (!opts?.skipDryRun) {
        const dr = await dryRun(tx, account.address);
        if (dr.status !== 'success') {
          throw new Error(dr.error || '模拟执行失败');
        }
        // rebuild fresh tx after dry-run consumed build
      }
      const result = await signAndExecute({ transaction: tx });
      setLastDigest(result.digest);
      return result;
    } catch (e: any) {
      const msg = friendlyRpcError(e);
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, error, lastDigest, setError, account };
}
