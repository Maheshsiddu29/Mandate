/**
 * Load the human-deployed V3 Gate address from the separate live evidence
 * file. Never reads the frozen V2 robinhood-testnet.json Gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const V3_LIVE_MANIFEST_PATH = join(REPO, 'contracts', 'deploy', 'robinhood-testnet-delegated-live.json');

export type LiveV3GateLoad =
  | {
      readonly ok: true;
      readonly gate: string;
      readonly chainId: number;
      readonly deploymentTx: string | null;
      readonly runtimeCodeHash: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** Trusted live V3 Gate from deployment evidence. Refuses unknown/mainnet chains. */
export function loadLiveV3Gate(path: string = V3_LIVE_MANIFEST_PATH): LiveV3GateLoad {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { ok: false, reason: 'V3 live deployment evidence is not readable' };
  }
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'V3 live deployment evidence is malformed' };
  const o = raw as { chainId?: unknown; gate?: unknown; gateKind?: unknown; deploymentTx?: unknown; runtimeCodeHash?: unknown };
  if (o.chainId !== 46_630) return { ok: false, reason: 'V3 live deployment evidence must name chain 46630' };
  if (o.gateKind !== undefined && o.gateKind !== 'MandateDelegatedExecutionGate') {
    return { ok: false, reason: 'V3 live deployment evidence gateKind mismatch' };
  }
  if (typeof o.gate !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.gate)) {
    return { ok: false, reason: 'V3 live deployment evidence gate address missing' };
  }
  return {
    ok: true,
    gate: o.gate.toLowerCase(),
    chainId: 46_630,
    deploymentTx: typeof o.deploymentTx === 'string' ? o.deploymentTx.toLowerCase() : null,
    runtimeCodeHash: typeof o.runtimeCodeHash === 'string' ? o.runtimeCodeHash.toLowerCase() : null,
  };
}
