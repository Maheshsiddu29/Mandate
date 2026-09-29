/**
 * Compilation into Core (portfolio-mandate.md §12).
 *
 * A verified Portfolio Mandate becomes ordinary Core objects, registered
 * through the unchanged control engine — never a second ledger:
 *
 * ```text
 * PrincipalPolicy   empty: portfolio-wide limits live on the root, where LEDGER-5 needs a granting node
 * root grant        issuer = holder = the principal; DELEGATE depth 1; the portfolio window;
 *                   MODULES, ADAPTERS, ACTION_TYPES, MARKETS, VENUES, RECIPIENTS from the portfolio scope;
 *                   OPEN_RISK; one LEDGER_DIMENSION per portfolio limit
 * delegation × N    issuer = the principal (the root's holder); holder = the agent; the agent's window;
 *                   the same sets from the agent's scope; OPEN_RISK; one LEDGER_DIMENSION per listed hard
 *                   maximum; the binding's domain terms (the perps agent's perp.max-leverage)
 * ```
 *
 * Registration runs the ledger's own delegation check — child ⊆ parent by
 * Core's rules — so the portfolio's derivation is checked a second time by an
 * independent implementation, and at every action Core evaluates the meet of
 * the lineage and charges every leg: the agent's own dimension and the
 * root's portfolio-wide one, atomically.
 *
 * Each `ChildExecutionAuthorization` maps to exactly one Core action: the
 * agent's delegation, the agent as actor, the binding's exact module,
 * adapter, target, resources and payload, the child's window, and a nonce
 * taken from the child's digest — so the action's identity commits to the
 * child, and a child cannot be reserved as another.
 */

import { err, ok, type Result } from '@mandate/kernel';
import {
  actionPayloadDigest,
  authorityId,
  hexToBytes,
  partyIdInputOf,
  principalAsAgent,
  validateActionEnvelope,
  validateAuthorityGrant,
  validateModuleRef,
  validatePrincipalPolicy,
  type ActionEnvelope,
  type AdapterRefInput,
  type AuthorityGrant,
  type AuthorityTermInput,
  type LedgerDimensionInput,
  type PartyIdInput,
  type PrincipalPolicy,
  type ResourceIdInput,
} from '@mandate/core';
import type { DomainModule } from '@mandate/control';
import { checkPortfolioMandate } from './authority.ts';
import { bindingFor, type DomainBinding } from './binding.ts';
import { candidateDigest, type ActionCandidate } from './candidate.ts';
import { childAuthorizationDigest, type ChildExecutionAuthorization } from './child.ts';
import { agentPolicyOf, type AgentPolicy, type PortfolioMandate } from './mandate.ts';
import { reason, type Reason } from './reasons.ts';
import { resourceTable, type ResourceTable, type ResourceVector } from './resources.ts';
import type { AuthorityScope } from './scope.ts';

export interface CompiledPortfolio {
  readonly mandate: PortfolioMandate;
  readonly policy: PrincipalPolicy;
  readonly root: AuthorityGrant;
  /** Keyed by the agent party's value; the mandate's agent order. */
  readonly delegations: ReadonlyMap<string, AuthorityGrant>;
  readonly bindings: readonly DomainBinding[];
  readonly modules: readonly DomainModule[];
  readonly adapters: readonly AdapterRefInput[];
}

function dimensions(table: ResourceTable, limits: ResourceVector): LedgerDimensionInput[] {
  return limits.map((l) => {
    const d = table.get(l.resource);
    if (d === undefined) throw new Error(`undeclared resource ${l.resource} reached compilation`);
    return {
      kind: 'LEDGER_DIMENSION',
      dimensionId: d.resource,
      limit: { kind: d.kind, unit: d.unit, decimals: d.decimals, atoms: l.atoms },
      accounting: 'CAPACITY',
      restoration: d.kind === 'POSITION_SIZE' ? 'UNITS' : 'AS_CHARGED',
      epoch: null,
      sign: 'UNSIGNED',
      scope: { asset: null, market: null, domain: d.domain, account: null },
    };
  });
}

/** The bindings a scope reaches: those whose domain and action kind it names. */
function reached(bindings: readonly DomainBinding[], scope: AuthorityScope): DomainBinding[] {
  return bindings.filter((b) => scope.domains.includes(b.domain) && scope.actions.includes(b.kind));
}

function key(r: ResourceIdInput): string {
  return `${r.domain} ${r.kind} ${r.localId}`;
}

function unique(rs: readonly ResourceIdInput[]): ResourceIdInput[] {
  const m = new Map<string, ResourceIdInput>();
  for (const r of rs) m.set(key(r), r);
  return [...m.values()];
}

/** Coverage terms for a scope: exact module and adapter refs, action types and the members the bindings compile. */
function coverage(bindings: readonly DomainBinding[], scope: AuthorityScope): AuthorityTermInput[] {
  const bs = reached(bindings, scope);
  const moduleRef = (b: DomainBinding) => ({ domainId: b.module.ref.domainId, moduleId: b.module.ref.moduleId, moduleVersion: b.module.ref.moduleVersion, moduleDigest: b.module.ref.moduleDigest });
  const covered = bs.map((b) => b.coverage(scope));
  return [
    { kind: 'SET', vocabulary: 'MODULES', members: bs.map(moduleRef) },
    { kind: 'SET', vocabulary: 'ADAPTERS', members: bs.map((b) => b.adapter) },
    { kind: 'SET', vocabulary: 'ACTION_TYPES', members: bs.flatMap((b) => b.actionTypes.map((t) => ({ domain: b.domain, actionType: t }))) },
    { kind: 'SET', vocabulary: 'MARKETS', members: unique(covered.flatMap((c) => c.markets)) },
    { kind: 'SET', vocabulary: 'VENUES', members: unique(covered.flatMap((c) => c.venues)) },
    { kind: 'SET', vocabulary: 'RECIPIENTS', members: unique(covered.flatMap((c) => c.recipients)) },
    { kind: 'RIGHT', right: 'OPEN_RISK' },
  ];
}

function party(p: { readonly kind: string; readonly value: string }): PartyIdInput {
  return { kind: p.kind, value: p.value };
}

/**
 * Compile a valid mandate. Refuses — with every reason — a mandate that is
 * not valid (`checkPortfolioMandate`), and one Core itself would refuse to
 * represent.
 */
export function compilePortfolio(m: PortfolioMandate, bindings: readonly DomainBinding[]): Result<CompiledPortfolio, readonly Reason[]> {
  const invalid = checkPortfolioMandate(m);
  if (invalid.length > 0) return err(invalid);
  const table = resourceTable(m.resources);
  const principal = party(m.principal);
  const policy = validatePrincipalPolicy({ principal, sequence: m.policyVersion, terms: [], nonce: m.nonce });
  if (!policy.ok) return err([reason('PORTFOLIO_MANDATE_MALFORMED', `policy:${policy.error.code}`)]);
  const root = validateAuthorityGrant({
    lineage: { kind: 'ROOT', issuer: principal },
    principal,
    // The principal holds its own root and delegates from it (examples.md §D); the role change is explicit.
    holder: party(principalAsAgent(m.principal)),
    notBefore: m.notBefore,
    expiresAt: m.expiresAt,
    terms: [...coverage(bindings, m.scope), { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 }, ...dimensions(table, m.limits)],
    nonce: m.nonce,
  });
  if (!root.ok) return err([reason('PORTFOLIO_MANDATE_MALFORMED', `root:${root.error.code}@${root.error.path}`)]);
  const rootId = authorityId(root.value);
  const delegations = new Map<string, AuthorityGrant>();
  for (const a of m.agents) {
    const extra = reached(bindings, a.scope).flatMap((b) => b.delegationTerms(a.scope));
    const g = validateAuthorityGrant({
      lineage: { kind: 'DELEGATION', parent: rootId, issuer: principal },
      principal,
      holder: party(a.agent),
      notBefore: a.notBefore,
      expiresAt: a.expiresAt,
      terms: [...coverage(bindings, a.scope), ...dimensions(table, a.hardMaxima), ...extra],
      nonce: m.nonce,
    });
    if (!g.ok) return err([reason('PORTFOLIO_MANDATE_MALFORMED', `delegation:${a.agent.value}:${g.error.code}@${g.error.path}`)]);
    delegations.set(a.agent.value, g.value);
  }
  const used = reached(bindings, m.scope);
  return ok({ mandate: m, policy: policy.value, root: root.value, delegations, bindings, modules: used.map((b) => b.module), adapters: used.map((b) => b.adapter) });
}

/** The child's nonce: the first eight bytes of its digest. The action's identity therefore commits to the child. */
export function childNonce(child: ChildExecutionAuthorization): bigint {
  const bytes = hexToBytes(childAuthorizationDigest(child));
  let n = 0n;
  for (let i = 0; i < 8; i += 1) n = (n << 8n) | BigInt(bytes[i] as number);
  return n;
}

export interface CompiledAction {
  readonly envelope: ActionEnvelope;
  readonly payload: Uint8Array;
  readonly binding: DomainBinding;
  readonly delegation: AuthorityGrant;
  readonly agent: AgentPolicy;
}

/**
 * The one Core action a child authorization compiles to. Refuses when the
 * candidate is not the child's, the agent has no delegation, or the binding
 * cannot express the candidate.
 */
export function compileAction(c: CompiledPortfolio, child: ChildExecutionAuthorization, candidate: ActionCandidate): Result<CompiledAction, Reason> {
  if (candidateDigest(candidate) !== child.candidate) return err(reason('CHILD_ACTION_MUTATED', 'candidate'));
  const agent = agentPolicyOf(c.mandate, child.agent);
  const delegation = c.delegations.get(child.agent.value);
  if (agent === null || delegation === undefined) return err(reason('AGENT_UNKNOWN', child.agent.value));
  const b = bindingFor(c.bindings, candidate.kind);
  if ('refused' in b) return err(b.refused);
  const core = b.coreAction(candidate, childAuthorizationDigest(child));
  if (core === null) return err(reason('INSTRUMENT_UNKNOWN', `core-action:${candidate.kind}`));
  const ref = b.module.ref;
  const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
  const module = validateModuleRef(moduleInput);
  if (!module.ok) return err(reason('INSTRUMENT_UNKNOWN', `module:${module.error.code}`));
  const payloadDigest = actionPayloadDigest(module.value, core.payload);
  if (!payloadDigest.ok) return err(reason('INSTRUMENT_UNKNOWN', `payload:${payloadDigest.error.code}`));
  const envelope = validateActionEnvelope({
    principal: partyIdInputOf(c.mandate.principal),
    authority: authorityId(delegation),
    actor: partyIdInputOf(child.agent),
    module: moduleInput,
    actionType: core.actionType,
    adapter: b.adapter,
    target: core.target,
    resources: [...core.resources],
    payloadDigest: payloadDigest.value,
    validFrom: child.notBefore,
    expiresAt: child.expiresAt,
    nonce: childNonce(child),
  });
  if (!envelope.ok) return err(reason('INSTRUMENT_UNKNOWN', `envelope:${envelope.error.code}@${envelope.error.path}`));
  return ok({ envelope: envelope.value, payload: core.payload, binding: b, delegation, agent });
}
