/**
 * The canonical initial allocation accepted by the principal before signing.
 *
 * This object is evidence of the starting plan, not an authority envelope.
 * It binds the exact portfolio mandate, every enabled agent (including zero
 * allocations), the allocation intent, the reallocation permission and the
 * capital left unallocated. No presentation text or model rationale enters
 * the encoding.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  UINT64_MAX,
  at,
  canonicalSet,
  checkArray,
  checkFields,
  fail,
  parseDigest,
  parseEnum,
  parseIntegerInRange,
  partyIdInputOf,
  readCode,
  readPartyInput,
  validateAgentId,
  writeCode,
  writeDigest,
  writeParty,
  type AgentId,
  type CoreReader,
  type CoreResult,
  type Digest32,
  type IntegerInput,
  type PartyIdInput,
  type Tagged,
  type WireCodes,
} from '@mandate/core';
import { PortfolioTag, decodePortfolio, portfolioDigest, portfolioWriter } from './encoding.ts';
import { portfolioMandateDigest, type PortfolioMandate, type PortfolioMandateDigest } from './mandate.ts';

export const InitialAllocationMode = { FIXED: 'FIXED', DYNAMIC: 'DYNAMIC', HYBRID: 'HYBRID' } as const;
export type InitialAllocationMode = (typeof InitialAllocationMode)[keyof typeof InitialAllocationMode];
const MODES: readonly InitialAllocationMode[] = Object.values(InitialAllocationMode);
const MODE_CODE: WireCodes<InitialAllocationMode> = { FIXED: 1, DYNAMIC: 2, HYBRID: 3 };

export const InitialAllocationSource = { FIXED: 'FIXED', PLANNED: 'PLANNED' } as const;
export type InitialAllocationSource = (typeof InitialAllocationSource)[keyof typeof InitialAllocationSource];
const SOURCES: readonly InitialAllocationSource[] = Object.values(InitialAllocationSource);
const SOURCE_CODE: WireCodes<InitialAllocationSource> = { FIXED: 1, PLANNED: 2 };

export type InitialAllocationDigest = Tagged<Digest32, 'InitialAllocationDigest'>;

export interface InitialAllocationEntryInput {
  readonly agent: PartyIdInput;
  readonly allocatedAtoms: IntegerInput;
  readonly source: string;
}

export type InitialAllocationEntry = Tagged<
  {
    readonly agent: AgentId;
    readonly allocatedAtoms: bigint;
    readonly source: InitialAllocationSource;
  },
  'InitialAllocationEntry'
>;

export interface InitialAllocationPlanInput {
  readonly portfolioMandateDigest: string;
  readonly totalCapitalAtoms: IntegerInput;
  readonly mode: string;
  readonly autoReallocate: boolean;
  readonly entries: readonly InitialAllocationEntryInput[];
  readonly unallocatedAtoms: IntegerInput;
}

export type InitialAllocationPlan = Tagged<
  {
    readonly portfolioMandateDigest: PortfolioMandateDigest;
    readonly totalCapitalAtoms: bigint;
    readonly mode: InitialAllocationMode;
    readonly autoReallocate: boolean;
    /** Exactly one entry for every enabled mandate agent, ordered by agent encoding. */
    readonly entries: readonly InitialAllocationEntry[];
    readonly unallocatedAtoms: bigint;
  },
  'InitialAllocationPlan'
>;

function writeEntry(w: ByteWriter, entry: InitialAllocationEntry): void {
  writeParty(w, entry.agent);
  w.u64(entry.allocatedAtoms);
  writeCode(w, SOURCE_CODE, entry.source);
}

function readEntryInput(r: CoreReader): InitialAllocationEntryInput {
  return { agent: readPartyInput(r), allocatedAtoms: r.u64(), source: readCode(r, SOURCE_CODE) };
}

function sameAgent(a: { readonly kind: string; readonly value: string }, b: { readonly kind: string; readonly value: string }): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** Validate a plan against the exact mandate whose digest it carries. */
export function validateInitialAllocationPlan(input: InitialAllocationPlanInput, mandate: PortfolioMandate, path = 'initialAllocation'): CoreResult<InitialAllocationPlan> {
  const shape = checkFields(input, ['portfolioMandateDigest', 'totalCapitalAtoms', 'mode', 'autoReallocate', 'entries', 'unallocatedAtoms'], path);
  if (!shape.ok) return shape;
  const mandateDigest = parseDigest<PortfolioMandateDigest>(input.portfolioMandateDigest, at(path, 'portfolioMandateDigest'));
  if (!mandateDigest.ok) return mandateDigest;
  if (mandateDigest.value !== portfolioMandateDigest(mandate)) return fail('MALFORMED_DIGEST', at(path, 'portfolioMandateDigest'));
  const total = parseIntegerInRange(input.totalCapitalAtoms, 0n, UINT64_MAX, at(path, 'totalCapitalAtoms'));
  if (!total.ok) return total;
  const mode = parseEnum(input.mode, MODES, at(path, 'mode'));
  if (!mode.ok) return mode;
  if (typeof input.autoReallocate !== 'boolean') return fail('WRONG_TYPE', at(path, 'autoReallocate'));
  const arr = checkArray(input.entries, mandate.agents.length, at(path, 'entries'));
  if (!arr.ok) return arr;
  if (input.entries.length !== mandate.agents.length) return fail('MALFORMED_PARTY', at(path, 'entries'));
  const entries: InitialAllocationEntry[] = [];
  for (let i = 0; i < input.entries.length; i += 1) {
    const raw = input.entries[i] as InitialAllocationEntryInput;
    const ep = at(at(path, 'entries'), i);
    const entryShape = checkFields(raw, ['agent', 'allocatedAtoms', 'source'], ep);
    if (!entryShape.ok) return entryShape;
    const agent = validateAgentId(raw.agent, at(ep, 'agent'));
    if (!agent.ok) return agent;
    if (!mandate.agents.some((policy) => sameAgent(policy.agent, agent.value))) return fail('MALFORMED_PARTY', at(ep, 'agent'));
    const amount = parseIntegerInRange(raw.allocatedAtoms, 0n, UINT64_MAX, at(ep, 'allocatedAtoms'));
    if (!amount.ok) return amount;
    const source = parseEnum(raw.source, SOURCES, at(ep, 'source'));
    if (!source.ok) return source;
    if (mode.value === 'FIXED' && source.value !== 'FIXED') return fail('UNKNOWN_ENUM_VALUE', at(ep, 'source'));
    if (mode.value === 'DYNAMIC' && source.value !== 'PLANNED') return fail('UNKNOWN_ENUM_VALUE', at(ep, 'source'));
    entries.push({ agent: agent.value, allocatedAtoms: amount.value, source: source.value } as InitialAllocationEntry);
  }
  const unique = canonicalSet(entries, (w, entry) => writeParty(w, entry.agent), at(path, 'entries'));
  if (!unique.ok) return unique;
  if (unique.value.some((entry, i) => !sameAgent(entry.agent, mandate.agents[i]?.agent ?? { kind: '', value: '' }))) return fail('MALFORMED_PARTY', at(path, 'entries'));
  const unallocated = parseIntegerInRange(input.unallocatedAtoms, 0n, UINT64_MAX, at(path, 'unallocatedAtoms'));
  if (!unallocated.ok) return unallocated;
  const allocated = unique.value.reduce((sum, entry) => sum + entry.allocatedAtoms, 0n);
  if (allocated > total.value || allocated + unallocated.value !== total.value) return fail('INTEGER_OUT_OF_RANGE', at(path, 'unallocatedAtoms'));
  return ok({ portfolioMandateDigest: mandateDigest.value, totalCapitalAtoms: total.value, mode: mode.value, autoReallocate: input.autoReallocate, entries: unique.value, unallocatedAtoms: unallocated.value } as InitialAllocationPlan);
}

export function encodeInitialAllocationPlan(plan: InitialAllocationPlan): Uint8Array {
  const w = portfolioWriter(PortfolioTag.INITIAL_ALLOCATION);
  writeDigest(w, plan.portfolioMandateDigest);
  w.u64(plan.totalCapitalAtoms);
  writeCode(w, MODE_CODE, plan.mode);
  w.u8(plan.autoReallocate ? 1 : 0);
  w.u16(plan.entries.length);
  for (const entry of plan.entries) writeEntry(w, entry);
  w.u64(plan.unallocatedAtoms);
  return w.finish();
}

function readPlanInput(r: CoreReader): InitialAllocationPlanInput {
  const portfolioMandateDigest = r.digest();
  const totalCapitalAtoms = r.u64();
  const mode = readCode(r, MODE_CODE);
  const autoReallocate = r.flag();
  const entries = r.list(16, readEntryInput, true);
  const unallocatedAtoms = r.u64();
  return { portfolioMandateDigest, totalCapitalAtoms, mode, autoReallocate, entries, unallocatedAtoms };
}

export function decodeInitialAllocationPlan(bytes: Uint8Array, mandate: PortfolioMandate): CoreResult<InitialAllocationPlan> {
  return decodePortfolio(bytes, PortfolioTag.INITIAL_ALLOCATION, readPlanInput, (input) => validateInitialAllocationPlan(input, mandate));
}

export function initialAllocationDigest(plan: InitialAllocationPlan): InitialAllocationDigest {
  return portfolioDigest<InitialAllocationDigest>(encodeInitialAllocationPlan(plan));
}

export function initialAllocationPlanInputOf(plan: InitialAllocationPlan): InitialAllocationPlanInput {
  return {
    portfolioMandateDigest: plan.portfolioMandateDigest,
    totalCapitalAtoms: plan.totalCapitalAtoms,
    mode: plan.mode,
    autoReallocate: plan.autoReallocate,
    entries: plan.entries.map((entry) => ({ agent: partyIdInputOf(entry.agent), allocatedAtoms: entry.allocatedAtoms, source: entry.source })),
    unallocatedAtoms: plan.unallocatedAtoms,
  };
}
