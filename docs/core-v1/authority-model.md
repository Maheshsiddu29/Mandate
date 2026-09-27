# Mandate Core v1 — Authority and delegation model

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> Hierarchical delegation is specified here so that nothing built in 7B–7H
> assumes one principal and one agent. Its full implementation is Phase 9.

## Contents

1. [Parties](#1-parties)
2. [Grants](#2-grants)
3. [Authority terms](#3-authority-terms)
4. [The meet: how a child's authority is bounded by its parent's](#4-the-meet-how-a-childs-authority-is-bounded-by-its-parents)
5. [Lineage validity](#5-lineage-validity)
6. [Delegation validity](#6-delegation-validity)
7. [Revocation and expiry](#7-revocation-and-expiry)
8. [Principal policy and principal-global invariants](#8-principal-policy-and-principal-global-invariants)
9. [Shape of the authority graph](#9-shape-of-the-authority-graph)
10. [What is deferred](#10-what-is-deferred)

---

## 1. Parties

| Role | Meaning | Identity |
| --- | --- | --- |
| **Principal** | Owns the economic resources at stake; the root issuer of an authority tree | `PartyId` |
| **Holder** | The party a grant names; may act under it and, if permitted, delegate from it | `PartyId` |
| **Actor** | The holder of the leaf node an action is proposed under; signs the `ActionIntent` | `PartyId` |
| **Issuer** | The party that signs a grant: the principal for a root, the parent's holder for a delegation | `PartyId` |

An agent is any non-principal holder. One party may hold many nodes, in the
same tree or in different principals' trees; each node is separate authority
with its own ledger entries. Nothing in Core assumes "agent identity == one
key" beyond the `PartyId` in a grant, which is the boundary design
[§8.4](../mandate-design.md#84-agent-identity) asked to keep.

`PartyId` is the kernel's existing type (scheme + key; `eip155-address` today),
reused unchanged. A holder's key rotation is a new delegation to the new key
plus revocation of the old node in v1; continuity of identity across rotation
is deferred (§9).

## 2. Grants

A grant is the only way authority comes into existence.

```text
AuthorityGrant {
  version          Core grant schema version; unknown versions reject
  parent           AuthorityId | NONE          NONE ⇔ root (a Core mandate)
  principal        PartyId                     the tree's principal
  issuer           PartyId                     root: = principal; delegation: = parent.holder
  holder           PartyId
  validity         { notBefore, expiresAt }    required; notBefore ≤ t < expiresAt
  terms            AuthorityTerms              §3
  nonce            uint64                      distinguishes otherwise identical grants
}
AuthorityId = H("mandate-core/v1/authority", AuthorityGrant)
signature   = issuer's signature over AuthorityId under a Core signing domain
```

Why each field exists, and nothing else:

| Field | Needed because |
| --- | --- |
| `parent` | lineage is the only source of authority; a grant without a verifiable parent is a root, and roots are signed only by principals |
| `principal` | restated so the digest commits to whose resources are at stake; checked equal to the root's issuer at every level, never trusted |
| `issuer` | whose signature makes the grant valid; must equal the parent's holder |
| `holder` | who may act under it |
| `validity` | bounded validity is mandatory ([design §7.4 rule 6](../mandate-design.md#74-design-rules-for-the-mandate-schema)); there is no "until revoked" grant |
| `terms` | the authority itself |
| `nonce` | two grants with identical terms to the same holder are two independent nodes, each with its own ledger entries |
| `version` | a verifier that does not understand a version rejects; unknown fields are never interpreted leniently |

A human-readable label may accompany a grant as an audit annotation outside the
digested object; no decision reads it.

**Terminology.** A **Core mandate** is a root grant; its `AuthorityId` is the
`MandateId`. A **delegation** is a non-root grant; its `AuthorityId` is the
`DelegationId`. `AuthorityId` is the common identity of both. The Phase 6 MCE v2
mandate is a different thing — a single-use EVM execution artifact the EVM
adapter derives per reservation ([architecture.md §7](architecture.md#7-relationship-to-frozen-phase-6)).

**Grants are never consumed and never edited.** Changing any term produces a
different `AuthorityId` and a different node with a fresh ledger; the old node
remains valid until it expires or is revoked. Replacing authority is therefore
"issue new, revoke old", and both steps are receipted.

## 3. Authority terms

Terms fall into seven kinds. They are distinct because they compose
differently under delegation (§4) and are enforced differently at action time
([authority-ledger.md §2](authority-ledger.md#2-constraint-taxonomy)). Forcing
them into one numeric counter is exactly what this taxonomy exists to prevent.

| Kind | Examples | Enforced by |
| --- | --- | --- |
| **Set membership** | allowed domain modules (each an exact `ModuleRef`), markets, assets, venues, action types, recipients, enforcement adapters | coverage check per action |
| **Boolean right** | `OPEN_RISK`, `REDUCE_RISK`, `TRANSFER_OUT`, `DELEGATE` | coverage check per action |
| **Per-action bound** | max order notional, max order leverage, max slippage bps, min credit | coverage check against the action's own parameters |
| **Temporal** | the grant's validity window; optional per-domain trading windows | lineage validity and coverage |
| **Ledger dimension** | capital 1,200 USDG; 50 actions; 0.5 BTC position; 5,000 USD committed BTC notional | ledger reservation at every node on the charging path: the lineage, then the principal policy |
| **State invariant** | health factor ≥ 1.5; account leverage ≤ 3x; marked BTC exposure ≤ 20,000 USD | invariant evaluation over projected state |
| **State policy** | admitted sources and maximum age per state kind | state admission |

Also a term, with its own composition rule: **delegation depth** — how many
further levels may be delegated below this node (0 = may not delegate). A
`DELEGATE` right with depth 0 is incoherent and rejects at parse.

All terms are **closed-world**: an unlisted market, right, adapter or domain is
not granted ([design §7.4 rule 2](../mandate-design.md#74-design-rules-for-the-mandate-schema)).
Adding a vocabulary entry in a later version never widens a grant signed under
an earlier one.

A **bound** and an **invariant** can look alike and are not the same:
"max leverage 3x" as a per-action bound limits the leverage parameter of the
order; as a state invariant it limits the account's resulting effective
leverage after projection. An order at 2x on an account already at 2.9x passes
the first and may fail the second. A grant states which it means, and may state
both.

## 4. The meet: how a child's authority is bounded by its parent's

**Core rule: child authority ⊆ parent authority.** It is enforced twice:

1. **At delegation** (§6): a grant that is not ⊆ its parent is refused and never
   enters the ledger.
2. **At every action**: Core does not trust that step 1 happened. The effective
   authority of the acting node is the **meet** of every grant on its lineage,
   computed afresh for each decision. A widening grant that somehow reached the
   ledger still cannot widen anything, because the meet is at most its parent.

| Term kind | `meet(parent, child)` | Child valid at delegation iff |
| --- | --- | --- |
| Set | `parent ∩ child` | `child ⊆ parent` |
| Boolean right | `parent ∧ child` | `child ⇒ parent` |
| Max bound (a ceiling) | `min(parent, child)` | restated, and `child ≤ parent` |
| Min bound (a floor) | `max(parent, child)` | restated, and `child ≥ parent` |
| Validity window | intersection | `child.notBefore ≥ parent.notBefore ∧ child.expiresAt ≤ parent.expiresAt` |
| State invariants | union (all must hold) | every parent invariant present in the child with parameters no weaker |
| State policy | tighter age bound; intersection of admitted sources | restated, and no weaker, per state kind |
| Delegation depth | `min(parent − 1, child)` | `child ≤ parent − 1` |
| Ledger dimension | **not meet-reduced** — enforced separately at every node on the lineage that grants it | for a dimension the parent grants, the child's limit ≤ the parent's, same measure |

**Ledger dimensions are enforced along the path, not merged.** A reservation by
a leaf places a leg at the leaf and at every ancestor granting the same
dimension and scope, all or nothing
([authority-ledger.md §6](authority-ledger.md#6-charging-paths)). A child's
limit is a ceiling, not a carve-out: two siblings may each be granted 1,000
USDG under a parent with 1,200, and the parent's own ledger entry stops them
consuming 2,000 together ([examples.md §C](examples.md#c-multi-agent-shared-authority)).
A principal wanting hard partitions grants sibling limits that sum to at most
the parent's.

**Comparability.** A child term is comparable with a parent term only if they
constrain the same thing in the same measure: same set vocabulary, same bound
identifier and polarity, same dimension identifier, scope, quantity kind and
unit, with decimals rescaled exactly. A child term with no comparable parent
term is an **added** constraint and is always permitted — it can only tighten.
A parent term absent from the child is never removed: at action time the meet
and the path rule enforce every ancestor's terms whatever the child says. There
is therefore no way to express "remove a required invariant" in a child grant.

**Restatement at registration.** Absence has two different readings, and the
model must not depend on a reader choosing the right one. For sets and rights
absence already narrows (closed world: not granted). For per-action bounds,
state invariants and state policy, a grant document that omits a parent's term
reads to anyone inspecting it as "no such limit". So a delegation must
**restate** every parent bound, invariant and state-policy term, equal or
tighter, and is refused at registration if it omits one
(`DELEGATION_DROPS_BOUND`, `DELEGATION_DROPS_INVARIANT`,
`DELEGATION_DROPS_STATE_POLICY`). Every grant is then self-describing: its own
terms are its effective terms, and the action-time meet is an independent
defence rather than the only one. Ledger dimensions are the exception: they
need not be restated, because the path rule charges the parent's own leg and
the parent's ledger entry is the constraint
([examples.md §D](examples.md#d-hierarchical-delegation) is where the
contradiction between "inherited" and "refused if dropped" surfaced).

A child term that constrains the same identifier in an incomparable measure
(parent caps `capital` in USDG, child caps `capital` in USD) is refused at
delegation with `DELEGATION_TERM_INCOMPARABLE`. It is not converted: USDG and
USD are different units, and a conversion would need a valuation the grant does
not carry.

What a delegation can never do, and why the model makes each impossible:

| Forbidden widening | Blocked by |
| --- | --- |
| increase capital | ledger dimension limit ≤ parent; parent's leg charged regardless |
| add a forbidden market | set meet is an intersection |
| extend expiry beyond parent | window meet; lineage validity checks every node |
| increase leverage | max-bound meet is `min`; invariant parameters no weaker |
| remove required invariants | invariants compose by union |
| expand recipient rights | recipient set is an intersection; `TRANSFER_OUT` is `AND` |
| create authority the parent never had | every term kind's meet is bounded by the parent's; a term the parent does not have is either inherited-absent (closed world: not granted) or an added restriction |
| delegate further than permitted | depth meet; `DELEGATE` right is `AND` |

## 5. Lineage validity

The lineage of an action is the path `leaf → … → root` from the node named in
the intent. It is valid at decision time `t` iff, for every node:

1. the grant parses at a known version, within every declared bound;
2. the signature verifies for `issuer` over `AuthorityId`;
3. root: `parent = NONE`, `issuer = principal`; otherwise `issuer = parent.holder`;
4. `principal` equals the root's `principal`;
5. `notBefore ≤ t < expiresAt`;
6. neither it nor any ancestor is in the ledger's revocation set as of the
   ledger version the decision reads;
7. depth: the lineage length does not exceed the root's delegation depth + 1 and
   each node's depth obeys §4; the total depth is also bounded by a Core
   constant fixed in 7B, so lineage resolution is bounded work;

and the actor is the leaf's `holder`, the intent's `principal` equals the
root's, and the principal has a registered principal policy (§8) at that ledger
version.

Failure reasons are distinct, because the operational responses differ:
`AUTHORITY_UNKNOWN` (a node is not in the ledger), `AUTHORITY_SIGNATURE_INVALID`,
`AUTHORITY_ISSUER_MISMATCH`, `AUTHORITY_PRINCIPAL_MISMATCH`,
`AUTHORITY_NOT_YET_VALID`, `AUTHORITY_EXPIRED`, `AUTHORITY_REVOKED`,
`AUTHORITY_DEPTH_EXCEEDED`, `ACTOR_NOT_HOLDER`, `PRINCIPAL_POLICY_MISSING`.
The reason identifies the node that failed.

**Where grants live.** Grants are registered to the principal's ledger before
they can be used; an action cannot introduce a grant inline. Registration runs
the delegation-validity check (§6) and records the grant's ledger dimensions.
This makes the ledger the single source of truth for which nodes exist, which
is what lets revocation be evaluated at the same ledger version as the
reservation it would block.

## 6. Delegation validity

`RegisterGrant(g)` accepts a delegation only if:

- `g.parent` is registered, its lineage is valid at registration time, and it
  holds `DELEGATE` with depth ≥ 1;
- `g` is ⊆ its parent by every rule in §4's right-hand column, restating every
  parent bound, invariant and state-policy term;
- `g.validity` is inside the parent's;
- every ledger dimension in `g` either matches a parent dimension in measure
  with a limit ≤ the parent's, or is new (an added constraint);
- `g` is signed by the parent's holder.

Rejections: `DELEGATION_WIDENS_SET`, `DELEGATION_WIDENS_RIGHT`,
`DELEGATION_WIDENS_BOUND`, `DELEGATION_WIDENS_WINDOW`,
`DELEGATION_WIDENS_LIMIT`, `DELEGATION_DROPS_BOUND`,
`DELEGATION_DROPS_INVARIANT`, `DELEGATION_WEAKENS_INVARIANT`,
`DELEGATION_DROPS_STATE_POLICY`, `DELEGATION_WEAKENS_STATE_POLICY`,
`DELEGATION_DEPTH_EXCEEDED`, `DELEGATION_TERM_INCOMPARABLE`, each naming the
term. All violations are reported, not only the first.

Registration is a ledger transaction like any other, and is receipted.

## 7. Revocation and expiry

```text
Revocation {
  target        AuthorityId
  issuer        PartyId          issuer of the target or of any ancestor
  effectiveAt   UnixSeconds      ≤ the registration time; revocation is never scheduled into the future in v1
  nonce         uint64
}
```

- **Scope.** Revoking a node revokes its whole subtree. The issuer of any
  ancestor may revoke a descendant; a descendant can never revoke an ancestor.
- **Irreversible.** There is no un-revoke. Restoring authority is a new grant
  with a new `AuthorityId`.
- **Effect on new actions.** From the ledger version that records it, no node in
  the subtree passes lineage validity; nothing new is reserved.
- **Effect on in-flight actions.** Existing reservations are **not** released
  by revocation. An order already on a venue may still fill; releasing its
  reservation would make the ledger claim authority is available that the venue
  may yet consume. Reservations under a revoked node continue to reconcile
  normally and close on observed outcomes. Revocation does ask the adapter to
  stop issuing artifacts and to take its enforcement-side revocation step
  (cancel open orders, revoke a signer permission or allowance) — which is
  adapter-specific and has adapter-specific latency
  ([enforcement-adapters.md §3](enforcement-adapters.md#3-non-bypassability)).
- **Expiry** needs no statement: a node is invalid from `expiresAt`. In-flight
  reservations are treated as under revocation. The enforcement point's own
  expiry (chain time for the EVM adapter) is additionally bounded by the
  reservation's attempt ceiling, which never exceeds the grant's `expiresAt`.
- **Risk-reducing actions after revocation or expiry.** In v1, a revoked or
  expired node authorizes nothing, including reductions. Closing its positions
  is done by an ancestor under the ancestor's own authority. A narrowly
  specified exception (reduce-only, venue-enforced) is an open question, not a
  v1 behaviour.

## 8. Principal policy and principal-global invariants

A principal with several roots has granted several independent authorities.
That must not be read as an implicit aggregate grant — Root A allowing 7,000 USD
of BTC exposure and Root B allowing 5,000 does not mean "the principal allows
12,000" — and it must not leave the aggregate unbounded by accident either. Core
v1 therefore separates two things:

| | **Root-local terms** | **Principal-global invariants** |
| --- | --- | --- |
| Meaning | authority granted through one delegation tree | constraints over the principal's aggregate economic state, whichever root or path an action uses |
| Examples | Bot A may consume ≤ 7,000 USD; Bot B ≤ 5,000 USD; SpotAgent trades only AAPL | BTC gross exposure ≤ 10,000 USD; total capital allocated ≤ 100,000 USDG; single-issuer exposure ≤ 15 %; aggregate debt ≤ 20,000 USDC |
| Carried by | authority grants (§2) | the **principal policy** |
| Grants authority? | yes | **no** — it only constrains |
| Composes by | the meet and path charging along one lineage | applying to every action of the principal, as the last node of every charging path |

### 8.1 The principal policy object

**Decision:** principal-global invariants are a distinct canonical Core object,
the principal policy — not terms of a root grant, and not a super-root.

```text
PrincipalPolicy {
  version
  principal          PartyId
  sequence           uint64                strictly greater than the current policy's
  globalDimensions   list<DimensionGrant>  principal-global ledger dimensions
  globalInvariants   list<InvariantRef>    principal-global state invariants
  globalStatePolicy  StatePolicy           combined with each lineage's; the tighter bound wins
  nonce              uint64
}
PolicyId  = H("mandate-core/v1/principal-policy", PrincipalPolicy)
signature = the principal's signature over PolicyId, under a Core signing domain
            distinct from the grant domain, so neither can stand in for the other
```

Why not the alternatives:

- **Terms of a root grant** bind only that root's tree. A global limit placed on
  Root A says nothing about Root B, which is the escape this section closes.
- **A super-root** that every root descends from would collapse the forest into
  one tree, force all authority through one node, and — because a root grants —
  turn a constraint into a grant. The principal policy grants nothing, and no
  action is ever taken "under" it.

### 8.2 Rules

- **Mandatory and explicit.** The ledger refuses the first root grant of a
  principal until a principal policy is registered, and lineage validity
  requires one (`PRINCIPAL_POLICY_MISSING`). The policy may be empty. An empty
  policy is the principal's explicit statement that its roots are independent;
  Core never infers an aggregate limit, and never infers an aggregate grant.
- **Applies to every action (AUTH-GLOBAL-1).** Every decision evaluates
  lineage-local authority *and* the principal policy: its dimensions are legs on
  every charging path ([authority-ledger.md §6](authority-ledger.md#6-charging-paths)),
  its invariants are evaluated over `S ⊕ Pending(L)` — all of the principal's
  admitted state and every pending reservation, under every root — and its state
  policy tightens every lineage's. An action cannot escape a principal-global
  invariant by using a different authority root.
- **Counts what already exists.** A principal-global dimension introduced by a
  new policy is initialized, in the same ledger commit, from the ledger's open
  position lots and active reservations that match it, so adding
  "BTC ≤ 10,000" while 6,000 is already held starts at 6,000, not 0.
  Replacing a policy keeps the consumption history of every dimension it keeps
  (same `dimensionId`, kind, unit and scope): consumption is a fact, not a term.
- **Replaceable only by the principal, never revoked.** A new signed policy
  with a higher `sequence` replaces the current one from the ledger version
  that registers it. Tightening never releases a reservation; if occupancy
  already exceeds a tightened limit the dimension is `BREACHED` and blocks
  increases. Loosening is the principal's prerogative and is receipted like
  every other policy change. Agents cannot register, replace or narrow a policy.
- **Not future-scheduled in v1.** A policy takes effect at its registration
  version.

## 9. Shape of the authority graph

- **A forest of trees per principal, under one principal policy.** Every node
  has exactly one parent. A principal may have several roots. Each root's tree
  has its own ledger dimensions, and two roots never charge each other's; every
  tree is charged by the principal policy's principal-global dimensions and
  checked against its principal-global invariants (§8).
- **No multi-parent nodes in v1.** A node that draws on two parents' budgets
  makes "child ⊆ parent" ambiguous (which parent?) and makes path charging a
  DAG problem. Deferred.
- **No cross-principal authority.** One principal's ledger never charges
  another's. Agent-to-agent authority across principals is Phase 9.
- **Bounded depth**, as §5.

```text
Principal (root: MandateId)
   │
   └── Portfolio Agent        (DelegationId P1)
          ├── Spot Agent      (DelegationId S1, parent P1)
          ├── Perp Agent      (DelegationId R1, parent P1)
          └── Yield Agent     (DelegationId Y1, parent P1)
```

A Perp Agent reservation of 600 USDG capital places legs at R1, P1 and the root
— whichever of them grant a `capital` dimension — and fails if any leg fails.

## 10. What is deferred

| Deferred | Why |
| --- | --- |
| Multi-parent nodes, pooled budgets across trees | Ambiguous subset semantics; DAG charging. Aggregate *constraints* across trees are the principal policy (§8); aggregate *authority* across trees is not modelled |
| Threshold or multi-signature issuers | Needs a signature-scheme decision beyond the kernel's single `eip712-secp256k1` |
| Contract principals (ERC-1271) | The Phase 6 gate does not support them; a Core grant could, but its EVM enforcement could not |
| Key rotation with continuous identity | Needs an identity layer; v1 uses re-delegation |
| Scheduled (future-dated) revocation | Complicates "revoked as of version v"; v1 revocations take effect at registration |
| Partial revocation (narrowing a live node) | Expressible today as issue-narrower-then-revoke |
| Agent-to-agent authority proofs across principals | Phase 9 |
| Risk-reducing exceptions after revocation | Open question ([README.md](README.md#open-questions)) |
