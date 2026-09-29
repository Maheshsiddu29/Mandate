/**
 * The gate-market state reader (Phase 7E.3).
 *
 * Reads every reviewed market of the deployed gate at **one** block — its
 * market-table entry, the venue it created and that venue's fee — and wraps
 * each as an `evm.gate-market` state envelope for Control, observed at that
 * block's timestamp. GateSpotPolicy pins each payload to its reviewed record,
 * so a chain that disagrees with the review is refused at admission; any
 * failed read makes the whole read `UNKNOWN`, which admits nothing.
 */

import { validateStateEnvelope, type StateSourceId } from '@mandate/core';
import { statePayloadDigest, type SuppliedState } from '@mandate/control';
import type { ChainClient, BlockRef } from './chain.ts';
import type { GateSpotPolicy } from './policy.ts';
import { BLOCK_LADDER } from './policy.ts';
import { STATE_GATE_MARKET, encodeGateMarket, marketResource, representationIdOf, type GateMarketSnapshot } from './vocabulary.ts';

export type GateStateRead =
  | { readonly status: 'OK'; readonly block: BlockRef; readonly states: readonly SuppliedState[]; readonly snapshots: readonly GateMarketSnapshot[] }
  | { readonly status: 'UNKNOWN'; readonly reason: string };

/** A state envelope for one snapshot, as the policy's configured source observed it at `observedAt`. */
export function gateMarketState(policy: GateSpotPolicy, snapshot: GateMarketSnapshot, observedAt: bigint, source: StateSourceId = policy.config.sources.gateMarket): SuppliedState {
  const ref = policy.ref;
  const payload = encodeGateMarket(snapshot);
  const env = validateStateEnvelope({
    module: { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest },
    stateKind: STATE_GATE_MARKET,
    subject: marketResource(snapshot.chainId, snapshot.representation),
    sourceId: source,
    trustClass: 'VERIFIED',
    observedAt,
    sequence: { kind: 'NONE' },
    validUntil: null,
    finality: { ladder: BLOCK_LADDER.ladder, level: 'LATEST' },
    payloadDigest: statePayloadDigest(ref, payload),
  });
  if (!env.ok) throw new Error(`gate-market envelope invalid: ${env.error.code} at ${env.error.path}`);
  return { envelope: env.value, payload };
}

export async function readGateMarkets(chain: ChainClient, policy: GateSpotPolicy): Promise<GateStateRead> {
  const g = policy.config.gate;
  const block = await chain.block('latest');
  if (!block.ok) return { status: 'UNKNOWN', reason: `BLOCK.${block.error}` };
  const snapshots: GateMarketSnapshot[] = [];
  for (const m of g.markets) {
    const s = await chain.gateMarket(g.gate, representationIdOf(g.chainId, m.representation), block.value.number);
    if (!s.ok) return { status: 'UNKNOWN', reason: `MARKET.${s.error}` };
    snapshots.push(s.value);
  }
  return { status: 'OK', block: block.value, snapshots, states: snapshots.map((s) => gateMarketState(policy, s, block.value.timestamp)) };
}
