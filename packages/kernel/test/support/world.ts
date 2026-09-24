/**
 * The valid world, assembled as a complete `VerifyRequest`.
 *
 * Every verifier test is this request with exactly one thing changed, so a test
 * names the difference rather than restating the world.
 */

import { mandateDigest, parseMandate, type VerifyRequest } from '../../src/index.ts';
import { candidateInput, mandateInput, stateInput, NOW, MANDATE_ID } from './fixtures.ts';
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
    return {
      mandate: mandateRaw,
      authorization: o.authorization ?? envelope,
      candidate: candidateInput(o.candidate ?? {}),
      trustedState: stateInput(o.state ?? {}, o.representations),
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
    candidate: candidateInput(o.candidate ?? {}),
    trustedState: state,
    clock: { nowUnixSeconds: o.now ?? NOW },
    expectedDomain: o.expectedDomain ?? { ...TEST_DOMAIN },
  };
}

export { MANDATE_ID };
