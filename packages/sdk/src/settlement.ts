/**
 * Optional settlement adapter wiring for `@mandate/live-settlement`.
 *
 * The SDK never opens an RPC, holds a gas key, or broadcasts. Callers that
 * want prepareExecution / reconcile inject dependencies here. Preparation
 * always uses dry-run / prepare-only paths (`broadcasts: 0`).
 */

import type { LiveSession } from '@mandate/live-agents';
import {
  reconcileAttempts,
  settleSpineV3,
  type DomainKeys,
  type LiveV3ChallengeHost,
  type SettlementJournal,
  type TestnetDeployment,
  type TestnetRpc,
  type V3SettlementInput,
} from '@mandate/live-settlement';
import type { PrepareExecutionResult, ReconciliationResult, SettlementBackend } from './types.ts';

export interface V3SettlementAdapterConfig {
  readonly session: LiveSession;
  readonly journal: SettlementJournal;
  readonly deployment: TestnetDeployment;
  readonly v3Gate: V3SettlementInput['v3Gate'];
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  readonly host: LiveV3ChallengeHost;
  readonly ledgerPath: string;
  readonly nextExecutionNonce: bigint;
  readonly usedDebit?: bigint;
}

/**
 * Settlement backend that prepares via `settleSpineV3` in DRY_RUN mode and
 * reconciles via `reconcileAttempts` (reader only — cannot send).
 */
export function createV3SettlementBackend(cfg: V3SettlementAdapterConfig): SettlementBackend {
  return {
    async prepareExecution(): Promise<PrepareExecutionResult> {
      const result = await settleSpineV3({
        session: cfg.session,
        journal: cfg.journal,
        deployment: cfg.deployment,
        v3Gate: cfg.v3Gate,
        rpc: cfg.rpc,
        keys: cfg.keys,
        mode: 'DRY_RUN',
        host: cfg.host,
        ledgerPath: cfg.ledgerPath,
        nextExecutionNonce: cfg.nextExecutionNonce,
        ...(cfg.usedDebit === undefined ? {} : { usedDebit: cfg.usedDebit }),
      });
      if (result.status === 'READY') {
        return {
          ok: true,
          execution: {
            broadcasts: 0,
            prepared: result.prepared,
            debit: result.debit,
            wouldSend: result.wouldSend,
            reports: result.reports,
          },
        };
      }
      if (result.status === 'RECONCILED_ONLY') {
        return {
          ok: false,
          code: 'RECONCILED_ONLY',
          message: 'Settlement already reconciled from durable evidence; nothing new to prepare.',
          broadcasts: 0,
        };
      }
      if (result.status === 'SENT') {
        return {
          ok: false,
          code: 'UNEXPECTED_SEND',
          message: 'Preparation path produced a send result; SDK refuses to surface it.',
          broadcasts: 0,
        };
      }
      return {
        ok: false,
        code: result.stage,
        message: result.reason,
        broadcasts: 0,
      };
    },

    async reconcile(): Promise<ReconciliationResult> {
      const reports = await reconcileAttempts({
        journal: cfg.journal,
        reader: cfg.rpc,
        session: cfg.session,
        deployment: cfg.deployment,
      });
      return {
        ok: true,
        reports,
        resent: false,
        broadcasts: 0,
      };
    },
  };
}
