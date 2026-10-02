/**
 * The stub provider. **Deterministic local rules, not a model.**
 *
 * It lets the whole Live AI Lab run offline — CI, `npm run agents:stub`, the
 * UI without a key — through exactly the same path as a real model: its
 * answers are text, parsed by the same strict schemas, resolved by the same
 * trusted code, decided by the same Mandate. Everything it says is labelled
 * STUB. A seed selects one of a few fixed behaviours so offline runs can
 * show different outcomes; nothing here is random.
 */

import { interpretLocallyAsText } from '../authoring/prompt-to-draft.ts';
import type { Role } from '../types.ts';
import type { AgentModelProvider, CallOptions, DecisionRequest, DraftRequest, ModelResponse, NegotiationRequest, PolicyStressRequest } from './provider.ts';

/** Candidate ids in order of preference — the first one offered is chosen; none offered (or none listed) abstains — and a size. */
type Pick = readonly [preference: readonly string[], wholeUsdc: bigint];

/**
 * Behaviours by seed: what each agent reaches for. The stub is offered only
 * actionable candidates, like a model, so a preference that eligibility
 * excluded is simply not available to it.
 */
const BEHAVIOURS: readonly { readonly [R in Role]: Pick }[] = [
  // 0: the swap agent chases the better quote when it is offered; the NFT agent sits out.
  { stock: [['nvda-note-a'], 600n], swap: [['route-b', 'route-a'], 300n], nft: [[], 0n], yield: [['alpha-usd-vault'], 700n], perps: [['btc-long-2x'], 600n] },
  // 1: every agent reaches for the highest headline number among what it is offered.
  { stock: [['nvda-token-b', 'nvda-note-a'], 600n], swap: [['route-b', 'route-a'], 400n], nft: [['genesis-7', 'genesis-11'], 240n], yield: [['high-yield-usd', 'alpha-usd-vault'], 800n], perps: [['btc-long-5x', 'btc-long-2x'], 600n] },
  // 2: reviewed instruments, at full size: a large conflict.
  { stock: [['nvda-note-a'], 800n], swap: [['route-a'], 500n], nft: [['genesis-11'], 300n], yield: [['alpha-usd-vault'], 800n], perps: [['btc-long-2x'], 600n] },
];

const USDC = 1_000_000n;
const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

export class StubProvider implements AgentModelProvider {
  readonly name = 'stub';
  readonly kind = 'STUB' as const;
  readonly model: string;
  readonly #behaviour: { readonly [R in Role]: Pick };

  constructor(seed = 0) {
    const i = ((seed % BEHAVIOURS.length) + BEHAVIOURS.length) % BEHAVIOURS.length;
    this.#behaviour = BEHAVIOURS[i] as { readonly [R in Role]: Pick };
    this.model = `stub-rules-v1/seed-${i}`;
  }

  #answer(o: CallOptions, value: unknown): Promise<ModelResponse> {
    o.onFirstChunk();
    return Promise.resolve({ text: JSON.stringify(value) });
  }

  decide(r: DecisionRequest, o: CallOptions): Promise<ModelResponse> {
    const [preference, whole] = this.#behaviour[r.role];
    const id = preference.find((p) => r.candidates.some((x) => x.id === p));
    const c = r.candidates.find((x) => x.id === id);
    if (c === undefined) return this.#answer(o, { action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'STUB: no candidate matches this behaviour.' });
    const atoms = clamp(whole * USDC, BigInt(c.minAtoms), BigInt(c.maxAtoms));
    return this.#answer(o, { action: 'PROPOSE', candidateId: c.id, requestedAtoms: atoms.toString(), rationale: `STUB: behaviour rule picks ${c.id}.` });
  }

  /** Offer a proportional share of the required reduction, or all of a constraint only this agent holds. */
  negotiate(r: NegotiationRequest, o: CallOptions): Promise<ModelResponse> {
    const current = BigInt(r.yourCurrentAtoms);
    const minimum = BigInt(r.yourMinimumAtoms);
    const demand = BigInt(r.admissibleDemandAtoms);
    let share = demand === 0n ? 0n : (BigInt(r.requiredReductionAtoms) * current + demand - 1n) / demand;
    for (const line of r.constraints) {
      if (line.resource !== 'portfolio-notional' && BigInt(line.requiredReductionAtoms) > 0n && BigInt(line.demandAtoms) <= current) share = share > BigInt(line.requiredReductionAtoms) ? share : BigInt(line.requiredReductionAtoms);
    }
    const target = ((current - share) / USDC) * USDC;
    if (share === 0n) return this.#answer(o, { action: 'KEEP', newRequestedAtoms: null, rationale: 'STUB: no reduction needed from this agent.' });
    if (r.permittedActions.includes('REDUCE') && target >= minimum && target > 0n && target < current) {
      return this.#answer(o, { action: 'REDUCE', newRequestedAtoms: target.toString(), rationale: 'STUB: proportional share of the required reduction.' });
    }
    return this.#answer(o, { action: target < minimum ? 'RELEASE' : 'KEEP', newRequestedAtoms: null, rationale: 'STUB: cannot reduce within its minimum.' });
  }

  interpretMandateDraft(r: DraftRequest, o: CallOptions): Promise<ModelResponse> {
    o.onFirstChunk();
    return Promise.resolve({ text: interpretLocallyAsText(r.prompt) });
  }

  /** Tests the supplied cases in a fixed order, ending with the compliant control; abstains once none of its order is offered. */
  selectPolicyCase(r: PolicyStressRequest, o: CallOptions): Promise<ModelResponse> {
    const order = ['UNAPPROVED_VENUE', 'RECIPIENT_MISMATCH', 'OVER_LIMIT', 'REPRESENTATION_MISMATCH', 'COMPLIANT_CONTROL'];
    const next = order.find((id) => r.cases.some((c) => c.caseId === id)) ?? 'ABSTAIN';
    return this.#answer(o, { caseId: next, rationale: `STUB: fixed test order, attempt ${r.attempt}.` });
  }

  toJSON(): { readonly name: string; readonly model: string } {
    return { name: this.name, model: this.model };
  }
}
