/**
 * Contradictions a draft can contain before any protocol object exists.
 *
 * These rules are about the *principal's own numbers*: a reserve larger
 * than the capital, "deploy everything" beside "keep some free", a bound
 * above what the reviewed catalog allows. Whether an agent's authority fits
 * inside the portfolio's (CHILD ⊆ PARENT) is not decided here: it is the
 * protocol's own `checkPortfolioMandate`, run by draft-validator.ts, so the
 * lab can never disagree with Mandate about it.
 */

import { REVIEWED_BOUNDS } from './catalog.ts';
import type { Role } from '../types.ts';
import { usdcText } from '../types.ts';

export type Severity = 'BLOCKING' | 'WARNING';

export const VALIDATION_CODES = [
  'MISSING_VALUE',
  'INVALID_VALUE',
  'INTERPRETATION_UNRESOLVED',
  'CONFLICT',
  'CHILD_AUTHORITY_EXCEEDS_PARENT',
  'EXCEEDS_REVIEWED_BOUND',
  'NO_AGENT_ENABLED',
  'AGENT_SCOPE_EMPTY',
  'PROTOCOL_REFUSED',
  // Room V2 (docs/v2/mandate-room-v2.md §3.4): the allocation the principal is about to sign.
  'ALLOCATION_PLAN_REQUIRED',
  'ALLOCATION_EXCEEDS_TOTAL',
  'ALLOCATION_EXCEEDS_AGENT_MAX',
  'ALLOCATION_EXCEEDS_DOMAIN_CAP',
  'ALLOCATION_AGENT_DISABLED',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export interface ValidationIssue {
  readonly severity: Severity;
  readonly code: ValidationCode;
  readonly field: string | null;
  readonly message: string;
  /** The Mandate reason behind it, where the protocol decided. */
  readonly protocol: { readonly code: string; readonly subject: string } | null;
}

export const issue = (code: ValidationCode, field: string | null, message: string, protocol: ValidationIssue['protocol'] = null, severity: Severity = 'BLOCKING'): ValidationIssue => ({ severity, code, field, message, protocol });

/** The draft's numbers, parsed. */
export interface PortfolioNumbers {
  readonly total: bigint;
  readonly minUnallocated: bigint;
  readonly maxDeployed: bigint | null;
  readonly deployAll: boolean;
  readonly validityMinutes: number;
}

export interface AgentNumbers {
  readonly role: Role;
  readonly maxAllocation: bigint;
}

/** What may be deployed: the maximum deployed, once it is consistent with the reserve. */
export function deployable(p: PortfolioNumbers): bigint | null {
  if (p.minUnallocated > p.total) return null;
  const room = p.total - p.minUnallocated;
  const max = p.deployAll ? p.total : p.maxDeployed;
  if (max === null || max > room) return null;
  return max;
}

export function portfolioConflicts(p: PortfolioNumbers): readonly ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (p.minUnallocated > p.total) {
    out.push(issue('CONFLICT', 'portfolio.minUnallocated', `Minimum unallocated (${usdcText(p.minUnallocated)} USDC) exceeds total capital (${usdcText(p.total)} USDC).`));
  }
  if (p.deployAll && p.minUnallocated > 0n) {
    out.push(issue('CONFLICT', 'portfolio.deployAll', `"Deploy everything" conflicts with keeping ${usdcText(p.minUnallocated)} USDC unallocated.`));
  }
  if (p.deployAll && p.maxDeployed !== null && p.maxDeployed !== p.total) {
    out.push(issue('CONFLICT', 'portfolio.maxDeployed', `"Deploy everything" means ${usdcText(p.total)} USDC, but the maximum deployed is ${usdcText(p.maxDeployed)} USDC.`));
  }
  const max = p.deployAll ? p.total : p.maxDeployed;
  if (max !== null && p.minUnallocated <= p.total && max > p.total - p.minUnallocated && !(p.deployAll && p.minUnallocated > 0n)) {
    out.push(issue('CONFLICT', 'portfolio.maxDeployed', `Deploying ${usdcText(max)} USDC while keeping ${usdcText(p.minUnallocated)} USDC unallocated needs ${usdcText(max + p.minUnallocated)} USDC; total capital is ${usdcText(p.total)} USDC.`));
  }
  if (max === 0n) out.push(issue('CONFLICT', 'portfolio.maxDeployed', 'Nothing may be deployed.'));
  if (p.validityMinutes < 1 || p.validityMinutes > REVIEWED_BOUNDS.maxValidityMinutes) {
    out.push(issue('EXCEEDS_REVIEWED_BOUND', 'portfolio.validityMinutes', `Validity must be between 1 minute and ${REVIEWED_BOUNDS.maxValidityMinutes / 1440} days.`));
  }
  return out;
}

export function agentConflicts(enabled: readonly AgentNumbers[]): readonly ValidationIssue[] {
  if (enabled.length === 0) return [issue('NO_AGENT_ENABLED', null, 'No agent is enabled: the mandate would authorize nothing.')];
  return enabled.filter((a) => a.maxAllocation === 0n).map((a) => issue('INVALID_VALUE', `agents.${a.role}.maxAllocation`, `The ${a.role} agent is enabled with a signed maximum of 0: it will not act.`, null, 'WARNING'));
}
