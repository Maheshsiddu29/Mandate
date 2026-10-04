/**
 * Live Lab V3 challenge host: ephemeral Mandate execution delegate + trusted
 * fixture scope. Private keys stay in this process memory only.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@mandate/kernel';
import { representationIdFor } from '@mandate/execution-gate';
import {
  parseUsdc,
  type MandateDraft,
  type V3ChallengeHost,
  type V3IssueInput,
  type V3IssueResult,
  type V3PublicScope,
  type V3SetupPreviewResult,
} from '@mandate/live-agents';
import type { ReviewedMarket } from '@mandate/evm-robinhood';
import type { PortfolioMandate } from '@mandate/portfolio';
import { deriveV3StockFixtureCap, type V3CapResult } from './cap.ts';
import { createExecutionDelegate, restoredExecutionDelegate, type ExecutionDelegate } from './execution-delegate.ts';
import { AutonomousSettlementGate } from './autonomous-gate.ts';

function atomsOrNull(usdc: string | null): string | null {
  if (usdc === null || usdc === '') return null;
  const atoms = parseUsdc(usdc);
  return atoms === null ? null : atoms.toString();
}

function stockCap(draft: MandateDraft, market: ReviewedMarket): V3CapResult {
  const stock = draft.agents.stock;
  return deriveV3StockFixtureCap({
    stock: {
      enabled: stock.enabled,
      budget: atomsOrNull(stock.budget),
      maxAllocation: atomsOrNull(stock.maxAllocation),
    },
    autoReallocate: draft.portfolio.autoReallocate === true,
    market,
  });
}

const utf8 = new TextEncoder();

export interface V3HostConfig {
  readonly chainId: bigint;
  readonly gate: string;
  readonly agent: string;
  readonly fundingToken: string;
  readonly market: ReviewedMarket;
  /** Delegation lifetime in seconds from challenge issue (bounded; never forever). */
  readonly validitySeconds: bigint;
}

export interface V3SessionDelegate {
  readonly delegate: ExecutionDelegate;
  readonly scope: V3PublicScope;
  readonly autonomous: AutonomousSettlementGate;
}

function representationIdHash(chainId: bigint, representation: string): string {
  const id = representationIdFor(chainId, representation);
  return bytesToHex(keccak_256(utf8.encode(id)));
}

/**
 * Per-process V3 host. One ephemeral delegate per session id. Restart loses
 * private keys; `restorePublic` yields an evidence-only delegate.
 */
export class LiveV3ChallengeHost implements V3ChallengeHost {
  readonly #cfg: V3HostConfig;
  readonly #bySession = new Map<string, V3SessionDelegate>();

  constructor(cfg: V3HostConfig) {
    this.#cfg = cfg;
  }

  issueScope(input: V3IssueInput): V3IssueResult {
    if (this.#cfg.chainId !== 46_630n) return { ok: false, code: 'V3_CHAIN', message: 'V3 is Robinhood Chain testnet only.' };
    if (input.principal.toLowerCase() !== input.mandate.principal.value.toLowerCase()) {
      return { ok: false, code: 'V3_PRINCIPAL', message: 'V3 scope principal must match the compiled mandate.' };
    }
    const existing = this.#bySession.get(input.sessionId);
    if (existing !== undefined) {
      if (!existing.delegate.canSign) {
        return { ok: false, code: 'V3_DELEGATE_UNAVAILABLE', message: 'This session’s Mandate execution delegate key is unavailable (restart). Start a fresh mandate.' };
      }
      return { ok: true, scope: existing.scope };
    }

    const cap = stockCap(input.draft, this.#cfg.market);
    if (!cap.ok) return { ok: false, code: cap.reason, message: `V3 fixture debit cap refused: ${cap.reason}.` };

    const delegate = createExecutionDelegate();
    if (delegate.public.address === this.#cfg.agent.toLowerCase() || delegate.public.address === input.principal.toLowerCase()) {
      return { ok: false, code: 'V3_DELEGATE_COLLISION', message: 'Ephemeral delegate collided with principal or agent; retry.' };
    }

    const validAfter = input.now;
    const validUntil = input.now + this.#cfg.validitySeconds;
    if (validUntil <= validAfter || this.#cfg.validitySeconds === 0n) {
      return { ok: false, code: 'V3_VALIDITY', message: 'V3 delegation validity window is invalid.' };
    }

    const scope: V3PublicScope = {
      verifyingContract: this.#cfg.gate.toLowerCase(),
      delegate: delegate.public.address,
      agent: this.#cfg.agent.toLowerCase(),
      representationIdHash: representationIdHash(this.#cfg.chainId, this.#cfg.market.representation),
      fundingToken: this.#cfg.fundingToken.toLowerCase(),
      cumulativeDebitLimit: cap.cumulativeDebitLimit.toString(),
      validAfter: validAfter.toString(),
      validUntil: validUntil.toString(),
      generation: input.generation.toString(),
    };
    const autonomous = new AutonomousSettlementGate();
    this.#bySession.set(input.sessionId, { delegate, scope, autonomous });
    return { ok: true, scope };
  }

  previewSettlementSetup(input: {
    readonly principal: string;
    readonly draft: MandateDraft;
    readonly mandate: PortfolioMandate;
  }): V3SetupPreviewResult {
    if (this.#cfg.chainId !== 46_630n) return { ok: false, code: 'V3_CHAIN', message: 'V3 is Robinhood Chain testnet only.' };
    if (input.principal.toLowerCase() !== input.mandate.principal.value.toLowerCase()) {
      return { ok: false, code: 'V3_PRINCIPAL', message: 'V3 setup principal must match the compiled mandate.' };
    }
    const cap = stockCap(input.draft, this.#cfg.market);
    if (!cap.ok) return { ok: false, code: cap.reason, message: `V3 fixture debit cap refused: ${cap.reason}.` };
    return {
      ok: true,
      plan: {
        chainId: Number(this.#cfg.chainId),
        gate: this.#cfg.gate.toLowerCase(),
        fundingToken: this.#cfg.fundingToken.toLowerCase(),
        requiredAllowanceAtoms: cap.cumulativeDebitLimit.toString(),
        basis: cap.basis,
      },
    };
  }

  /** After a verified V3 principal authorization is active in-process. */
  arm(sessionId: string): boolean {
    const row = this.#bySession.get(sessionId);
    if (row === undefined || !row.delegate.canSign) return false;
    row.autonomous.arm();
    return true;
  }

  pause(sessionId: string): void {
    this.#bySession.get(sessionId)?.autonomous.pause();
  }

  sessionOf(sessionId: string): V3SessionDelegate | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /**
   * Evidence-only restore: public address from durable authorization, no key.
   * Never invents a new private key for the same session.
   */
  restorePublic(sessionId: string, scope: V3PublicScope): V3SessionDelegate {
    const existing = this.#bySession.get(sessionId);
    if (existing !== undefined) return existing;
    const row: V3SessionDelegate = {
      delegate: restoredExecutionDelegate(scope.delegate),
      scope,
      autonomous: new AutonomousSettlementGate(),
    };
    this.#bySession.set(sessionId, row);
    return row;
  }
}
