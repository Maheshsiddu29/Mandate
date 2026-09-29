/**
 * Issuance and execution of FIXTURE children (portfolio-mandate.md §12, §15).
 *
 * **SIMULATED.** A fixture domain has no live venue, so "execution" here is a
 * labelled simulation — but the path in front of it is the real one: the
 * control engine's `ADMIT_ATTEMPT` (revalidation on fresh state, module and
 * adapter trust, the exact artifact identity) is committed *before* anything
 * is "signed", and `checkBeforeSign` must pass against the committed ledger.
 * Nothing here writes a consumption or a release: reconciliation is not
 * built, and an executed reservation stays ACTIVE exactly as in Phase 7E.3.
 *
 * Stock and perps children are not executed here. They are handed to their
 * domain's existing signer (`robinhood-gate-signer`, the Lighter venue
 * signer), which admits its own attempt for its own exact artifact.
 */

import { err, ok, ByteWriter, type Result } from '@mandate/kernel';
import { hexToBytes, keccakDigest, validateAdapterRef, validateResourceId, writeDigest, type Digest32 } from '@mandate/core';
import type { AttemptRecord, RetryPolicy } from '@mandate/ledger';
import type { AuthorizationRecord } from '@mandate/control';
import { bindingFor } from '../binding.ts';
import type { ActionCandidate } from '../candidate.ts';
import { childAuthorizationDigest, type ChildAuthorizationDigest, type ChildExecutionAuthorization } from '../child.ts';
import { compileAction } from '../compile.ts';
import { FIXTURE_ARTIFACT_KIND } from './fixture.ts';
import { reason, type Reason } from '../reasons.ts';
import { PORTFOLIO_GENERATION, checkBeforeSign, ledgerRefusal, type PortfolioCore } from '../reservation.ts';
import type { ResourceVector } from '../resources.ts';
import type { VerificationTranscript } from '../verifier.ts';

export interface FixtureExecution {
  readonly attempt: AttemptRecord;
  /** The artifact the attempt committed: `keccak(tag ‖ child ‖ reservation ‖ generation)`. */
  readonly artifact: Digest32;
  /** What the simulated venue settled: exactly the approved demand. */
  readonly settled: ResourceVector;
  readonly evidence: 'SIMULATED';
}

/** The fixture artifact's identity, bound to the child and to one reservation generation. */
export function fixtureArtifactId(child: ChildAuthorizationDigest, record: AuthorizationRecord): Digest32 {
  const w = new ByteWriter().str('mandate-portfolio/fixture-artifact').u16(1);
  writeDigest(w, child);
  writeDigest(w, record.reservation);
  w.u64(record.generation);
  return keccakDigest<Digest32>(w.finish());
}

/**
 * Admit the attempt, check the portfolio's precondition against the ledger
 * that now holds it, then simulate the fixture venue. `verified` is the set of
 * child digests the verifier derived for this run.
 */
export async function executeFixtureChild(
  core: PortfolioCore,
  transcript: VerificationTranscript,
  child: ChildExecutionAuthorization,
  candidate: ActionCandidate,
  record: AuthorizationRecord,
  at: bigint,
  retry: RetryPolicy = { maxAttempts: 4 },
): Promise<Result<FixtureExecution, readonly Reason[]>> {
  const b = bindingFor(core.compiled.bindings, candidate.kind);
  if ('refused' in b) return err([b.refused]);
  if (b.evidence !== 'FIXTURE') return err([reason('INSTRUMENT_UNKNOWN', `not-a-fixture:${b.domain}`)]);
  // Refused before any attempt is admitted; checkBeforeSign enforces the same independently.
  if (record.generation !== PORTFOLIO_GENERATION) return err([reason('RESERVATION_GENERATION_INVALID', `reservation:${record.generation}`)]);
  const adapter = validateAdapterRef(b.adapter);
  const account = validateResourceId({ domain: b.domain, kind: 'ACCOUNT', localId: child.scope.recipients[0] ?? 'none' }, ['ACCOUNT'] as const, 'venueAccount');
  if (!adapter.ok || !account.ok) return err([reason('INSTRUMENT_UNKNOWN', 'fixture-adapter')]);
  // The payload is recompiled from the child, never taken from the caller: revalidation checks it against the action.
  const compiled = compileAction(core.compiled, child, candidate);
  if (!compiled.ok) return err([compiled.error]);
  const digest = childAuthorizationDigest(child);
  const artifact = fixtureArtifactId(digest, record);
  const out = await core.engine.admitAttempt(
    record,
    {
      revalidation: { payload: compiled.value.payload, states: b.states(candidate, at), context: { evaluationTime: at, sources: [...b.sources()], blockHeads: [], sequenceWatermarks: [] } },
      adapter: adapter.value,
      venueAccount: account.value,
      artifact: { kind: FIXTURE_ARTIFACT_KIND as never, id: hexToBytes(artifact) },
      slot: null,
      validUntil: record.validUntil < at + 120n ? record.validUntil : at + 120n,
      requirements: [],
      results: [],
    },
    retry,
  );
  if (out.status === 'REFUSED' || out.status === 'CONFLICT') return err([ledgerRefusal(out.refusal)]);
  const snapshot = await core.engine.read(record.principal);
  const blocked = checkBeforeSign(core, transcript, {
    agent: child.agent,
    child,
    candidate,
    reservation: record.reservation,
    action: record.actionId,
    generation: record.generation,
    authorization: record.executionId,
    attempt: out.attempt.attempt,
    at,
  }, snapshot.state);
  if (blocked.length > 0) return err(blocked);
  return ok({ attempt: out.attempt, artifact, settled: child.approved, evidence: 'SIMULATED' });
}
