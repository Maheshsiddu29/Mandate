/**
 * The valid world, assembled as a complete `VerifyRequest`.
 *
 * Every verifier test is this request with exactly one thing changed, so a test
 * names the difference rather than restating the world.
 */

import { mandateDigest, parseMandate, parseTrustedState, trustedStateDigest, type VerifyRequest } from '../../src/index.ts';
import { candidateInput, mandateInput, stateInput, NOW, MANDATE_ID, PLACEHOLDER_STATE_DIGEST } from './fixtures.ts';
import { TEST_DOMAIN, TEST_PRIVATE_KEY, envelopeFor } from './signing.ts';

type Json = Record<string, unknown>;

export interface WorldOverrides {
  readonly mandate?: Json;
  readonly candidate?: Json;
  readonly state?: Json;
  readonly representations?: Json[];
  readonly now?: bigint;
  readonly signWith?: string;
  /** Sign with `signWith` but keep declaring the principal as the signer, so recovery mismatches. */
  readonly forgeSigner?: boolean;
  readonly signDomain?: typeof TEST_DOMAIN;
  readonly expectedDomain?: unknown;
  /** Replace the whole authorization, for malformed-envelope cases. */
  readonly authorization?: unknown;
  /**
   * Leave the candidate's `evaluationStateDigest` as the placeholder instead of
   * binding it to the assembled state.
   *
   * Since schema v3 this changes the candidate digest and nothing about the
   * verdict, which is the point: evaluation-state provenance is committed for
   * audit and is not a predicate about the world being verified (ADR 0017).
   */
  readonly unboundState?: boolean;
}

/**
 * Record, on the candidate, the digest of the state the world actually assembled.
 *
 * Provenance rather than a binding: schema v3 commits the evaluation-state digest
 * so the construction is auditable, and compares only the registry snapshot
 * digest for equality (ADR 0017). A test that overrode the digest keeps its
 * override.
 */
function bindState(candidate: Json, state: Json, unbound: boolean | undefined): Json {
  if (unbound === true) return candidate;
  if (candidate['evaluationStateDigest'] !== PLACEHOLDER_STATE_DIGEST) return candidate;
  const parsed = parseTrustedState(state);
  if (!parsed.ok) return candidate;
  return { ...candidate, evaluationStateDigest: trustedStateDigest(parsed.value) };
}

/**
 * The mandate's principal is the address of the signing key, so the valid world
 * actually verifies. Tests that need an unauthorized signer override the key.
 */
export const PRINCIPAL_ADDRESS = '0x' + '00'.repeat(20);

export function buildWorld(o: WorldOverrides = {}): VerifyRequest {
  const signWith = o.signWith ?? TEST_PRIVATE_KEY;
  const envelope = envelopeFor('0x' + '00'.repeat(32) as never, signWith, o.signDomain ?? TEST_DOMAIN);
  const principal = envelopeFor('0x' + '00'.repeat(32) as never, TEST_PRIVATE_KEY)['signer'];

  const mandateRaw = mandateInput({ principal: principal as Json, ...(o.mandate ?? {}) });
  const parsed = parseMandate(mandateRaw);
  if (!parsed.ok) {
    // A deliberately malformed mandate still needs a request to be built; the
    // digest is then meaningless and the signature will not match, which is the
    // correct outcome for such a case.
    const malformedState = stateInput(o.state ?? {}, o.representations);
    return {
      mandate: mandateRaw,
      authorization: o.authorization ?? envelope,
      candidate: bindState(candidateInput(o.candidate ?? {}), malformedState, o.unboundState),
      trustedState: malformedState,
      clock: { nowUnixSeconds: o.now ?? NOW },
      expectedDomain: o.expectedDomain ?? { ...TEST_DOMAIN },
    };
  }

  const digest = mandateDigest(parsed.value);
  const signed = envelopeFor(digest, signWith, o.signDomain ?? TEST_DOMAIN);
  // A forged envelope claims the principal signed it while the bytes were
  // produced by another key: the signature does not recover to the declared
  // signer, which is a different failure from signing honestly as the wrong party.
  if (o.forgeSigner === true) signed['signer'] = principal;

  const state = stateInput(o.state ?? {}, o.representations);
  // The replay record is about this mandate unless a test says otherwise.
  const replay = state['replay'] as Json | null;
  if (replay !== null && typeof replay === 'object') {
    const value = replay['value'] as Json;
    if (value['mandateDigest'] === '0x' + '00'.repeat(32)) value['mandateDigest'] = digest;
  }

  return {
    mandate: mandateRaw,
    authorization: o.authorization ?? signed,
    candidate: bindState(candidateInput(o.candidate ?? {}), state, o.unboundState),
    trustedState: state,
    clock: { nowUnixSeconds: o.now ?? NOW },
    expectedDomain: o.expectedDomain ?? { ...TEST_DOMAIN },
  };
}

export { MANDATE_ID };
