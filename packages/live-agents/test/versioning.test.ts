import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioMandateDigest, screenProposal, validateAgentProposal, proposalSigningHash, proposalDigest } from '@mandate/portfolio';
import { DEMO_NOW, demoKey, demoParty, signPrehash, MARKETPLACE, GENESIS_COLLECTION, PRINCIPAL_ON_ARBITRUM } from '@mandate/portfolio/demo';
import { presetDraft, withField } from '../src/authoring/draft-types.ts';
import { validateDraft } from '../src/authoring/draft-validator.ts';
import { MandateVersions, PAUSE_CONFIRMATION } from '../src/authoring/mandate-versioning.ts';
import { sessionBindings } from '../src/mandate/portfolio-adapter.ts';
import { LocalPrincipalSigner } from '../src/mandate/signer.ts';
import { realClock } from '../src/runtime/clock.ts';

const bindings = sessionBindings();
const ctx = { version: 1, protocolNow: DEMO_NOW, bindings };
const versions = () => new MandateVersions({ bindings, signer: new LocalPrincipalSigner(), clock: realClock });
const codes = (d: ReturnType<typeof presetDraft>) => validateDraft(d, ctx).issues.filter((i) => i.severity === 'BLOCKING').map((i) => i.code);

describe('guardrail validation', () => {
  it('every preset validates and shows what will be enforced', () => {
    for (const p of ['conservative', 'balanced', 'aggressive'] as const) {
      const v = validateDraft(presetDraft(p), ctx);
      assert.equal(v.ok, true, `${p}: ${JSON.stringify(v.issues)}`);
      assert.ok(v.guardrails.some((g) => g.term === 'limits[portfolio-notional]'));
      assert.equal(v.mandate?.allocationMode, 'DYNAMIC');
    }
  });

  it('test 4: contradictory guardrails are rejected', () => {
    const d = withField(withField(presetDraft('balanced'), 'portfolio.minUnallocated', '500', 'USER'), 'portfolio.deployAll', true, 'USER');
    assert.ok(codes(d).includes('CONFLICT'));
    assert.ok(codes(withField(presetDraft('balanced'), 'portfolio.minUnallocated', '2500', 'USER')).includes('CONFLICT'));
    assert.ok(codes(withField(presetDraft('balanced'), 'market.maxLeverage', '5', 'USER')).includes('EXCEEDS_REVIEWED_BOUND'));
    assert.ok(codes(withField(presetDraft('balanced'), 'market.maxQuoteAgeSeconds', '900', 'USER')).includes('EXCEEDS_REVIEWED_BOUND'));
  });

  it('test 5: child authority cannot exceed parent — decided by the protocol’s own check', () => {
    const d = withField(presetDraft('balanced'), 'agents.perps.maxExposure', '600', 'USER');
    const v = validateDraft(d, ctx);
    const child = v.issues.find((i) => i.code === 'CHILD_AUTHORITY_EXCEEDS_PARENT');
    assert.ok(child);
    assert.equal(child.protocol?.code, 'CHILD_WIDENS_RESOURCE_LIMIT');
    assert.match(child.message, /Child authority exceeds parent authority/);
    assert.equal(v.ok, false);
    // An agent's allocation above what the portfolio may deploy is the same rule on another resource.
    const e = validateDraft(withField(presetDraft('conservative'), 'agents.stock.maxAllocation', '1600', 'USER'), ctx);
    assert.ok(e.issues.some((i) => i.code === 'CHILD_AUTHORITY_EXCEEDS_PARENT' && i.protocol?.subject.endsWith('/portfolio-notional')));
  });

  it('an unset field blocks: nothing is defaulted', () => {
    const d = withField(presetDraft('balanced'), 'market.maxQuoteAgeSeconds', null, 'USER');
    assert.ok(codes(d).includes('MISSING_VALUE'));
  });

  it('an unresolved interpretation issue blocks until the principal resolves it', () => {
    const d = { ...presetDraft('balanced'), issues: [{ kind: 'NEEDS_CLARIFICATION' as const, field: null, text: '"safe" is not a Mandate term.' }] };
    assert.ok(codes(d).includes('INTERPRETATION_UNRESOLVED'));
  });

  it('removing every approved asset an enabled agent needs is refused, not silently narrowed to nothing', () => {
    const d = withField(presetDraft('balanced'), 'market.assets', ['nvda', 'eth', 'mandate-genesis', 'alpha-usd-vault'], 'USER');
    assert.ok(validateDraft(d, ctx).issues.some((i) => i.code === 'AGENT_SCOPE_EMPTY' && i.field === 'agents.perps'));
  });

  it('market guardrails only tighten an agent’s reviewed bounds', () => {
    const v = validateDraft(withField(presetDraft('balanced'), 'market.maxQuoteAgeSeconds', '10', 'USER'), ctx);
    const swap = v.mandate?.agents.find((a) => a.label === 'swap');
    const yieldAgent = v.mandate?.agents.find((a) => a.label === 'yield');
    assert.equal(swap?.scope.maxQuoteAgeSeconds, 10n);
    assert.equal(yieldAgent?.scope.maxQuoteAgeSeconds, 10n);
    const loose = validateDraft(presetDraft('balanced'), ctx);
    // The swap agent's reviewed 60 s and 50 bps survive a looser portfolio choice.
    assert.equal(loose.mandate?.agents.find((a) => a.label === 'swap')?.scope.maxQuoteAgeSeconds, 60n);
    assert.equal(loose.mandate?.agents.find((a) => a.label === 'swap')?.scope.maxSlippageBps, 50);
  });
});

describe('authorization and versions', () => {
  it('test 3: explicit authorization creates V1 — and nothing else does', async () => {
    const v = versions();
    const draft = presetDraft('balanced');
    assert.equal(v.active, null);
    for (const words of ['', 'looks good', 'yes', 'AUTHORIZE MANDATE V2', 'authorize mandate v1']) {
      const r = await v.authorize(draft, words, DEMO_NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'CONFIRMATION_REQUIRED');
    }
    assert.equal(v.active, null);
    const r = await v.authorize(draft, 'AUTHORIZE MANDATE V1', DEMO_NOW);
    assert.ok(r.ok);
    assert.equal(r.record.version, 1);
    assert.equal(r.record.status, 'ACTIVE');
    assert.match(r.record.signatureLabel, /not a wallet signature/);
    assert.equal(v.records.at(-1)?.status, 'ACTIVE');
    assert.equal(v.expectedConfirmation, 'AUTHORIZE MANDATE V2');
  });

  it('an invalid draft is never signed, whatever the confirmation', async () => {
    const signer = new LocalPrincipalSigner();
    const v = new MandateVersions({ bindings, signer, clock: realClock });
    const r = await v.authorize(withField(presetDraft('balanced'), 'agents.perps.maxExposure', '600', 'USER'), 'AUTHORIZE MANDATE V1', DEMO_NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'DRAFT_INVALID');
    assert.equal(signer.uses, 0);
  });

  it('test 6: a disabled agent gets no authority — Mandate does not know it', async () => {
    const v = versions();
    const r = await v.authorize(withField(presetDraft('balanced'), 'agents.nft.enabled', false, 'USER'), 'AUTHORIZE MANDATE V1', DEMO_NOW);
    assert.ok(r.ok);
    const active = v.active;
    assert.ok(active);
    const nft = demoParty('nft');
    assert.equal(active.mandate.agents.some((a) => a.agent.value === nft.value), false);
    assert.equal(active.compiled.delegations.has(nft.value), false);
    assert.ok(r.record.guardrails.some((g) => g.status === 'NO_AUTHORITY' && g.guardrail === 'NFT Agent'));
    // Its own key still signs, and Mandate refuses the proposal: the agent is unknown to this mandate.
    const p = validateAgentProposal({
      portfolioMandate: portfolioMandateDigest(active.mandate),
      agent: nft,
      sequence: 1n,
      candidate: { kind: 'NFT_BUY', marketplace: MARKETPLACE, collection: GENESIS_COLLECTION, tokenId: 11n, maxPrice: 300_000_000n, recipient: PRINCIPAL_ON_ARBITRUM, claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      requested: [{ resource: 'portfolio-notional', atoms: 300_000_000n }],
      minimum: [],
      utilityBps: 0n,
      createdAt: DEMO_NOW,
      expiresAt: DEMO_NOW + 600n,
      criticalExtensions: [],
    });
    assert.ok(p.ok);
    const signed = { proposal: p.value, signature: signPrehash(proposalSigningHash(proposalDigest(p.value)), demoKey('nft')) };
    assert.deepEqual(screenProposal(active.mandate, bindings, signed, DEMO_NOW).reasons.map((x) => x.code), ['AGENT_UNKNOWN']);
  });

  it('test 7: an amendment creates V2; V1 is superseded, never mutated', async () => {
    const v = versions();
    const d1 = presetDraft('balanced');
    const r1 = await v.authorize(d1, 'AUTHORIZE MANDATE V1', DEMO_NOW);
    assert.ok(r1.ok);
    const v1 = v.active;
    assert.ok(v1);
    const v1Digest = portfolioMandateDigest(v1.mandate);
    const d2 = withField(withField(d1, 'portfolio.maxDerivative', '250', 'USER'), 'agents.perps.maxAllocation', '250', 'USER');
    const r2 = await v.authorize(d2, 'AUTHORIZE MANDATE V2', DEMO_NOW + 5n);
    assert.ok(r2.ok);
    assert.equal(r2.record.version, 2);
    assert.equal(r2.record.supersedes, 1);
    assert.deepEqual(r2.record.changes.map((c) => c.field).sort(), ['agents.perps.maxAllocation', 'portfolio.maxDerivative']);
    assert.equal(r2.superseded?.status, 'SUPERSEDED');
    assert.equal(r2.superseded?.supersededBy, 2);
    assert.ok(r2.superseded?.revokedAtLedgerVersion !== null);
    // V1 itself is untouched: same object, same digest, same signature.
    assert.equal(portfolioMandateDigest(v1.mandate), v1Digest);
    assert.equal(v.records[0]?.digest, v1Digest);
    assert.equal(v.records[0]?.signature, r1.record.signature);
    assert.notEqual(r2.record.digest, v1Digest);
    assert.equal(v.active?.version, 2);
    assert.equal(v.active?.mandate.policyVersion, 2n);
    // Both live in one ledger; V1's root is revoked there.
    const snapshot = await v.active.core.engine.read(v.active.mandate.principal);
    const revoked = snapshot.state.nodes.values().filter((n) => n.revokedAt !== null);
    assert.ok(revoked.length >= 1);
  });

  it('amendments stop at the first reservation; pause still works', async () => {
    const v = versions();
    assert.ok((await v.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1', DEMO_NOW)).ok);
    v.markReserved();
    const r = await v.authorize(presetDraft('conservative'), 'AUTHORIZE MANDATE V2', DEMO_NOW + 1n);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'AMENDMENT_AFTER_RESERVATION');
    assert.equal((await v.pause('pause', DEMO_NOW + 2n)).ok, false);
    const p = await v.pause(PAUSE_CONFIRMATION, DEMO_NOW + 2n);
    assert.ok(p.ok);
    assert.equal(p.record.status, 'REVOKED');
    assert.equal(v.active, null);
  });
});
