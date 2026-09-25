# ADR 0012: Jev closed-set authority boundary

- **Status:** accepted
- **Date:** 2026-09-25
- **Phase:** 5

## Context

Phase 5 attaches TypeSafe's Jev to route selection. Jev is an external,
untrusted, non-deterministic service. The product's defining invariant (INV-3)
is that the set of executions Mandate permits is identical whether a model is
present, absent, failed or adversarial.

The risk is not that the model gives bad advice. Bad advice within a set of
already-valid candidates costs execution quality, which is recoverable. The
risk is that the integration surface quietly hands the model authority — by
letting it return an object that is then trusted, by letting it name a
candidate the filter excluded, or by letting its unavailability become a reason
to relax a check.

TypeSafe's `choice` primitive returns a **named option** chosen from a map the
caller supplies, together with a probability distribution and a derived
confidence. It does not return a structured object, and it accepts at most 255
options.

## Decision

**Jev is called only after the admissible set is closed.** The router's
evaluation stage produces the complete, deterministically ranked set of
candidates that the registry admitted and the kernel passed. That array is the
only thing a selection can address.

**Jev returns a name, and the name is used only as a key.** The choice
identifiers (`route_000`, …, `ABSTAIN`) are generated locally from array
positions. They are not derived from any candidate field and carry no meaning
outside the evaluation that produced them. The selected candidate is recovered
by local array index. No field of any model response is ever parsed as an
address, an amount, a quantity, a side, a representation, a chain, an issuer,
a price, a cost or a constraint.

**A name outside the local set is a fallback, not an error and not a
selection.** The same applies to a malformed body, an unexpected status, a
timeout, a transport exception, an unusable cardinality and a confidence-policy
rejection.

**The selected candidate is re-verified by the kernel before handoff, against
current trusted state.** Jev's choice never grandfathers a route across a state
change that occurred during inference.

**The API's 255-option limit does not redefine Mandate's permissible set.** One
option is reserved for `ABSTAIN`. Above 254 admissible candidates the model is
skipped and the deterministic result stands. An admissible candidate is never
dropped to make the set fit.

**There is one ranking implementation.** Fallback selects index 0 of the same
array the deterministic path selects from. The router was split into an
evaluation stage and a selection stage precisely so that no second ranking
could come into existence; `route()` is defined as evaluate-then-select-index-0
and its receipts are byte-identical to Phase 4.

## Consequences

- The permitted-execution set is a property of the deterministic pipeline
  alone. A test can therefore enumerate every adversarial model behaviour and
  assert that each one produces either a member of the unmodified admissible
  set or a refusal.
- Jev's absence, failure or hostility costs at most selection quality.
- The integration cannot be "upgraded" into an authorization path without
  deleting the local lookup, which is a visible structural change rather than a
  drifting one.
- The model receives less information than it could use. That is accepted:
  data minimization on an external, non-deterministic dependency is worth more
  than a marginally better-informed advisory choice.
- Above 254 candidates the system silently loses the advisory layer. That is
  the correct trade — the alternative is letting a vendor limit decide which
  executions Mandate will consider.
