/**
 * The Lighter adapter's pre-execution rules (Phase 7E.1; signer-architecture.md §7).
 *
 * Pure rules over evidence the signer read, producing the adapter-evaluated
 * `PreExecutionResult`s the control engine requires before `ADMIT_ATTEMPT`:
 *
 * - `CREDENTIAL_SCOPE` — the dedicated sub-account has exactly one registered
 *   API key, at the signer's index, with custody's public key. Any other key
 *   (a front-end key, a second bot, a leaked copy re-registered) means
 *   something other than Mandate can sign for the account: refuse.
 * - `NONCE_SLOT` — one serialized lane per signer key. The next nonce is the
 *   venue's; it must be exactly one past the highest slot the ledger has ever
 *   admitted on this key (every earlier admitted transaction has consumed its
 *   slot), or the key must have no admitted slot yet. If the venue is behind,
 *   an admitted transaction has not consumed its slot — its outcome is not
 *   established, and a new one would race it: `LANE_BUSY`. If the venue is
 *   ahead, something else signed with this key: `NONCE_AHEAD_OF_LEDGER`.
 *   No retry or replacement semantics are assumed (testnet-evidence.md).
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, type Digest32 } from '@mandate/core';
import type { PreExecutionResult } from '@mandate/control';
import type { AttemptRecord, LedgerState } from '@mandate/ledger';
import type { RegisteredKey } from './venue.ts';

const ZERO_KEY = /^(?:0x)?0*$/;

function digestOf(label: string, write: (w: ByteWriter) => void): Digest32 {
  const w = new ByteWriter().str(label);
  write(w);
  return keccakDigest<Digest32>(w.finish());
}

export function credentialSubject(chainId: number, accountIndex: bigint): string {
  return `lighter:${chainId}:account:${accountIndex}`;
}

export function credentialScope(keys: readonly RegisteredKey[], o: { chainId: number; accountIndex: bigint; apiKeyIndex: number; publicKey: string }): PreExecutionResult {
  const live = keys.filter((k) => !ZERO_KEY.test(k.publicKey)).sort((a, b) => a.apiKeyIndex - b.apiKeyIndex);
  const evidence = digestOf('mandate/perp-lighter/credential-scope', (w) => {
    w.u16(live.length);
    for (const k of live) w.u16(k.apiKeyIndex).str(k.publicKey.toLowerCase().replace(/^0x/, ''));
  });
  const subject = credentialSubject(o.chainId, o.accountIndex);
  const fail = (reason: string): PreExecutionResult => ({ kind: 'CREDENTIAL_SCOPE', subject, outcome: 'FAIL', reason, evidence });
  if (live.length === 0) return fail('SIGNER_KEY_NOT_REGISTERED');
  if (live.length > 1) return fail('FOREIGN_KEY_REGISTERED');
  const only = live[0] as RegisteredKey;
  if (only.apiKeyIndex !== o.apiKeyIndex) return fail('SIGNER_KEY_AT_WRONG_INDEX');
  if (only.publicKey.toLowerCase().replace(/^0x/, '') !== o.publicKey.toLowerCase().replace(/^0x/, '')) return fail('REGISTERED_KEY_NOT_CUSTODY_KEY');
  return { kind: 'CREDENTIAL_SCOPE', subject, outcome: 'PASS', reason: 'EXACTLY_THE_SIGNER_KEY', evidence };
}

/** The highest nonce the ledger ever admitted on `scope`, or `null`. */
export function highestAdmittedSlot(state: LedgerState, scope: string): bigint | null {
  let high: bigint | null = null;
  for (const a of state.attempts.values() as AttemptRecord[]) {
    if (a.slot !== null && a.slot.scope === scope && (high === null || a.slot.sequence > high)) high = a.slot.sequence;
  }
  return high;
}

export function nonceSlot(venueNext: bigint, ledgerHighest: bigint | null, scope: string): { result: PreExecutionResult; nonce: bigint | null } {
  const evidence = digestOf('mandate/perp-lighter/nonce-slot', (w) => {
    w.str(scope).u64(venueNext).u8(ledgerHighest === null ? 0 : 1);
    if (ledgerHighest !== null) w.u64(ledgerHighest);
  });
  const result = (outcome: 'PASS' | 'FAIL', reason: string): PreExecutionResult => ({ kind: 'NONCE_SLOT', subject: scope, outcome, reason, evidence });
  if (ledgerHighest === null || venueNext === ledgerHighest + 1n) return { result: result('PASS', 'NEXT_SLOT'), nonce: venueNext };
  if (venueNext <= ledgerHighest) return { result: result('FAIL', 'LANE_BUSY'), nonce: null };
  return { result: result('FAIL', 'NONCE_AHEAD_OF_LEDGER'), nonce: null };
}
