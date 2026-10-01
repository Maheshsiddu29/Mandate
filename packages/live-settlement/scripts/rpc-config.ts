/**
 * The settlement commands' RPC configuration — the only script in this
 * package that reads the environment (docs/demo/wallet-settlement-boundaries.md §6).
 *
 *   ROBINHOOD_TESTNET_RPC_URL       optional: an operator QuickNode Robinhood Chain testnet endpoint,
 *                                   https://<name>.quiknode.pro/<token>/. Absent: the public RPC.
 *   ROBINHOOD_TESTNET_RPC_FALLBACK  "public" (default) or "none": whether reads fall back to the public
 *                                   RPC on a transport failure of the QuickNode endpoint. A send never does.
 *   ROBINHOOD_MAINNET_RPC_URL       never used: mainnet is a later milestone. Set or not, it is ignored.
 *
 * The URL carries the endpoint's credential, so it is never printed, logged
 * or emitted: callers report `label` only. Provider choice is infrastructure
 * and never authority.
 */

import { isQuickNodeHost } from '@mandate/evm-robinhood';
import type { RpcEndpoints } from '../src/index.ts';

export type RpcConfig = { readonly ok: true; readonly endpoints: RpcEndpoints; readonly label: string; readonly notes: readonly string[] } | { readonly ok: false; readonly error: string };

export function readRpcConfig(env: { readonly [k: string]: string | undefined } = process.env): RpcConfig {
  const notes: string[] = [];
  if ((env['ROBINHOOD_MAINNET_RPC_URL'] ?? '').trim() !== '') notes.push('ROBINHOOD_MAINNET_RPC_URL is set and ignored: no mainnet path exists in this milestone.');
  const fallback = (env['ROBINHOOD_TESTNET_RPC_FALLBACK'] ?? 'public').trim();
  if (fallback !== 'public' && fallback !== 'none') return { ok: false, error: 'ROBINHOOD_TESTNET_RPC_FALLBACK must be "public" or "none".' };
  const raw = (env['ROBINHOOD_TESTNET_RPC_URL'] ?? '').trim();
  if (raw === '') return { ok: true, endpoints: { quicknode: null, publicFallback: false }, label: 'public Robinhood Chain testnet RPC', notes };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'ROBINHOOD_TESTNET_RPC_URL is not a URL (its value is not printed).' };
  }
  if (u.protocol === 'https:' && u.hostname === 'rpc.testnet.chain.robinhood.com') return { ok: true, endpoints: { quicknode: null, publicFallback: false }, label: 'public Robinhood Chain testnet RPC', notes };
  if (u.protocol !== 'https:' || !isQuickNodeHost(u.hostname)) return { ok: false, error: 'ROBINHOOD_TESTNET_RPC_URL must be an https QuickNode endpoint (*.quiknode.pro) or the public testnet RPC; its value is not printed.' };
  return { ok: true, endpoints: { quicknode: u.toString(), publicFallback: fallback === 'public' }, label: `QuickNode (operator endpoint)${fallback === 'public' ? ' · public RPC read fallback' : ''}`, notes };
}
