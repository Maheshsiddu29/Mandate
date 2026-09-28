/**
 * Type-level anti-confusion.
 *
 * Every `@ts-expect-error` below marks a line that must NOT compile. If a
 * brand is weakened so the line starts compiling, the directive itself becomes
 * an error and `npm run typecheck` fails: these are compile-fail tests run by
 * the ordinary typecheck. The function holding them is never called; the
 * runtime tests at the bottom check the matching runtime refusals, because a
 * brand is erased at run time and is not the boundary (ADR 0003).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addQuantities,
  compareQuantities,
  principalAsAgent,
  validateActionEnvelope,
  validateQuantity,
  type ActionEnvelopeInput,
  type ActionId,
  type AdapterRef,
  type AgentId,
  type AuthorityId,
  type Capital,
  type EconomicQuantity,
  type FreshnessPolicyInput,
  type LedgerVersion,
  type MandateId,
  type Margin,
  type MarkedExposure,
  type ModuleRef,
  type Nonce,
  type PositionSize,
  type PrincipalId,
  type PrincipalPolicyInput,
  type ReservationGeneration,
  type ReservationId,
  type StateId,
} from '../src/index.ts';
import { PRINCIPAL, USDG, USDG_ON_L, must, sampleActionInput, unvalued } from './support/fixtures.ts';

function loadPrincipal(_id: PrincipalId): void {}
function loadAgent(_id: AgentId): void {}
function loadAction(_id: ActionId): void {}
function loadAuthority(_id: AuthorityId): void {}
function loadMandate(_id: MandateId): void {}
function loadGeneration(_g: ReservationGeneration): void {}
function loadModule(_m: ModuleRef): void {}
function loadAdapter(_a: AdapterRef): void {}

export function typeLevelChecks(
  principal: PrincipalId,
  agent: AgentId,
  action: ActionId,
  state: StateId,
  reservation: ReservationId,
  authority: AuthorityId,
  mandate: MandateId,
  capital: Capital,
  margin: Margin,
  position: PositionSize,
  marked: MarkedExposure,
  moduleRef: ModuleRef,
  adapterRef: AdapterRef,
  generation: ReservationGeneration,
  version: LedgerVersion,
  nonce: Nonce,
): void {
  // --- PrincipalId != AgentId --------------------------------------------------
  // @ts-expect-error an agent is not a principal
  loadPrincipal(agent);
  // @ts-expect-error a principal is not an agent without the explicit conversion
  loadAgent(principal);
  loadAgent(principalAsAgent(principal));

  // --- ActionId != StateId, and digests are not interchangeable ----------------
  loadAction(action);
  // @ts-expect-error a state digest is not an action digest
  loadAction(state);
  // @ts-expect-error a reservation id is not an action digest
  loadAction(reservation);
  // @ts-expect-error a bare string is not an ActionId
  loadAction('0x00');
  // @ts-expect-error an action digest is not an authority
  loadAuthority(action);

  // --- MandateId ⊂ AuthorityId ---------------------------------------------------
  loadAuthority(mandate);
  // @ts-expect-error an arbitrary AuthorityId is not proven to be a root
  loadMandate(authority);

  // --- Capital != Margin ---------------------------------------------------------
  // @ts-expect-error capital is not margin, although both are USDG
  const asMargin: Margin = capital;
  // @ts-expect-error capital and margin cannot be added
  addQuantities(capital, margin);
  // @ts-expect-error nor compared
  compareQuantities(margin, capital);
  addQuantities(capital, capital);

  // --- PositionSize != MarkedExposure --------------------------------------------
  // @ts-expect-error a position size is not a marked exposure
  const asMarked: MarkedExposure = position;
  // @ts-expect-error a marked exposure is not a position size
  const asPosition: PositionSize = marked;
  // @ts-expect-error they cannot be added
  addQuantities(position, marked);

  // --- ModuleRef != AdapterRef ---------------------------------------------------
  // @ts-expect-error an adapter is not a module
  loadModule(adapterRef);
  // @ts-expect-error a module is not an adapter
  loadAdapter(moduleRef);
  // @ts-expect-error a name is not a ModuleRef
  loadModule('perp-policy@1');
  // @ts-expect-error a ModuleRef cannot be assembled from plain fields; only the validator produces one
  loadModule({ domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 1, moduleDigest: '0x00' });

  // --- Generations, versions and nonces are distinct counters ---------------------
  loadGeneration(generation);
  // @ts-expect-error a ledger version is not a reservation generation
  loadGeneration(version);
  // @ts-expect-error a nonce is not a reservation generation
  loadGeneration(nonce);
  // @ts-expect-error a bare bigint is not a generation: "the current one" cannot be assumed
  loadGeneration(1n);

  // --- Quantities cannot be assembled without validation ---------------------------
  // @ts-expect-error an object literal is not an EconomicQuantity
  const forged: Capital = { kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: 1n, asset: null, valuation: null };

  // --- The principal policy cannot even be written with a right ------------------
  const policy: PrincipalPolicyInput = {
    principal: PRINCIPAL,
    sequence: 1n,
    // @ts-expect-error a right is not a principal-policy term
    terms: [{ kind: 'RIGHT', right: 'OPEN_RISK' }],
    nonce: 1n,
  };

  // --- The action envelope has no domain fields -------------------------------------
  const withSide: ActionEnvelopeInput = {
    ...sampleActionInput(),
    // @ts-expect-error `side` is a perp payload field, not a Core envelope field
    side: 'BUY',
  };

  // --- Freshness modes are not interchangeable (Phase 7B.1 ruling 4) ------------------
  // @ts-expect-error BLOCKS is a block count; it has no age
  const blocksAsAge: FreshnessPolicyInput = { kind: 'BLOCKS', maxAgeSeconds: 12n };
  // @ts-expect-error SEQUENCE is bounded by the ledger watermark; it takes no age
  const sequenceAsAge: FreshnessPolicyInput = { kind: 'SEQUENCE', maxAgeSeconds: 5n };
  // @ts-expect-error SEQUENCE takes no block count either
  const sequenceAsBlocks: FreshnessPolicyInput = { kind: 'SEQUENCE', maxBlocksBehind: 5n };
  // @ts-expect-error a pinned version is a digest identity, not elapsed time
  const versionAsTime: FreshnessPolicyInput = { kind: 'VERSION', pinnedDigest: 3_600n, maxAgeSeconds: 60n };

  void [asMargin, asMarked, asPosition, forged, policy, withSide, blocksAsAge, sequenceAsAge, sequenceAsBlocks, versionAsTime];
}

describe('runtime counterparts of the type-level checks', () => {
  it('capital and margin are refused together at run time too', () => {
    const capital = must(validateQuantity(unvalued('CAPITAL', 'USDG', 6, 1n, USDG))) as EconomicQuantity;
    const margin = must(validateQuantity(unvalued('MARGIN', 'USDG', 6, 1n, USDG_ON_L))) as EconomicQuantity;
    const r = addQuantities(capital, margin);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'QUANTITY_KIND_MISMATCH');
  });

  it('a domain field in an action envelope is refused at run time too', () => {
    const r = validateActionEnvelope({ ...sampleActionInput(), side: 'BUY' } as ActionEnvelopeInput);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'UNKNOWN_FIELD');
  });
});
