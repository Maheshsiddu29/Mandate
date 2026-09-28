/**
 * The synthetic module's conformance corpus: decision vectors whose expected
 * outcomes are fixed by its semantics (and named in its manifest), run by
 * `checkConformance` twice on frozen inputs.
 */

import {
  actionId,
  stateId,
  validatePrincipalId,
  validateQuantity,
  validateResourceId,
  validateTerm,
  type AuthorityTermInput,
  type LedgerVersion,
  type MarketId,
  type PrincipalId,
  type ReservationGeneration,
  type ReservationId,
  type StateInvariantTerm,
} from '@mandate/core';
import type { AdmittedState, ConformanceVector, ReservationFact, SuppliedState } from '../../src/index.ts';
import { BTC, P, account, action, digestOf, markState, maxExposure, maxLeverage, must, positionState, instrumentsState, root, sizeFor, usd, type SyntheticModule } from './world.ts';

function admitted(s: SuppliedState): AdmittedState {
  return { envelope: s.envelope, stateId: stateId(s.envelope), payload: s.payload };
}

function term(t: AuthorityTermInput): StateInvariantTerm {
  return must(validateTerm(t, 'term')) as StateInvariantTerm;
}

export function syntheticCorpus(m: SyntheticModule): ConformanceVector[] {
  const principal: PrincipalId = must(validatePrincipalId(P, 'p'));
  const acct = account(m);
  const market = must(validateResourceId(m.market(m.config.markets[0]?.localId ?? ''), ['MARKET'] as const, 'm')) as MarketId;
  const authority = root({ mods: [m] });
  const a = action(m, { authority, size: sizeFor(2_000) });
  const pending: ReservationFact = {
    reservation: digestOf('corpus:reservation:1') as ReservationId,
    generation: 1n as ReservationGeneration,
    action: digestOf('corpus:action:1') as ReservationFact['action'],
    module: m.ref,
    implementation: m.implementation,
    lineage: [digestOf('corpus:node') as ReservationFact['lineage'][number]],
    status: 'ACTIVE',
    committedAt: 5n as LedgerVersion,
    effects: [
      {
        quantity: must(validateQuantity({ kind: 'POSITION_SIZE', unit: 'UNIT', decimals: 4, atoms: sizeFor(2_000), asset: BTC, valuation: null })),
        market,
        account: must(validateResourceId(acct, ['ACCOUNT'] as const, 'a')),
        consumed: 0n,
      },
    ],
  };
  const localId = m.config.markets[0]?.localId ?? '';
  const held = [markState(m, localId), positionState(m, acct, [{ localId, size: sizeFor(2_000) }]), instrumentsState(m)].map(admitted);
  return [
    {
      // Brief §12 as a vector: filled 2,000 + pending 2,000 + proposed 2,000 > 5,000.
      name: 'open-over-pending',
      scope: {
        principal,
        action: { envelope: a.envelope, actionId: actionId(a.envelope), payload: a.payload, mode: 'PROPOSE' },
        invariants: [term(maxExposure(m, acct, 5_000))],
        aggregates: [],
        reservations: [pending],
      },
      states: held,
      expect: {
        requirements: 2 + m.config.markets.length,
        invariants: ['VIOLATED'],
        demands: [
          { kind: 'CAPITAL', unit: 'USDG', decimals: 2, atoms: usd(2_000) },
          { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: usd(2_000) },
          { kind: 'POSITION_SIZE', unit: 'UNIT', decimals: 4, atoms: sizeFor(2_000) },
          { kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: 1n },
        ],
      },
      narrowing: [
        { parent: term(maxLeverage(m, acct, 4n)), child: term(maxLeverage(m, acct, 3n)), expect: 'NO_WEAKER' },
        { parent: term(maxLeverage(m, acct, 4n)), child: term(maxLeverage(m, acct, 5n)), expect: 'WEAKER' },
        { parent: term(maxExposure(m, acct, 5_000)), child: term(maxExposure(m, acct, 6_000)), expect: 'WEAKER' },
        { parent: term(maxExposure(m, acct, 5_000)), child: term(maxLeverage(m, acct, 3n)), expect: 'UNPROVABLE' },
      ],
    },
    {
      name: 'aggregate-contribution',
      scope: { principal, action: null, invariants: [], aggregates: [{ kind: 'GROSS_EXPOSURE', unit: 'USD' as never, asset: must(validateResourceId(BTC, ['CANONICAL_ASSET'] as const, 'b')), accounts: [must(validateResourceId(acct, ['ACCOUNT'] as const, 'a'))] }], reservations: [] },
      states: held.slice(0, 2),
      expect: { requirements: 1 + m.config.markets.length, invariants: [], demands: null },
      narrowing: [],
    },
  ];
}
