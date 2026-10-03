/**
 * A durable V2 Live AI session whose wallet signed the portfolio mandate,
 * already run to a reserved Stock child, and the wallet's gate signature.
 * Shared by the spine and held-restore tests. No network.
 */

import assert from 'node:assert/strict';
import { bytesToHex, eip712SigningHash, type Bytes32 } from '@mandate/kernel';
import { portfolioMandateAuthorizationV2Hash } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { LiveSession, sessionDigest } from '@mandate/live-agents';
import { APPROVAL_CHAIN_ID } from '../../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../../live-agents/src/authoring/draft-types.ts';
import { ManualClock } from '../../../live-agents/src/runtime/clock.ts';
import { ScriptedProvider, json } from '../../../live-agents/test/support/providers.ts';
import type { GateExecutionRequest } from '../../src/gate-authority.ts';

export const SPINE_TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;
/** A wallet that is not the manifest principal: it must present MandateAuthorization per execution. */
export const OTHER_KEY = `0x${'44'.repeat(32)}`;

const propose = (candidateId: string, whole: number) => json({ action: 'PROPOSE', candidateId, requestedAtoms: (BigInt(whole) * 1_000_000n).toString(), rationale: `pick ${candidateId}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'none' });
const provider = () => new ScriptedProvider({ decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 400) : abstain }), negotiate: () => ({ text: abstain }) });

export async function v2Session(dir: string, key: string, id: string): Promise<void> {
  const s = new LiveSession({ provider: provider(), clock: new ManualClock(), sessionId: id, stateDir: dir, ...SPINE_TIMEOUTS });
  const draft = presetDraft('balanced');
  const wallet = addressOfKey(key);
  const c = s.spineChallenge(draft, wallet);
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const mandate = s.challenges.get(c.challenge)?.prepared.mandate;
  assert.ok(mandate);
  assert.ok(c.initialAllocationDigest);
  const signature = signPrehash(portfolioMandateAuthorizationV2Hash(mandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id), initialAllocationDigest: c.initialAllocationDigest }), key);
  assert.equal((await s.authorizeWithWallet(draft, c.challenge, signature)).ok, true);
  assert.equal((await s.run()).status, 'AUTHORIZED');
  s.close();
}

export function signGate(req: GateExecutionRequest, key: string): string {
  const hash = eip712SigningHash({ name: 'Mandate', version: '1', chainId: BigInt(req.chainId), verifyingContract: req.gate }, req.mandateDigest as Bytes32);
  if (bytesToHex(hash) !== req.signingHash) throw new Error('signing hash is not the gate EIP-712 hash');
  return signPrehash(hash, key);
}
