/**
 * A slow, independent reference model of the ledger, and a seeded generator
 * of operation sequences over it.
 *
 * The model shares no code with the implementation beyond Core's validators
 * and digests (used only to build real grants and plans). It keeps no
 * balance: every availability is recomputed by scanning every reservation,
 * every lineage is walked afresh, and the delegation check is re-derived for
 * the small vocabulary the generator uses — capital and action-count
 * dimensions, module sets, delegation depth and validity windows. It is
 * meant to be obviously right, not fast.
 *
 * The generator draws operations from the *model's* state — registrations,
 * delegations (some deliberately widening), reservations (some over
 * capacity, some under revoked or expired lineages, some at the wrong
 * generation), revocations, consumption, closes, restorations (some too
 * large) and the passage of time — so both implementations see the same
 * sequence in the same order.
 */

import { authorityId, reservationIdFor, validateAuthorityGrant, type AuthorityGrant, type ModuleRefInput, type PartyIdInput } from '@mandate/core';
import { validateChargePlan, type ChargePlan, type ContributionInput } from '../../src/charge-plan.ts';
import { PERP_V1, SPOT_V1, T0, address, capital, contribution, count, dim, digestOf, implFor, int, must, pick, units } from './grants.ts';

export type Op =
  | { readonly kind: 'ROOT'; readonly grant: AuthorityGrant }
  | { readonly kind: 'DELEGATE'; readonly grant: AuthorityGrant }
  | { readonly kind: 'RESERVE'; readonly plan: ChargePlan }
  | { readonly kind: 'REVOKE'; readonly target: string }
  | { readonly kind: 'CONSUME' | 'RESTORE'; readonly reservation: string; readonly generation: bigint; readonly amounts: readonly bigint[] }
  | { readonly kind: 'CLOSE'; readonly reservation: string; readonly generation: bigint }
  | { readonly kind: 'TICK'; readonly seconds: bigint };

interface MNode {
  readonly id: string;
  readonly parent: string | null;
  readonly holder: PartyIdInput;
  readonly nb: bigint;
  readonly ea: bigint;
  readonly modules: readonly string[];
  readonly capital: bigint | null;
  readonly count: bigint | null;
  readonly depth: number;
  revoked: boolean;
}

interface MLeg {
  readonly target: string;
  readonly capacity: boolean;
}

interface MDemand {
  readonly legs: readonly MLeg[];
  readonly reserved: bigint;
  consumed: bigint;
  restored: bigint;
}

interface MReservation {
  readonly id: string;
  readonly action: string;
  readonly generation: bigint;
  readonly lineage: readonly string[];
  active: boolean;
  readonly demands: MDemand[];
}

export interface ModelBalance {
  reserved: bigint;
  consumed: bigint;
  restored: bigint;
}

const MODULES: readonly ModuleRefInput[] = [SPOT_V1, PERP_V1];
const moduleKey = (m: ModuleRefInput): string => m.moduleDigest;

export class Model {
  t = T0;
  readonly policyDims: ReadonlyMap<string, bigint>;
  readonly nodes = new Map<string, MNode>();
  readonly reservations = new Map<string, MReservation>();
  readonly actions = new Map<string, { last: bigint; open: string | null; withCount: boolean; module: ModuleRefInput; leaf: string }>();

  constructor(policyDims: ReadonlyMap<string, bigint>) {
    this.policyDims = policyDims;
  }

  // --- Reading ---------------------------------------------------------------------

  lineage(id: string): MNode[] {
    const out: MNode[] = [];
    let n = this.nodes.get(id);
    while (n !== undefined) {
      out.push(n);
      n = n.parent === null ? undefined : this.nodes.get(n.parent);
    }
    return out;
  }

  effectiveDepth(id: string): number {
    const path = this.lineage(id).reverse();
    let eff: number | null = null;
    for (const n of path) {
      const inherited: number = eff === null ? n.depth : eff - 1;
      eff = inherited < 0 ? 0 : n.depth < inherited ? n.depth : inherited;
    }
    return eff ?? 0;
  }

  limitOf(target: string): { limit: bigint; capacity: boolean } {
    const [kind, id, d] = JSON.parse(target) as [string, string, string];
    if (kind === 'P') return { limit: this.policyDims.get(id) as bigint, capacity: id === 'global-capital' };
    const n = this.nodes.get(id) as MNode;
    return d === 'capital' ? { limit: n.capital as bigint, capacity: true } : { limit: n.count as bigint, capacity: false };
  }

  /** Recomputed from every reservation, every time. */
  balance(target: string): ModelBalance {
    const b: ModelBalance = { reserved: 0n, consumed: 0n, restored: 0n };
    for (const r of this.reservations.values()) {
      for (const d of r.demands) {
        for (const l of d.legs) {
          if (l.target !== target) continue;
          if (r.active) b.reserved += d.reserved - d.consumed;
          b.consumed += d.consumed;
          if (l.capacity) b.restored += d.restored;
        }
      }
    }
    return b;
  }

  available(target: string): bigint {
    const { limit, capacity } = this.limitOf(target);
    const b = this.balance(target);
    return limit - b.consumed - b.reserved + (capacity ? b.restored : 0n);
  }

  targets(): string[] {
    const out: string[] = [];
    for (const n of this.nodes.values()) {
      if (n.capital !== null) out.push(JSON.stringify(['N', n.id, 'capital']));
      if (n.count !== null) out.push(JSON.stringify(['N', n.id, 'count']));
    }
    for (const k of this.policyDims.keys()) out.push(JSON.stringify(['P', k, '']));
    return out;
  }

  // --- Transitions: return the refusal code, or 'OK' -------------------------------

  #validity(path: MNode[]): string | null {
    for (const n of [...path].reverse()) {
      if (n.revoked) return 'AUTHORITY_REVOKED';
      if (this.t < n.nb) return 'AUTHORITY_NOT_YET_VALID';
      if (this.t >= n.ea) return 'AUTHORITY_EXPIRED';
    }
    return null;
  }

  apply(op: Op): { code: string; violations: string[] } {
    const ok = { code: 'OK', violations: [] };
    const no = (code: string, violations: string[] = []) => ({ code, violations });
    switch (op.kind) {
      case 'TICK':
        this.t += op.seconds;
        return ok;
      case 'ROOT':
      case 'DELEGATE': {
        const g = op.grant;
        const id = authorityId(g);
        if (this.nodes.has(id)) return no('AUTHORITY_ALREADY_REGISTERED');
        if (this.t >= g.expiresAt) return no('AUTHORITY_EXPIRED');
        const node = toNode(g);
        if (op.kind === 'DELEGATE') {
          const parentId = node.parent as string;
          const path = this.lineage(parentId);
          const invalid = this.#validity(path);
          if (invalid !== null) return no(invalid);
          const parent = path[0] as MNode;
          const v: string[] = [];
          const eff = this.effectiveDepth(parentId);
          if (eff < 1 || (node.depth > 0 && node.depth > eff - 1)) v.push('DELEGATION_DEPTH_EXCEEDED');
          if (node.nb < parent.nb || node.ea > parent.ea) v.push('DELEGATION_WIDENS_WINDOW');
          if (!node.modules.every((m) => parent.modules.includes(m))) v.push('DELEGATION_WIDENS_SET');
          if (node.capital !== null && parent.capital !== null && node.capital > parent.capital) v.push('DELEGATION_WIDENS_LIMIT');
          if (node.count !== null && parent.count !== null && node.count > parent.count) v.push('DELEGATION_WIDENS_LIMIT');
          if (v.length > 0) return no('DELEGATION_REFUSED', v.sort());
        }
        this.nodes.set(id, node);
        return ok;
      }
      case 'REVOKE': {
        for (const n of this.lineage(op.target)) if (n.revoked) return no('AUTHORITY_REVOKED');
        (this.nodes.get(op.target) as MNode).revoked = true;
        return ok;
      }
      case 'RESERVE': {
        const p = op.plan;
        const path = this.lineage(p.authority);
        const invalid = this.#validity(path);
        if (invalid !== null) return no(invalid);
        const mk = p.module.moduleDigest;
        if (!path.every((n) => n.modules.includes(mk))) return no('MODULE_NOT_PERMITTED');
        const rid = reservationIdFor(p.action, p.generation);
        if (this.reservations.has(rid)) return no('RESERVATION_EXISTS');
        const a = this.actions.get(p.action);
        if (a !== undefined && a.open !== null) return no('PREVIOUS_GENERATION_OPEN');
        if (p.generation !== (a === undefined ? 1n : a.last + 1n)) return no('GENERATION_OUT_OF_SEQUENCE');
        const capLegs: MLeg[] = path.filter((n) => n.capital !== null).map((n) => ({ target: JSON.stringify(['N', n.id, 'capital']), capacity: true }));
        if (capLegs.length === 0) return no('UNBOUNDED_CONTRIBUTION');
        if (this.policyDims.has('global-capital')) capLegs.push({ target: JSON.stringify(['P', 'global-capital', '']), capacity: true });
        const demands: MDemand[] = [{ legs: capLegs, reserved: (p.contributions[0] as ChargePlan['contributions'][number]).quantity.atoms, consumed: 0n, restored: 0n }];
        if (p.contributions.length > 1) {
          const countLegs: MLeg[] = path.filter((n) => n.count !== null).map((n) => ({ target: JSON.stringify(['N', n.id, 'count']), capacity: false }));
          if (this.policyDims.has('global-count')) countLegs.push({ target: JSON.stringify(['P', 'global-count', '']), capacity: false });
          demands.push({ legs: countLegs, reserved: 1n, consumed: 0n, restored: 0n });
        }
        const need = new Map<string, bigint>();
        for (const d of demands) for (const l of d.legs) need.set(l.target, (need.get(l.target) ?? 0n) + d.reserved);
        for (const [target, amount] of need) if (amount > this.available(target)) return no('LEDGER_LIMIT_EXCEEDED');
        this.reservations.set(rid, { id: rid, action: p.action, generation: p.generation, lineage: path.map((n) => n.id), active: true, demands });
        const prev = this.actions.get(p.action);
        this.actions.set(p.action, { last: p.generation, open: rid, withCount: p.contributions.length > 1, module: MODULES.find((m) => m.moduleDigest === mk) as ModuleRefInput, leaf: prev?.leaf ?? p.authority });
        return ok;
      }
      case 'CONSUME':
      case 'CLOSE':
      case 'RESTORE': {
        const r = this.reservations.get(op.reservation);
        if (r === undefined) return no('RESERVATION_UNKNOWN');
        if (r.generation !== op.generation) return no('RESERVATION_ID_MISMATCH');
        if (op.kind === 'CONSUME') {
          if (!r.active) return no('RESERVATION_CLOSED');
          if (!op.amounts.some((x) => x > 0n)) return no('ACCOUNTING_SHAPE_INVALID');
          for (let i = 0; i < r.demands.length; i += 1) {
            const d = r.demands[i] as MDemand;
            if ((op.amounts[i] as bigint) > d.reserved - d.consumed) return no('CONSUME_EXCEEDS_RESERVED');
          }
          r.demands.forEach((d, i) => (d.consumed += op.amounts[i] as bigint));
          return ok;
        }
        if (op.kind === 'CLOSE') {
          if (!r.active) return no('RESERVATION_CLOSED');
          r.active = false;
          const a = this.actions.get(r.action);
          if (a !== undefined && a.open === r.id) a.open = null;
          return ok;
        }
        if (!op.amounts.some((x) => x > 0n)) return no('ACCOUNTING_SHAPE_INVALID');
        for (let i = 0; i < r.demands.length; i += 1) {
          const d = r.demands[i] as MDemand;
          const x = op.amounts[i] as bigint;
          if (x > d.consumed - d.restored) return no('RESTORE_EXCEEDS_CONSUMED');
          if (x > 0n && !d.legs.some((l) => l.capacity)) return no('RESTORE_NOT_PERMITTED');
        }
        r.demands.forEach((d, i) => (d.restored += op.amounts[i] as bigint));
        return ok;
      }
    }
  }
}

function toNode(g: AuthorityGrant): MNode {
  let modules: string[] = [];
  let cap: bigint | null = null;
  let cnt: bigint | null = null;
  let depth = 0;
  for (const t of g.terms) {
    if (t.kind === 'SET' && t.vocabulary === 'MODULES') modules = t.members.map((m) => m.moduleDigest);
    if (t.kind === 'LEDGER_DIMENSION' && t.dimensionId === 'capital') cap = t.limit.atoms;
    if (t.kind === 'LEDGER_DIMENSION' && t.dimensionId === 'count') cnt = t.limit.atoms;
    if (t.kind === 'RIGHT' && t.right === 'DELEGATE') depth = t.maxDepth;
  }
  return {
    id: authorityId(g),
    parent: g.lineage.kind === 'DELEGATION' ? g.lineage.parent : null,
    holder: { kind: g.holder.kind, value: g.holder.value },
    nb: g.notBefore,
    ea: g.expiresAt,
    modules,
    capital: cap,
    count: cnt,
    depth,
    revoked: false,
  };
}

// --- Generation --------------------------------------------------------------------------

function holderFor(serial: number): PartyIdInput {
  return address((0x30 + (serial % 200)).toString(16).padStart(2, '0'));
}

function grantTerms(mods: readonly ModuleRefInput[], cap: bigint | null, cnt: bigint | null, depth: number) {
  const terms: Parameters<typeof validateAuthorityGrant>[0]['terms'][number][] = [{ kind: 'SET', vocabulary: 'MODULES', members: mods }];
  if (depth > 0) terms.push({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: depth });
  if (cap !== null) terms.push(dim('capital', cap));
  if (cnt !== null) terms.push(dim('count', cnt, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' }));
  return terms;
}

/** The next operation, drawn from the model's current state. */
export function nextOp(rand: () => number, m: Model, principal: PartyIdInput, serial: number): Op {
  const nodes = [...m.nodes.values()];
  const reservations = [...m.reservations.values()];
  const roll = rand();
  if (nodes.length === 0 || roll < 0.06) {
    const g = must(
      validateAuthorityGrant({
        lineage: { kind: 'ROOT', issuer: principal },
        principal,
        holder: holderFor(serial),
        notBefore: m.t,
        expiresAt: m.t + BigInt(int(rand, 5_000, 60_000)),
        terms: grantTerms(rand() < 0.8 ? MODULES : [pick(rand, MODULES)], rand() < 0.9 ? units(int(rand, 50, 400)) : null, rand() < 0.5 ? BigInt(int(rand, 2, 8)) : null, int(rand, 0, 3)),
        nonce: BigInt(serial),
      }),
    );
    return { kind: 'ROOT', grant: g };
  }
  if (roll < 0.2) {
    const parent = pick(rand, nodes);
    const widen = rand() < 0.2;
    const wideKind = int(rand, 0, 3);
    const cap = parent.capital === null ? (rand() < 0.3 ? units(int(rand, 10, 100)) : null) : widen && wideKind === 0 ? parent.capital + 1n : rand() < 0.2 ? null : BigInt(int(rand, 0, Number(parent.capital)));
    const cnt = parent.count === null ? null : widen && wideKind === 3 ? parent.count + 1n : BigInt(int(rand, 0, Number(parent.count)));
    const mods = widen && wideKind === 2 ? MODULES : MODULES.filter((x) => parent.modules.includes(moduleKey(x)) && rand() < 0.8);
    const nb = parent.nb + (widen && wideKind === 1 ? -1n : 0n);
    const ea = widen && wideKind === 1 ? parent.ea : parent.ea - BigInt(int(rand, 0, 2_000));
    const depthAllowed = m.effectiveDepth(parent.id) - 1;
    const depth = rand() < 0.1 ? int(rand, 1, 3) : depthAllowed > 0 ? int(rand, 0, depthAllowed) : 0;
    const g = must(
      validateAuthorityGrant({
        lineage: { kind: 'DELEGATION', parent: parent.id, issuer: parent.holder },
        principal,
        holder: holderFor(serial),
        notBefore: nb,
        expiresAt: ea > nb ? ea : nb + 1n,
        terms: grantTerms(mods, cap, cnt, depth),
        nonce: BigInt(serial),
      }),
    );
    return { kind: 'DELEGATE', grant: g };
  }
  if (roll < 0.55) {
    // Occasionally retry an existing action (possibly at the wrong generation), otherwise a new one.
    const retry = rand() < 0.25 ? pick(rand, [...m.actions.entries()]) : undefined;
    if (retry !== undefined) {
      const [action, a] = retry;
      const generation = a.last + (rand() < 0.8 ? 1n : 2n);
      const leaf = m.nodes.get(a.leaf) as MNode;
      const contributions = [contribution(capital(units(int(rand, 1, 60))))];
      if (a.withCount) contributions.push(contribution(count(1n), { required: false }));
      return { kind: 'RESERVE', plan: planFor(leaf, principal, action, generation, a.module, contributions) };
    }
    const leaf = pick(rand, nodes);
    const withCount = rand() < 0.4;
    const contributions = [contribution(capital(units(int(rand, 1, 120))))];
    if (withCount) contributions.push(contribution(count(1n), { required: false }));
    return { kind: 'RESERVE', plan: planFor(leaf, principal, digestOf(`action:${serial}`), 1n, pick(rand, MODULES), contributions) };
  }
  if (roll < 0.6) return { kind: 'REVOKE', target: pick(rand, nodes).id };
  if (roll < 0.66) return { kind: 'TICK', seconds: BigInt(int(rand, 0, 4_000)) };
  if (reservations.length === 0) return { kind: 'TICK', seconds: 1n };
  const r = pick(rand, reservations);
  const generation = rand() < 0.05 ? r.generation + 1n : r.generation;
  if (roll < 0.8) {
    const amounts = r.demands.map((d) => {
      const room = d.reserved - d.consumed;
      return rand() < 0.1 ? room + 1n : room === 0n ? 0n : BigInt(int(rand, 0, Number(room)));
    });
    return { kind: 'CONSUME', reservation: r.id, generation, amounts };
  }
  if (roll < 0.9) return { kind: 'CLOSE', reservation: r.id, generation };
  const amounts = r.demands.map((d, i) => {
    const room = d.consumed - d.restored;
    if (i > 0) return rand() < 0.1 ? 1n : 0n; // count budgets never restore; sometimes try
    return rand() < 0.1 ? room + 1n : room === 0n ? 0n : BigInt(int(rand, 0, Number(room)));
  });
  return { kind: 'RESTORE', reservation: r.id, generation, amounts };
}

function planFor(leaf: MNode, principal: PartyIdInput, action: string, generation: bigint, module: ModuleRefInput, contributions: readonly ContributionInput[]): ChargePlan {
  return must(
    validateChargePlan({
      principal,
      authority: leaf.id,
      actor: leaf.holder,
      action,
      generation,
      module,
      implementation: implFor(module),
      contributions,
    }),
  );
}
