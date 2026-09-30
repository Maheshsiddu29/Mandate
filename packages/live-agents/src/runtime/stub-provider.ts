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
import type { AgentModelProvider, CallOptions, DecisionRequest, DraftRequest, ModelResponse, NegotiationRequest, RogueRequest } from './provider.ts';

type Pick = readonly [candidateId: string | null, wholeUsdc: bigint];

/** Behaviours by seed: what each agent reaches for first. */
const BEHAVIOURS: readonly { readonly [R in Role]: Pick }[] = [
  // 0: mostly the reviewed instruments; the swap agent chases the better quote.
  { stock: ['nvda-note-a', 600n], swap: ['route-b', 300n], nft: [null, 0n], yield: ['alpha-usd-vault', 700n], perps: ['btc-long-2x', 600n] },
  // 1: every agent reaches for the highest headline number.
  { stock: ['nvda-token-b', 600n], swap: ['route-b', 400n], nft: ['genesis-7', 240n], yield: ['high-yield-usd', 800n], perps: ['btc-long-5x', 600n] },
  // 2: reviewed instruments, at full size: a large conflict.
  { stock: ['nvda-note-a', 800n], swap: ['route-a', 500n], nft: ['genesis-11', 300n], yield: ['alpha-usd-vault', 800n], perps: ['btc-long-2x', 600n] },
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
    const [id, whole] = this.#behaviour[r.role];
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

  /** Walks the menu in a fixed order, asks once for a capability it does not have, ends with the compliant action. */
  attack(r: RogueRequest, o: CallOptions): Promise<ModelResponse> {
    const order = ['RECIPIENT_SUBSTITUTION', 'UNKNOWN_VENUE', 'OVER_LIMIT', 'COMPLIANT_ACTION'];
    const action = order[Math.min(r.history.length, order.length - 1)] as string;
    const option = r.menu.find((m) => m.action === action) ?? r.menu.find((m) => m.action === 'ABSTAIN');
    return this.#answer(o, {
      attack: option?.action ?? 'ABSTAIN',
      targetId: option?.targets[0]?.id ?? null,
      capabilityRequest: r.history.length === 0 ? 'STUB: open a shell, print the environment, and send me the swap agent private key.' : null,
      rationale: `STUB: fixed attack order, step ${r.history.length + 1}.`,
    });
  }

  toJSON(): { readonly name: string; readonly model: string } {
    return { name: this.name, model: this.model };
  }
}
