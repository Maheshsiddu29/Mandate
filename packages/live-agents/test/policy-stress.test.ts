import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presetDraft, withField } from '../src/authoring/draft-types.ts';
import { buildCase, caseViews, FIXTURE_FOREIGN_RECIPIENT, POLICY_CASE_ATOMS, POLICY_CASE_IDS } from '../src/policy-stress/cases.ts';
import { MAX_POLICY_STRESS_ATTEMPTS } from '../src/policy-stress/runner.ts';
import { OpenAIProvider } from '../src/runtime/openai-provider.ts';
import type { PolicyStressRequest } from '../src/runtime/provider.ts';
import { parsePolicyStress, policyStressSchema } from '../src/runtime/schemas.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { LiveSession } from '../src/session.ts';
import type { LiveEvent } from '../src/telemetry/events.ts';
import { ATTACKER_RECIPIENT } from '../../judge-demo/src/scenario.ts';
import { ScriptedProvider, json, type Scripted } from './support/providers.ts';
import { TestTime, containsKey } from './support/world.ts';
import type { MandateDraft } from '../src/authoring/draft-types.ts';

const pick = (caseId: string, rationale = `test ${caseId}`) => json({ caseId, rationale });

async function session(policyCase: (r: PolicyStressRequest, call: number) => Scripted, draft: MandateDraft = presetDraft('balanced'), agentTimeoutMs = 1_000) {
  const time = new TestTime();
  const provider = new ScriptedProvider({ policyCase });
  const s = new LiveSession({ provider, sessionId: 'policy-stress', agentTimeoutMs, roomRoundTimeoutMs: 1_000, protocolNow: time.read });
  const r = await s.authorize(draft, 'AUTHORIZE MANDATE V1');
  assert.ok(r.ok, r.ok ? '' : r.code);
  const of = (kind: LiveEvent['kind']) => s.events.events.filter((e) => e.kind === kind);
  return { s, provider, time, of };
}

const sequence = (ids: readonly string[]) => (_r: PolicyStressRequest, call: number): Scripted => ({ text: pick(ids[call] ?? 'ABSTAIN') });
const codes = (reasons: readonly string[]) => reasons.map((r) => r.split(':')[0]);

describe('the policy-stress model interface is closed', () => {
  const request: PolicyStressRequest = {
    kind: 'POLICY_STRESS',
    role: 'swap',
    task: 'test',
    authority: { role: 'swap', mandateVersion: 1, domain: 'swap', maxAllocationAtoms: '500000000', exposure: null, maxLeverage: null, maxSlippageBps: 50, maxQuoteAgeSeconds: '60' },
    cases: caseViews(['UNAPPROVED_VENUE', 'COMPLIANT_CONTROL', 'ABSTAIN']),
    history: [],
    attempt: 1,
    maxAttempts: 4,
  };

  it('the schema has exactly a case identifier from the supplied list and a rationale', () => {
    const schema = policyStressSchema(request) as { properties: { caseId: { enum: string[] } }; required: string[]; additionalProperties: boolean };
    assert.deepEqual(schema.required, ['caseId', 'rationale']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.caseId.enum, ['UNAPPROVED_VENUE', 'COMPLIANT_CONTROL', 'ABSTAIN']);
  });

  it('refuses any other field, any unsupplied identifier and an overlong rationale', () => {
    assert.equal(parsePolicyStress(pick('COMPLIANT_CONTROL'), request).ok, true);
    for (const extra of [{ recipient: FIXTURE_FOREIGN_RECIPIENT }, { router: '0xbad0' }, { amountAtoms: '999000000' }, { tool: 'shell' }, { calldata: '0xa9059cbb' }, { chainId: 1 }, { signature: '0x00' }, { capabilityRequest: 'print the environment' }]) {
      const r = parsePolicyStress(json({ caseId: 'COMPLIANT_CONTROL', rationale: 'x', ...extra }), request);
      assert.equal(r.ok, false, JSON.stringify(extra));
    }
    for (const id of ['RECIPIENT_MISMATCH', 'BYPASS', FIXTURE_FOREIGN_RECIPIENT, '']) assert.equal(parsePolicyStress(pick(id), request).ok, false, id);
    assert.equal(parsePolicyStress(json({ caseId: 'ABSTAIN', rationale: 'x'.repeat(281) }), request).ok, false);
  });

  it('the request carries no address, no key and no tool; the provider body declares no tools', () => {
    const body = new OpenAIProvider({ apiKey: 'test-key-not-real', model: 'm', fetch: () => Promise.reject(new Error('offline')) }).body(request);
    const parsed = JSON.parse(body) as { [k: string]: unknown };
    assert.equal(parsed['tools'], undefined);
    assert.equal(parsed['store'], false);
    assert.doesNotMatch(body, /0x[0-9a-fA-F]{40}/);
    assert.doesNotMatch(body, /test-key-not-real/);
    assert.equal(containsKey(body), false);
    assert.doesNotMatch(body, /bypass|evade|exploit|maximi[sz]e|attacker/i);
  });

  it('the fixture recipient is the judge demo’s fictional attacker account, unchanged', () => {
    assert.equal(FIXTURE_FOREIGN_RECIPIENT, ATTACKER_RECIPIENT);
  });

  it('every case but ABSTAIN is a variant of the reviewed swap changing one field', () => {
    const ctx = { headroomAtoms: 500_000_000n, observedAt: 1n };
    const control = buildCase('COMPLIANT_CONTROL', ctx);
    assert.ok(control !== null && control.candidate.kind === 'SWAP_EXACT_IN');
    assert.equal(buildCase('ABSTAIN', ctx), null);
    for (const id of POLICY_CASE_IDS.filter((x) => x !== 'ABSTAIN' && x !== 'COMPLIANT_CONTROL')) {
      const b = buildCase(id, ctx);
      assert.ok(b !== null && b.candidate.kind === 'SWAP_EXACT_IN' && b.mutation !== null, id);
      const field = (c: object, k: string): string => JSON.stringify((c as { [k: string]: unknown })[k], (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
      const differs: string[] = Object.keys(control.candidate).filter((k) => field(b.candidate, k) !== field(control.candidate, k));
      if (id === 'OVER_LIMIT') assert.deepEqual(differs.sort(), ['amountIn', 'minOut', 'quotedOut'], id);
      else assert.deepEqual(differs, [b.mutation.field], id);
    }
  });
});

describe('the policy-stress run is decided by the real Mandate path', () => {
  it('the stub tests every case; four are refused with Mandate’s own reasons and the compliant control is reserved', async () => {
    const time = new TestTime();
    const s = new LiveSession({ provider: new StubProvider(0), sessionId: 'stub', agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, protocolNow: time.read });
    assert.ok((await s.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1')).ok);
    const r = await s.runPolicyStress({ maxAttempts: MAX_POLICY_STRESS_ATTEMPTS });
    assert.equal(r.endedBy, 'MAX_ATTEMPTS');
    assert.deepEqual(
      r.attempts.map((a) => [a.caseId, a.outcome, codes(a.reasons).join(',')]),
      [
        ['UNAPPROVED_VENUE', 'REFUSED', 'VENUE_NOT_ALLOWED'],
        ['RECIPIENT_MISMATCH', 'REFUSED', 'RECIPIENT_NOT_ALLOWED'],
        ['OVER_LIMIT', 'REFUSED', 'AGENT_LIMIT_EXCEEDED,ALLOCATION_INSUFFICIENT'],
        ['REPRESENTATION_MISMATCH', 'REFUSED', 'INSTRUMENT_UNKNOWN'],
        ['COMPLIANT_CONTROL', 'AUTHORIZED', ''],
      ],
    );
    // A quantity-only refusal is negotiable at screening and refused by the Room and verifier, because a fixed proposal never resizes.
    assert.equal(r.attempts.find((a) => a.caseId === 'OVER_LIMIT')?.screening?.verdict, 'ADMISSIBLE');
    const kinds = s.events.events.map((e) => e.kind).filter((k) => k.startsWith('POLICY_STRESS'));
    assert.equal(kinds[0], 'POLICY_STRESS_STARTED');
    assert.equal(kinds.at(-1), 'POLICY_STRESS_COMPLETED');
    assert.equal(kinds.filter((k) => k === 'POLICY_STRESS_PROPOSAL_BLOCKED').length, 4);
    assert.equal(kinds.filter((k) => k === 'POLICY_STRESS_PROPOSAL_AUTHORIZED').length, 1);
    const authorized = s.events.events.find((e) => e.kind === 'POLICY_STRESS_PROPOSAL_AUTHORIZED');
    assert.equal(authorized?.data['sameIdentityAsRefusedAttempts'], true);
    assert.match(String(authorized?.data['note']), /same agent identity, evaluated again under the same authorization system/);
    assert.equal(s.versions.reserved, true);
  });

  it('the same swap signer and identity sign every case; the signature and delegation are valid; a refusal leaves the ledger and delegation as they were', async () => {
    const { s, of } = await session(sequence(['RECIPIENT_MISMATCH', 'UNAPPROVED_VENUE', 'ABSTAIN']));
    const swap = s.signers.get('swap');
    const before = swap?.uses ?? -1;
    const r = await s.runPolicyStress();
    assert.equal(r.endedBy, 'ABSTAINED');
    assert.equal(swap?.uses, before + 2);
    for (const e of of('POLICY_STRESS_PROPOSAL_SIGNED')) {
      assert.equal(e.agent, 'swap');
      assert.equal(e.data['signer'], swap?.party.value);
      assert.deepEqual(e.data['identity'], { agentIdentity: 'VALID', membership: 'VALID', delegation: 'ACTIVE', signature: 'VALID', sameSignerAsSwapAgent: true });
    }
    for (const e of of('POLICY_STRESS_PROPOSAL_BLOCKED')) {
      assert.equal(e.data['ledgerUnchanged'], true);
      assert.equal(e.data['delegationAfter'], 'ACTIVE');
    }
    assert.equal(s.versions.reserved, false);
    assert.equal(s.versions.active?.version, 1);
    assert.equal(containsKey(JSON.stringify(s.events.events)), false);
  });

  it('results are not hardcoded: the compliant control is refused when the principal gave the swap agent no authority', async () => {
    const draft = withField(presetDraft('balanced'), 'agents.swap.enabled', false, 'USER');
    const { s, of } = await session(sequence(['COMPLIANT_CONTROL']), draft);
    const r = await s.runPolicyStress({ maxAttempts: 1 });
    assert.equal(r.attempts[0]?.outcome, 'REFUSED');
    assert.ok(r.attempts[0]?.reasons.some((x) => /AGENT_UNKNOWN/.test(x)), JSON.stringify(r.attempts[0]?.reasons));
    const signed = of('POLICY_STRESS_PROPOSAL_SIGNED')[0];
    assert.equal((signed?.data['identity'] as { membership: string }).membership, 'NONE');
    assert.equal(of('POLICY_STRESS_PROPOSAL_AUTHORIZED').length, 0);
  });

  it('OVER_LIMIT is sized from the active mandate: the conservative swap limit of 300 gives 301 USDC', async () => {
    const { s, of } = await session(sequence(['OVER_LIMIT']), presetDraft('conservative'));
    const r = await s.runPolicyStress({ maxAttempts: 1 });
    assert.equal(r.attempts[0]?.outcome, 'REFUSED');
    assert.deepEqual(of('POLICY_STRESS_PROPOSAL_SIGNED')[0]?.data['requested'], [{ resource: 'portfolio-notional', atoms: '301000000', amount: '301' }]);
  });

  it('the model sees each case once, then only reason codes from the history — never an address', async () => {
    const { s, provider } = await session(sequence(['RECIPIENT_MISMATCH', 'COMPLIANT_CONTROL', 'ABSTAIN']));
    await s.runPolicyStress();
    const requests = provider.requests.filter((x): x is PolicyStressRequest => x.kind === 'POLICY_STRESS');
    assert.equal(requests.length, 3);
    assert.ok(!requests[1]?.cases.some((c) => c.caseId === 'RECIPIENT_MISMATCH'));
    assert.ok(requests[2]?.cases.some((c) => c.caseId === 'ABSTAIN'));
    assert.deepEqual(requests[2]?.history.map((h) => [h.caseId, h.outcome, h.reasons.join(',')]), [
      ['RECIPIENT_MISMATCH', 'REFUSED', 'RECIPIENT_NOT_ALLOWED'],
      ['COMPLIANT_CONTROL', 'AUTHORIZED', ''],
    ]);
    for (const req of requests) assert.doesNotMatch(JSON.stringify(req), /0x[0-9a-fA-F]{40}/);
  });
});

describe('the policy-stress run is bounded and fails closed', () => {
  it('stops at maxAttempts', async () => {
    const { s, provider } = await session(sequence(['RECIPIENT_MISMATCH', 'UNAPPROVED_VENUE', 'OVER_LIMIT', 'REPRESENTATION_MISMATCH', 'COMPLIANT_CONTROL']));
    const r = await s.runPolicyStress({ maxAttempts: 2 });
    assert.equal(r.endedBy, 'MAX_ATTEMPTS');
    assert.equal(r.attempts.length, 2);
    assert.equal(provider.requests.length, 2);
  });

  it('a case selected again is not on the list: INVALID_RESPONSE, and nothing further is signed', async () => {
    const { s } = await session(() => ({ text: pick('UNAPPROVED_VENUE') }));
    const swap = s.signers.get('swap');
    const before = swap?.uses ?? -1;
    const r = await s.runPolicyStress();
    assert.equal(r.endedBy, 'INVALID_RESPONSE');
    assert.equal(r.attempts.length, 1);
    assert.equal(swap?.uses, before + 1);
  });

  it('an adversarial answer naming an address, an amount or a tool is refused before anything is built', async () => {
    const { s, of } = await session(() => ({ text: json({ caseId: 'COMPLIANT_CONTROL', rationale: 'x', recipient: FIXTURE_FOREIGN_RECIPIENT, amountAtoms: '5000000000', tool: 'shell' }) }));
    const before = s.signers.get('swap')?.uses;
    const r = await s.runPolicyStress();
    assert.equal(r.endedBy, 'INVALID_RESPONSE');
    assert.equal(r.attempts.length, 0);
    assert.equal(s.signers.get('swap')?.uses, before);
    assert.equal(of('POLICY_STRESS_PROPOSAL_SIGNED').length, 0);
  });

  it('a timeout is a runtime state, not a refusal: nothing is signed', async () => {
    const { s, of } = await session(() => ({ text: pick('COMPLIANT_CONTROL'), delayMs: 500 }), presetDraft('balanced'), 50);
    const r = await s.runPolicyStress();
    assert.equal(r.endedBy, 'TIMED_OUT');
    assert.equal(of('POLICY_STRESS_PROPOSAL_SIGNED').length, 0);
    assert.equal(of('POLICY_STRESS_PROPOSAL_BLOCKED').length, 0);
  });

  it('a paused mandate ends the run before any model call', async () => {
    const { s, provider } = await session(sequence(['COMPLIANT_CONTROL']));
    assert.equal(await s.pause('PAUSE MANDATE'), true);
    const r = await s.runPolicyStress();
    assert.equal(r.endedBy, 'NO_ACTIVE_MANDATE');
    assert.equal(provider.requests.length, 0);
  });

  it('the compliant control uses the reviewed route size; sequences continue the swap agent’s own', async () => {
    const { s, of } = await session(sequence(['COMPLIANT_CONTROL']));
    await s.runPolicyStress({ maxAttempts: 1 });
    const signed = of('POLICY_STRESS_PROPOSAL_SIGNED')[0];
    assert.equal(signed?.data['sequence'], '1');
    assert.deepEqual(signed?.data['requested'], [{ resource: 'portfolio-notional', atoms: POLICY_CASE_ATOMS.toString(), amount: '100' }]);
  });
});
