/**
 * The gate-market state reader (Phase 7E.3).
 *
 * Reads every reviewed market of the deployed gate at **one** block — its
 * market-table entry, the venue it created and that venue's fee — and wraps
 * each as an `evm.gate-market` state envelope for Control, observed at that
 * block's timestamp. GateSpotPolicy pins each payload to its reviewed record,
 * so a chain that disagrees with the review is refused at admission; any
 * failed read makes the whole read `UNKNOWN`, which admits nothing. A node
 * that has not reached the pinned block yet is waited for, boundedly, at that
 * same block (`PINNED_REREADS`).
 */

import { validateStateEnvelope, type StateSourceId } from '@mandate/core';
import { statePayloadDigest, type SuppliedState } from '@mandate/control';
import { pause, type ChainClient, type BlockRef } from './chain.ts';
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

/**
 * How long a pinned snapshot waits for a lagging node (C1.4). A
 * load-balanced endpoint can report `latest` from one node and serve the
 * pinned read from another that has not reached that block yet. The whole
 * snapshot is then re-read at the **same** block — never at a newer one, never
 * at `latest` — so every market still comes from one block; after the bound
 * the read is `UNKNOWN`, which admits nothing.
 */
export const PINNED_REREADS = 3;
export const PINNED_REREAD_PAUSE_MS = 400;

export interface PinnedReadOptions {
  readonly rereads?: number;
  readonly pause?: (ms: number) => Promise<void>;
}

export async function readGateMarkets(chain: ChainClient, policy: GateSpotPolicy, o: PinnedReadOptions = {}): Promise<GateStateRead> {
  const g = policy.config.gate;
  const block = await chain.block('latest');
  if (!block.ok) return { status: 'UNKNOWN', reason: `BLOCK.${block.error}` };
  const rereads = o.rereads ?? PINNED_REREADS;
  const wait = o.pause ?? pause;
  for (let attempt = 0; ; attempt += 1) {
    const r = await marketsAt(chain, g, block.value.number);
    if (r.ok) return { status: 'OK', block: block.value, snapshots: r.snapshots, states: r.snapshots.map((s) => gateMarketState(policy, s, block.value.timestamp)) };
    if (!r.error.startsWith('BLOCK_AHEAD_OF_NODE.') || attempt >= rereads) return { status: 'UNKNOWN', reason: `MARKET.${r.error}` };
    await wait(PINNED_REREAD_PAUSE_MS);
  }
}

async function marketsAt(chain: ChainClient, g: GateSpotPolicy['config']['gate'], block: bigint): Promise<{ readonly ok: true; readonly snapshots: readonly GateMarketSnapshot[] } | { readonly ok: false; readonly error: string }> {
  const snapshots: GateMarketSnapshot[] = [];
  for (const m of g.markets) {
    const s = await chain.gateMarket(g.gate, representationIdOf(g.chainId, m.representation), block);
    if (!s.ok) return { ok: false, error: s.error };
    snapshots.push(s.value);
  }
  return { ok: true, snapshots };
}
