/**
 * The registry-drift scenario of Phase 7D.3, shared by the SEMANTIC-AUTH
 * tests and the 7D.3 mutants. At T0 module A — `perp`, version 1, digest A —
 * is current and a root grant binds `perp.account-leverage ≤ 4x` to it. At
 * T1 the registry maps `(perp, 1)` to digest B, which reads the same term's
 * bound at twice its value; A may or may not be archived. Every semantic call
 * of A and B is counted.
 */

import assert from 'node:assert/strict';
import { authorityId, type AuthorityGrant, type ModuleRef, type StateInvariantInput } from '@mandate/core';
import { ReferenceModuleRegistry, decodeBatch, type LedgerEvent, type ModuleStatus, type SemanticInvariantRef } from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, ReferenceModuleArchive, type ControlRefusal, type DomainModule } from '../../src/index.ts';
import { AGENT_A, P, PERP_CFG, SPOT_CFG, account, action, capitalDim, context, createSyntheticModule, marketStates, maxLeverage, must, policy, request, root, setup, sizeFor, usd, world, type SyntheticModule, type World } from './world.ts';

/** Module A: `perp`, version 1, digest A — owns `perp.account-leverage`. */
export const CFG = { ...PERP_CFG, moduleId: 'perp' };
/** Module B: the same name and version under another digest; it reads the same leverage term at twice its bound. */
export const CFG_B = { ...CFG, variant: 'DOUBLE_LEVERAGE' as const };

export interface Calls {
  n: number;
}

/** A module whose every semantic call — evaluation and ordering — is counted. */
export function spied(m: SyntheticModule, calls: Calls): DomainModule {
  return {
    ...m,
    evaluateInvariant: (t, p) => ((calls.n += 1), m.evaluateInvariant(t, p)),
    noWeaker: (p, c) => ((calls.n += 1), m.noWeaker(p, c)),
  };
}

export function definitionOf(m: ModuleRef): SemanticInvariantRef {
  return { owner: { kind: 'MODULE', module: m }, invariantId: `${m.moduleId}.account-leverage`, version: m.moduleVersion } as unknown as SemanticInvariantRef;
}

export function registrationOf(events: readonly LedgerEvent[], grant: AuthorityGrant): Extract<LedgerEvent, { kind: 'REGISTER_GRANT' }> {
  const e = events.find((x): x is Extract<LedgerEvent, { kind: 'REGISTER_GRANT' }> => x.kind === 'REGISTER_GRANT' && authorityId(x.grant) === authorityId(grant));
  assert.ok(e !== undefined);
  return e;
}

/** Every event, decoded from the stored bytes. */
export async function storedEvents(w: World): Promise<LedgerEvent[]> {
  return (await w.store.history(P as never)).flatMap((b) => must(decodeBatch(b.encoded)).events);
}

export function invariantFrom(r: ControlRefusal, invariantId: string) {
  assert.ok(r.detail.kind === 'INVARIANTS', `expected invariant results, got ${r.code}/${r.reason}`);
  const x = r.detail.kind === 'INVARIANTS' ? r.detail.results.find((y) => y.term.invariantId === invariantId) : undefined;
  assert.ok(x !== undefined);
  return x;
}

/** T0: A and a spot module are current; a root grant carries `perp.account-leverage ≤ 4x`, bound at registration. */
export async function t0(o: { policyTerms?: (a: SyntheticModule) => readonly StateInvariantInput[]; grantTerms?: (a: SyntheticModule) => readonly StateInvariantInput[] } = {}) {
  const a = createSyntheticModule(CFG);
  const s = createSyntheticModule(SPOT_CFG);
  const w = world({ modules: [a, s] });
  const acctA = account(a);
  const acctS = account(s);
  const grantTerms = o.grantTerms?.(a) ?? [maxLeverage(a, acctA, 4n)];
  const grant = root({ mods: [a, s], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 1_000_000), ...grantTerms] });
  await setup(w, policy(o.policyTerms?.(a) ?? []), [grant]);
  return { a, s, w, acctA, acctS, grant };
}

export type Fixture = Awaited<ReturnType<typeof t0>>;

/**
 * A spot order under `grant`, with the perp account held at `leverage`x
 * (100,000.00 of collateral), its state normalized under `perp` — the module
 * whose semantics will read it (A by default).
 */
export function spotOrder(f: Fixture, grant: AuthorityGrant, leverage: number, nonce: bigint, perp: SyntheticModule = f.a) {
  const states = [
    ...marketStates(f.s, [{ account: f.acctS }]),
    ...marketStates(perp, [{ account: f.acctA, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(leverage * 100_000) }], collateral: usd(100_000) }]),
  ];
  const ctx = context([perp, f.s], { accounts: [{ module: perp, account: f.acctA }, { module: f.s, account: f.acctS }] });
  return request(action(f.s, { authority: grant, size: sizeFor(1_000), nonce }), states, ctx);
}

/** T1: the registry maps `(perp, 1)` to B. A is archived (or not); every semantic call is counted. */
export function t1(f: Fixture, o: { archiveA: boolean; statusB?: ModuleStatus }) {
  const b = createSyntheticModule(CFG_B);
  const callsA: Calls = { n: 0 };
  const callsB: Calls = { n: 0 };
  const registry = must(
    ReferenceModuleRegistry.create([
      { module: b.ref, status: o.statusB ?? 'ACTIVE', implementations: [b.implementation] },
      { module: f.s.ref, status: 'ACTIVE', implementations: [f.s.implementation] },
    ]),
  );
  const archive = must(ReferenceModuleArchive.create([{ module: f.a.ref, implementations: [f.a.implementation] }]));
  const catalog = must(
    ModuleCatalog.create(
      registry,
      [
        { module: spied(b, callsB), corpus: [] },
        { module: f.s, corpus: [] },
      ],
      o.archiveA ? { archive, modules: [{ module: spied(f.a, callsA), corpus: [] }] } : undefined,
    ),
  );
  return { b, callsA, callsB, registry, catalog, engine: new ControlEngine({ store: f.w.store, registry, catalog }) };
}

