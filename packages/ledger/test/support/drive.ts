/**
 * Drives one generated operation sequence through both the production
 * engine (over the in-memory store) and the reference model, in the same
 * known linearization order, and hands each step's outcomes to a checker.
 */

import type { AuthorityId, ObservationId, ReservationId, ReservationGeneration } from '@mandate/core';
import { AuthorityLedger, InMemoryLedgerStore, validateRevocation, nodeTargetKey, policyDimensionIdentity, policyTargetKey, type LedgerOutcome, type LedgerSnapshot } from '../../src/index.ts';
import { P, PRINCIPAL, REGISTRY, dim, digestOf, int, must, policy, prng, units } from './fixtures.ts';
import { Model, nextOp, type Op } from './model.ts';

export interface Step {
  readonly index: number;
  readonly op: Op;
  readonly model: { code: string; violations: string[] };
  readonly production: { code: string; violations: string[] };
  readonly before: LedgerSnapshot;
  readonly after: LedgerSnapshot;
}

export interface Run {
  readonly store: InMemoryLedgerStore;
  readonly model: Model;
  /** Model target key → production target key. */
  readonly keys: ReadonlyMap<string, string>;
}

function codeOf(o: LedgerOutcome): { code: string; violations: string[] } {
  if (o.status === 'COMMITTED') return { code: 'OK', violations: [] };
  if (o.status === 'CONFLICT') return { code: 'CONFLICT', violations: [] };
  return { code: o.refusal.code, violations: o.refusal.code === 'DELEGATION_REFUSED' ? o.refusal.violations.map((v) => v.code).sort() : [] };
}

export async function drive(seed: number, steps: number, check: (s: Step, run: Run) => void): Promise<Run> {
  const rand = prng(seed);
  const store = new InMemoryLedgerStore();
  const ledger = new AuthorityLedger(store, REGISTRY);
  const dims = new Map<string, bigint>();
  if (rand() < 0.7) dims.set('global-capital', units(int(rand, 200, 900)));
  if (rand() < 0.4) dims.set('global-count', BigInt(int(rand, 3, 12)));
  const policyTerms = [...dims.entries()].map(([id, limit]) => (id === 'global-count' ? dim(id, limit, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' }) : dim(id, limit)));
  const pol = policy(policyTerms);
  const model = new Model(dims);
  await ledger.registerPolicy(pol, model.t, { maxAttempts: 1 });
  const keys = new Map<string, string>();
  for (const t of pol.terms) if (t.kind === 'LEDGER_DIMENSION') keys.set(JSON.stringify(['P', t.dimensionId, '']), policyTargetKey(policyDimensionIdentity(t)));
  const run: Run = { store, model, keys };
  const once = { maxAttempts: 1 };

  for (let i = 1; i <= steps; i += 1) {
    const op = nextOp(rand, model, P, i);
    const before = await store.read(PRINCIPAL);
    const at = op.kind === 'TICK' ? model.t + op.seconds : model.t;
    let outcome: LedgerOutcome | null = null;
    switch (op.kind) {
      case 'TICK':
        break;
      case 'ROOT':
      case 'DELEGATE':
        outcome = await ledger.registerGrant(op.grant, at, once);
        break;
      case 'RESERVE':
        outcome = await ledger.reserve(op.plan, at, once);
        break;
      case 'REVOKE':
        outcome = await ledger.revoke(PRINCIPAL, must(validateRevocation({ target: op.target, issuer: P, effectiveAt: at, nonce: BigInt(i) })), at, once);
        break;
      case 'CONSUME':
      case 'RESTORE':
      case 'CLOSE': {
        const base = { reservation: op.reservation as ReservationId, generation: op.generation as ReservationGeneration, evidence: digestOf(`observation:${seed}:${i}`) as ObservationId };
        outcome = await ledger.settle(PRINCIPAL, [op.kind === 'CLOSE' ? { kind: 'CLOSE', ...base } : { kind: op.kind, ...base, amounts: op.amounts }], at, once);
        break;
      }
    }
    const modelResult = model.apply(op);
    if (modelResult.code === 'OK' && (op.kind === 'ROOT' || op.kind === 'DELEGATE')) {
      const id = [...model.nodes.keys()].at(-1) as AuthorityId;
      const n = model.nodes.get(id);
      if (n?.capital !== null) keys.set(JSON.stringify(['N', id, 'capital']), nodeTargetKey(id, 'capital'));
      if (n?.count !== null) keys.set(JSON.stringify(['N', id, 'count']), nodeTargetKey(id, 'count'));
    }
    const after = await store.read(PRINCIPAL);
    check({ index: i, op, model: modelResult, production: outcome === null ? { code: 'OK', violations: [] } : codeOf(outcome), before, after }, run);
  }
  return run;
}
