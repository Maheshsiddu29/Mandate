/**
 * Evidence classes for a settlement attempt.
 *
 * `LIVE_TESTNET` is earned, never assumed. It requires all of: the public
 * Robinhood Chain testnet RPC (not the offline reference model), chain id
 * 46630 verified from that RPC, a live model's decision (never the stub or
 * a script), a transaction actually broadcast, a mined receipt with status
 * 1, and the postconditions the gate promises observed on chain. A
 * transaction hash alone is `SUBMITTED_UNCONFIRMED`; a reverted receipt is
 * `FAILED`; a dry run is `DRY_RUN`, however well its `eth_call` went.
 */

import type { ProviderKind } from '@mandate/live-agents';
import { ROBINHOOD_TESTNET } from './deployment.ts';

export const SETTLEMENT_EVIDENCE = ['LIVE_TESTNET', 'SUBMITTED_UNCONFIRMED', 'FAILED', 'DRY_RUN', 'REFERENCE_MODEL', 'NOT_SUBMITTED'] as const;
export type SettlementEvidence = (typeof SETTLEMENT_EVIDENCE)[number];

export type Transport = 'ROBINHOOD_TESTNET_RPC' | 'REFERENCE_MODEL';

export interface EvidenceInput {
  readonly transport: Transport;
  readonly verifiedChainId: bigint | null;
  readonly provider: ProviderKind;
  readonly dryRun: boolean;
  readonly broadcast: boolean;
  readonly receipt: 'SUCCESS' | 'REVERTED' | null;
  readonly postconditions: boolean;
}

export function settlementEvidence(i: EvidenceInput): SettlementEvidence {
  if (i.dryRun) return 'DRY_RUN';
  if (!i.broadcast) return 'NOT_SUBMITTED';
  if (i.receipt === null) return 'SUBMITTED_UNCONFIRMED';
  if (i.receipt === 'REVERTED' || !i.postconditions) return 'FAILED';
  if (i.transport !== 'ROBINHOOD_TESTNET_RPC') return 'REFERENCE_MODEL';
  if (i.verifiedChainId !== ROBINHOOD_TESTNET || i.provider !== 'LIVE') return 'FAILED';
  return 'LIVE_TESTNET';
}

/** Every settlement event carries this: what the assets are, whatever the class. */
export const ASSET_QUALIFICATION = 'Robinhood Chain testnet fixture settlement — valueless demo assets (MDUSD → MDEMO); not an NVDA trade, not a Robinhood Stock Token';
