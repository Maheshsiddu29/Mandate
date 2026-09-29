/**
 * The Robinhood gate signer's adapter descriptor and `AdapterRef`
 * (Phase 7E.3; enforcement-adapters.md §2).
 *
 * The `adapterDigest` content-addresses everything that decides what the
 * adapter does with an authorization: the chain, the exact deployed gate —
 * address, runtime code hash and EIP-712 domain separator — and every
 * reviewed market it serves, the one call it makes (`execute`), the artifact
 * it commits (the gate's execution commitment), how it allocates the gate
 * mandate's nonce, its finality ladder and release level, and its submission
 * and resubmission policy.
 *
 * An `ExecutionAuthorization`, every `ADMIT_ATTEMPT` and — through the gate
 * mandate's `mandateId` (gate.ts) — the principal's onchain signature bind
 * this exact ref. A new gate, another market set, a different submission
 * policy is a different adapter: it cannot issue under an authorization made
 * for this one (`ADAPTER_MISMATCH`), and a gate mandate signed for this one
 * names this digest (DOM-2 applied to adapters).
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, validateAdapterRef, writeDigest, type AdapterRef, type AdapterRefInput } from '@mandate/core';
import { encodeGateMarket } from './vocabulary.ts';
import { reviewedSnapshot, type ReviewedGate } from './market.ts';

export const ADAPTER_ID = 'robinhood-gate-signer';
export const ADAPTER_VERSION = 1;

/** The only artifact this adapter creates: `hashStruct(ExecutionAuthorization)` under the gate's domain. */
export const ARTIFACT_KIND = 'evm.gate-execution-commitment';

/** `execute(Mandate,bytes,Candidate,ExecutionTerms,bytes)`, the gate's one entry point. */
export const EXECUTE_SELECTOR = '0x783f1d00';

export const FINALITY_LADDER = ['LATEST', 'SAFE', 'FINALIZED'] as const;
/** Nothing is released below this level (execution-gate.md §12); releases are 7F's. */
export const RELEASE_LEVEL = 'FINALIZED';

/** The frozen Phase 6 source the deployed gate was compiled from. */
export const GATE_SOURCE = { phase6Commit: 'dc98df5', solc: '0.8.37', evmVersion: 'cancun', optimizerRuns: 200, viaIr: true, bytecodeHash: 'none' } as const;

export interface GateAdapterConfig {
  readonly gate: ReviewedGate;
  /** keccak-256 of the gate's deployed runtime code. */
  readonly gateCodehash: string;
  /** The gate's `domainSeparator()`: `{Mandate, 1, chainId, gate}`. */
  readonly domainSeparator: string;
}

export function adapterManifest(c: GateAdapterConfig): Uint8Array {
  const g = c.gate;
  const w = new ByteWriter().str('mandate/evm-robinhood/adapter-manifest').u16(1);
  w.str(ADAPTER_ID).u32(ADAPTER_VERSION).u64(g.chainId).str(g.gate).str(c.gateCodehash).str(c.domainSeparator);
  w.str(GATE_SOURCE.phase6Commit).str(GATE_SOURCE.solc).str(GATE_SOURCE.evmVersion).u32(GATE_SOURCE.optimizerRuns).u8(GATE_SOURCE.viaIr ? 1 : 0).str(GATE_SOURCE.bytecodeHash);
  const markets = [...g.markets].sort((a, b) => (a.representation < b.representation ? -1 : 1));
  w.u16(markets.length);
  for (const m of markets) writeDigest(w, keccakDigest(encodeGateMarket(reviewedSnapshot(g.chainId, g.gate, m))));
  w.str(EXECUTE_SELECTOR).str(`artifact:${ARTIFACT_KIND}`);
  // The gate mandate's nonce is this principal's slot sequence on this gate; the gate's replay key is the mandate digest.
  w.str('slot:principal-gate-nonce').str('recipient:principal-only').str('execution-data:empty');
  w.str('pre-execution:CREDENTIAL_SCOPE').str('pre-execution:NONCE_SLOT');
  for (const l of FINALITY_LADDER) w.str(l);
  w.str(RELEASE_LEVEL);
  // No fresh attempt after admission: an admitted, signed artifact may still land (execution-gate.md §9).
  w.str('submission:signer-owned').str('preflight:eth_call').str('resubmission:none');
  return w.finish();
}

export function gateAdapterRefInput(c: GateAdapterConfig): AdapterRefInput {
  return { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, adapterDigest: keccakDigest(adapterManifest(c)) };
}

export function gateAdapterRef(c: GateAdapterConfig): AdapterRef {
  const r = validateAdapterRef(gateAdapterRefInput(c));
  if (!r.ok) throw new Error(`adapter ref invalid: ${r.error.code}`);
  return r.value;
}
