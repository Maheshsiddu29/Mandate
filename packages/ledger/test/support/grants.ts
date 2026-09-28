/**
 * Module refs, resources and builders for grants, policies, charge plans and
 * revocations. Builders validate through Core, so every object a test uses is
 * a well-formed Core object unless the test says otherwise.
 */

import {
  authorityId,
  validateAuthorityGrant,
  validateModuleRef,
  validatePrincipalPolicy,
  type AuthorityGrant,
  type AuthorityId,
  type AuthorityTermInput,
  type EconomicQuantityInput,
  type ImplementationDigest,
  type LedgerDimensionInput,
  type ModuleRef,
  type ModuleRefInput,
  type ObservationId,
  type PartyIdInput,
  type PrincipalPolicy,
  type PrincipalPolicyTermInput,
  type QuantityKind,
  type ResourceIdInput,
} from '@mandate/core';
import { validateChargePlan, type ChargePlan, type ContributionInput } from '../../src/charge-plan.ts';
import { validateRevocation, type Revocation } from '../../src/revocation.ts';
import { AGENT_A, DAY, P, T0, T_END, digestOf, must } from './basics.ts';

export * from './basics.ts';

// --- Modules ---------------------------------------------------------------------

export const SPOT_V1: ModuleRefInput = { domainId: 'evm-spot', moduleId: 'spot-policy', moduleVersion: 1, moduleDigest: digestOf('manifest:spot-policy:1') };
export const PERP_V1: ModuleRefInput = { domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 1, moduleDigest: digestOf('manifest:perp-policy:1') };
export const PERP_V2: ModuleRefInput = { domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 2, moduleDigest: digestOf('manifest:perp-policy:2') };
/** Same name and version as PERP_V1, different digest: a different semantic module. */
export const PERP_V1_OTHER_DIGEST: ModuleRefInput = { ...PERP_V1, moduleDigest: digestOf('manifest:perp-policy:1:patched') };
export const UNREGISTERED: ModuleRefInput = { domainId: 'perp', moduleId: 'unknown-policy', moduleVersion: 1, moduleDigest: digestOf('manifest:unknown:1') };
export const RETIRED_V0: ModuleRefInput = { domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 0, moduleDigest: digestOf('manifest:perp-policy:0') };

export const SPOT_IMPL = digestOf('implementation:spot-policy:1:a') as ImplementationDigest;
export const PERP_IMPL = digestOf('implementation:perp-policy:1:a') as ImplementationDigest;
export const PERP_V2_IMPL = digestOf('implementation:perp-policy:2:a') as ImplementationDigest;
export const ROGUE_IMPL = digestOf('implementation:perp-policy:1:rogue') as ImplementationDigest;

export function moduleRef(m: ModuleRefInput): ModuleRef {
  return must(validateModuleRef(m));
}

export function implFor(m: ModuleRefInput): ImplementationDigest {
  if (m === SPOT_V1) return SPOT_IMPL;
  if (m === PERP_V2) return PERP_V2_IMPL;
  return PERP_IMPL;
}

// --- Resources -------------------------------------------------------------------

export const USDG_EVM: ResourceIdInput = { domain: 'evm-spot', kind: 'REPRESENTATION_ASSET', localId: 'arbitrum:erc20:usdg' };
export const USDG_PERP: ResourceIdInput = { domain: 'perp', kind: 'REPRESENTATION_ASSET', localId: 'venue-l:collateral:usdg' };
export const BTC: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' };
export const ETH: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' };
export const BTC_PERP: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-l:BTC-PERP' };
export const ETH_PERP: ResourceIdInput = { domain: 'perp', kind: 'MARKET', localId: 'venue-l:ETH-PERP' };
export const SUB_ACCOUNT: ResourceIdInput = { domain: 'perp', kind: 'ACCOUNT', localId: 'venue-l:sub-1' };

// --- Terms -----------------------------------------------------------------------

export interface DimensionOptions {
  readonly decimals?: number;
  readonly unit?: string;
  readonly kind?: QuantityKind;
  readonly restoration?: LedgerDimensionInput['restoration'];
  readonly scope?: Partial<LedgerDimensionInput['scope']>;
  readonly sign?: LedgerDimensionInput['sign'];
  readonly epoch?: { anchor: bigint; lengthSeconds: bigint };
}

/** A ledger dimension. Defaults: `CAPITAL` in USDG at 2 decimals, `CAPACITY`, `AS_CHARGED`, empty scope. */
export function dim(dimensionId: string, limitAtoms: bigint, o: DimensionOptions = {}): LedgerDimensionInput {
  const restoration = o.restoration ?? 'AS_CHARGED';
  const accounting = restoration === 'NONE' || restoration === 'EPOCH' ? 'BUDGET' : 'CAPACITY';
  const kind = o.kind ?? 'CAPITAL';
  return {
    kind: 'LEDGER_DIMENSION',
    dimensionId,
    limit: { kind, unit: o.unit ?? (kind === 'COUNT' ? 'COUNT' : 'USDG'), decimals: o.decimals ?? 2, atoms: limitAtoms },
    accounting,
    restoration,
    epoch: restoration === 'EPOCH' ? (o.epoch ?? { anchor: T0, lengthSeconds: DAY }) : null,
    sign: o.sign ?? 'UNSIGNED',
    scope: { asset: null, market: null, domain: null, account: null, ...o.scope },
  };
}

/** Whole-unit amount at 2 decimals: `usd(10_000)` is 10,000.00. */
export function units(n: number): bigint {
  return BigInt(n) * 100n;
}

export const DELEGATE = (maxDepth: number): AuthorityTermInput => ({ kind: 'RIGHT', right: 'DELEGATE', maxDepth });
export const OPEN_RISK: AuthorityTermInput = { kind: 'RIGHT', right: 'OPEN_RISK' };
export const REDUCE_RISK: AuthorityTermInput = { kind: 'RIGHT', right: 'REDUCE_RISK' };
export function modules(...ms: ModuleRefInput[]): AuthorityTermInput {
  return { kind: 'SET', vocabulary: 'MODULES', members: ms };
}
export const ALL_MODULES = modules(SPOT_V1, PERP_V1, PERP_V2);

// --- Objects ---------------------------------------------------------------------

export function policy(terms: readonly PrincipalPolicyTermInput[] = [], sequence = 1n, principal: PartyIdInput = P, nonce = 0n): PrincipalPolicy {
  return must(validatePrincipalPolicy({ principal, sequence, terms, nonce }));
}

export interface GrantOptions {
  readonly holder?: PartyIdInput;
  readonly terms?: readonly AuthorityTermInput[];
  readonly notBefore?: bigint;
  readonly expiresAt?: bigint;
  readonly nonce?: bigint;
  readonly principal?: PartyIdInput;
}

export function root(o: GrantOptions = {}): AuthorityGrant {
  const principal = o.principal ?? P;
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'ROOT', issuer: principal },
      principal,
      holder: o.holder ?? principal,
      notBefore: o.notBefore ?? T0,
      expiresAt: o.expiresAt ?? T_END,
      terms: o.terms ?? [ALL_MODULES, DELEGATE(3)],
      nonce: o.nonce ?? 0n,
    }),
  );
}

export function child(parent: AuthorityGrant, o: GrantOptions & { readonly issuer?: PartyIdInput } = {}): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'DELEGATION', parent: authorityId(parent), issuer: o.issuer ?? { kind: parent.holder.kind, value: parent.holder.value } },
      principal: o.principal ?? { kind: parent.principal.kind, value: parent.principal.value },
      holder: o.holder ?? AGENT_A,
      notBefore: o.notBefore ?? parent.notBefore,
      expiresAt: o.expiresAt ?? parent.expiresAt,
      terms: o.terms ?? [ALL_MODULES],
      nonce: o.nonce ?? 0n,
    }),
  );
}

export function capital(atoms: bigint, asset: ResourceIdInput = USDG_EVM, decimals = 2): EconomicQuantityInput {
  return { kind: 'CAPITAL', unit: 'USDG', decimals, atoms, asset, valuation: null };
}

export function count(n: bigint): EconomicQuantityInput {
  return { kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: n, asset: null, valuation: null };
}

export function notional(atoms: bigint, action: string, asset: ResourceIdInput = BTC): EconomicQuantityInput {
  return {
    kind: 'NOTIONAL',
    unit: 'USD',
    decimals: 2,
    atoms,
    asset,
    valuation: { price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: 10_000_000n }, basis: 'LIMIT', source: { kind: 'ACTION', actionId: action }, observedAt: T0 },
  };
}

export function contribution(quantity: EconomicQuantityInput, o: { required?: boolean; market?: ResourceIdInput | null; account?: ResourceIdInput | null } = {}): ContributionInput {
  return { quantity, market: o.market ?? null, account: o.account ?? null, required: o.required ?? true };
}

export interface PlanOptions {
  readonly authority: AuthorityGrant;
  readonly actor?: PartyIdInput;
  readonly action?: string;
  readonly generation?: bigint;
  readonly module?: ModuleRefInput;
  readonly implementation?: string;
  readonly contributions?: readonly ContributionInput[];
  readonly principal?: PartyIdInput;
}

export function plan(o: PlanOptions): ChargePlan {
  const module = o.module ?? PERP_V1;
  return must(
    validateChargePlan({
      principal: o.principal ?? { kind: o.authority.principal.kind, value: o.authority.principal.value },
      authority: authorityId(o.authority),
      actor: o.actor ?? { kind: o.authority.holder.kind, value: o.authority.holder.value },
      action: digestOf(`action:${o.action ?? 'a'}`),
      generation: o.generation ?? 1n,
      module,
      implementation: o.implementation ?? implFor(module),
      contributions: o.contributions ?? [contribution(capital(units(1)))],
    }),
  );
}

export function revocation(target: AuthorityGrant | AuthorityId, issuer: PartyIdInput = P, effectiveAt = T0, nonce = 0n): Revocation {
  return must(validateRevocation({ target: typeof target === 'string' ? target : authorityId(target), issuer, effectiveAt, nonce }));
}

export function evidence(label: string): ObservationId {
  return digestOf(`observation:${label}`) as ObservationId;
}

