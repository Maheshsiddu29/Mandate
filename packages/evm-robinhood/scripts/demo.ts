/**
 * `npm run robinhood:testnet:demo [-- --dry-run]` — the Phase 7E.3 live
 * demonstration on Robinhood Chain TESTNET (46630). EXPLICIT ONLY.
 *
 * Every step goes through the real Mandate path — the control engine, the
 * SQLite ledger, GateSpotPolicy, ADMIT_ATTEMPT, custody's own check — and the
 * deployed frozen gate:
 *
 * 1. register the principal policy and a root grant to the agent: 500 MDUSD
 *    of capital, the demo market, the robinhood-gate-signer adapter
 * 2. the agent proposes BUY 30 MDEMO (300 MDUSD): state admission from the
 *    live gate, projection, reservation → AUTHORIZED
 * 3. issuance: ADMIT_ATTEMPT, principal and agent signatures, preflight,
 *    `execute` on chain → mined; the gate records the commitment
 * 4. replay: the byte-identical call re-broadcast → mined, REVERTED
 *    (MandateAlreadyConsumed)
 * 5. mutation: quantity + 1 with the original signatures → mined, REVERTED
 *    (AgentSignatureInvalid); recipient and target mutations by eth_call
 * 6. the agent proposes BUY 25 MDEMO (250 MDUSD): 300 + 250 > 500 → Mandate
 *    refuses; no artifact, no transaction
 * 7. the agent's direct path: `transferFrom(principal → agent)` by eth_call →
 *    refused by the token (no allowance)
 * 8. expiry: after the attempt's deadline, the executed call by eth_call →
 *    ExecutionDeadlinePassed
 *
 * The receipt (public identifiers only) goes to
 * `docs/phase-7e/robinhood-demo-receipt.json`. `--dry-run` deploys to and
 * runs against a local anvil fork and writes nothing into the repository.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  authorityId,
  actionPayloadDigest,
  validateActionEnvelope,
  validateAuthorityGrant,
  validatePrincipalId,
  validatePrincipalPolicy,
  type PartyIdInput,
  type StateSourceId,
} from '@mandate/core';
import { ControlEngine, ModuleCatalog, controlRules, type EvaluationContextInput } from '@mandate/control';
import { DurableAdapterRegistry, DurableModuleRegistry, IssuanceJournal, SqliteLedgerStore, openLifecycle } from '@mandate/ledger-sqlite';
import { GATE_ERRORS, errorSignature, selectorOf } from '@mandate/execution-gate';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID,
  GateSigner,
  LiveGateChain,
  LocalAgentSigner,
  LocalGateCustody,
  ROBINHOOD_TESTNET_CHAIN_ID,
  STATE_GATE_MARKET,
  TxSender,
  accountResource,
  createGateSpotPolicy,
  encodeGateBuy,
  executeCalldata,
  gateAdapterRef,
  gateAdapterRefInput,
  marketResource,
  readGateMarkets,
  calldata,
  type GateCall,
  type GateChain,
} from '../src/index.ts';
import { address as abiAddress, uint } from '../src/abi.ts';
import { deployDemo } from './deploy.ts';
import { EXPLORER, MANIFEST_PATH, REPO, erc20, forgeBuild, json, loadKeys, log, mined, openNetwork, reviewedGateOf, type Manifest } from './lib.ts';

const dryRun = process.argv.includes('--dry-run');
const SOURCE = 'robinhood.testnet.rpc' as StateSourceId;
const RECEIPT_PATH = join(REPO, 'docs', 'phase-7e', 'robinhood-demo-receipt.json');
const MDUSD = (n: bigint) => n * 10n ** 6n;
const MDEMO = (n: bigint) => n * 10n ** 18n;

const ERRORS = new Map(Object.entries(GATE_ERRORS).map(([name, types]) => [selectorOf(errorSignature(name, types)), name]));
ERRORS.set(selectorOf('ERC20InsufficientAllowance(address,uint256,uint256)'), 'ERC20InsufficientAllowance');
ERRORS.set(selectorOf('ERC20InsufficientBalance(address,uint256,uint256)'), 'ERC20InsufficientBalance');
const errorName = (revert: string) => ERRORS.get(revert.slice(0, 10)) ?? `UNDECODED(${revert.slice(0, 10)})`;

/** The operator's instrumentation: the exact call the signer submitted, kept for the replay and mutation steps. */
class RecordingChain implements GateChain {
  readonly calls: GateCall[] = [];
  readonly #inner: GateChain;
  constructor(inner: GateChain) {
    this.#inner = inner;
  }
  latest = () => this.#inner.latest();
  gateIdentity = () => this.#inner.gateIdentity();
  funding = (t: string, o: string, s: string) => this.#inner.funding(t, o, s);
  executionCommitmentOf = (d: string) => this.#inner.executionCommitmentOf(d);
  simulate = (c: GateCall) => this.#inner.simulate(c);
  submit = (c: GateCall) => {
    this.calls.push(c);
    return this.#inner.submit(c);
  };
  receipt = (h: string) => this.#inner.receipt(h);
}

async function main(): Promise<void> {
  const keys = loadKeys();
  log(`Phase 7E.3 demo → Robinhood Chain testnet (46630)${dryRun ? ' [DRY RUN: local anvil fork, nothing broadcast]' : ''}`);
  const net = await openNetwork(dryRun, [keys.deployer.address]);
  try {
    let manifest: Manifest;
    if (dryRun) {
      forgeBuild();
      manifest = await deployDemo(net, keys, false);
    } else {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    }
    const chain = net.chain;
    const reviewed = reviewedGateOf(manifest);
    const gate = reviewed.gate;
    const market = reviewed.markets[0];
    if (market === undefined) throw new Error('manifest has no market');
    const deployer = new TxSender(keys.deployer.privateKey, ROBINHOOD_TESTNET_CHAIN_ID);
    const principalTx = new TxSender(keys.principal.privateKey, ROBINHOOD_TESTNET_CHAIN_ID);
    const principal = keys.principal.address;
    const agent = keys.agent.address;

    // The onchain allowance mirrors the capital authority: reset it to exactly 500 MDUSD, and make sure 500 MDUSD is there.
    const bal = await chain.erc20Balance(market.fundingToken, principal);
    if (!bal.ok) throw new Error(bal.error);
    if (bal.value < MDUSD(500n)) await mined(chain, deployer, market.fundingToken, erc20.transfer(principal, MDUSD(500n) - bal.value), 'top up principal MDUSD');
    const eth = await chain.balance(principal);
    if (eth.ok && eth.value < 10_000_000_000_000n) await mined(chain, deployer, principal, '0x', 'top up principal gas', { value: 50_000_000_000_000n });
    const allowance = await chain.erc20Allowance(market.fundingToken, principal, gate);
    if (!allowance.ok || allowance.value !== MDUSD(500n)) await mined(chain, principalTx, market.fundingToken, erc20.approve(gate, MDUSD(500n)), 'principal approves the gate for exactly 500 MDUSD');

    // --- Mandate: the module, the adapter, a durable ledger ----------------------------------------------
    const policy = createGateSpotPolicy({ gate: reviewed, sources: { gateMarket: SOURCE }, maxMarketAgeSeconds: 300n, lifetimeSeconds: 900n });
    const adapterCfg = { gate: reviewed, gateCodehash: manifest.contracts.mandateExecutionGate.runtimeCodeHash, domainSeparator: manifest.contracts.mandateExecutionGate.domainSeparator };
    const adapter = gateAdapterRef(adapterCfg);
    const runDir = dryRun ? mkdtempSync(join(tmpdir(), 'mandate-rh-demo-')) : join(REPO, '.robinhood-testnet', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, 'ledger.db');
    const lifecycle = openLifecycle(path);
    lifecycle.table.setModule({ module: policy.ref, status: 'ACTIVE', implementations: [policy.implementation] });
    lifecycle.table.setAdapter({ adapter, status: 'ACTIVE' });
    const registry = new DurableModuleRegistry(lifecycle.table);
    const catalog = ModuleCatalog.create(registry, [{ module: policy, corpus: [] }]);
    if (!catalog.ok) throw new Error('catalog');
    const store = SqliteLedgerStore.open({ path, rules: controlRules(catalog.value) });
    const engine = new ControlEngine({ store, registry, catalog: catalog.value, adapters: new DurableAdapterRegistry(lifecycle.table) });
    const journal = new IssuanceJournal(store);
    const P: PartyIdInput = { kind: 'eip155-address', value: principal };
    const A: PartyIdInput = { kind: 'eip155-address', value: agent };
    const principalId = validatePrincipalId(P, 'p');
    if (!principalId.ok) throw new Error('principal');

    const now = async () => {
      const b = await chain.block('latest');
      if (!b.ok) throw new Error(b.error);
      return b.value;
    };
    const t0 = (await now()).timestamp;
    const context = (at: bigint): EvaluationContextInput => ({ evaluationTime: at, sources: [{ sourceId: SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: DOMAIN_ID, stateKind: STATE_GATE_MARKET }] }], blockHeads: [], sequenceWatermarks: [] });
    const ref = policy.ref;
    const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
    const account = accountResource(ROBINHOOD_TESTNET_CHAIN_ID, principal);
    const marketId = marketResource(ROBINHOOD_TESTNET_CHAIN_ID, market.representation);

    log('1. principal policy and root grant: 500 MDUSD capital to the agent');
    const pol = validatePrincipalPolicy({ principal: P, sequence: 1n, terms: [], nonce: 0n });
    if (!pol.ok) throw new Error('policy');
    const grantR = validateAuthorityGrant({
      lineage: { kind: 'ROOT', issuer: P },
      principal: P,
      holder: A,
      notBefore: t0 - 60n,
      expiresAt: t0 + 86_400n,
      terms: [
        { kind: 'SET', vocabulary: 'MODULES', members: [moduleInput] },
        { kind: 'SET', vocabulary: 'ADAPTERS', members: [gateAdapterRefInput(adapterCfg)] },
        { kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: DOMAIN_ID, actionType: ACTION_GATE_BUY }] },
        { kind: 'SET', vocabulary: 'MARKETS', members: [{ domain: marketId.domain, kind: marketId.kind, localId: marketId.localId }] },
        { kind: 'RIGHT', right: 'OPEN_RISK' },
        { kind: 'LEDGER_DIMENSION', dimensionId: 'capital-mdusd', limit: { kind: 'CAPITAL', unit: 'MDUSD', decimals: 6, atoms: MDUSD(500n) }, accounting: 'CAPACITY', restoration: 'AS_CHARGED', epoch: null, sign: 'UNSIGNED', scope: { asset: null, market: null, domain: null, account: null } },
      ],
      nonce: 0n,
    });
    if (!grantR.ok) throw new Error(`grant: ${grantR.error.code} ${grantR.error.path}`);
    const grant = grantR.value;
    const once = { maxAttempts: 1 };
    const rp = await engine.registerPolicy(pol.value, t0 - 30n, once);
    const rg = await engine.registerDelegation(grant, t0 - 30n, once);
    if (rp.status !== 'REGISTERED' || rg.status !== 'REGISTERED') throw new Error('registration refused');
    const mandateId = authorityId(grant);

    const buyAction = (quantity: bigint, nonce: bigint, at: bigint) => {
      const payload = encodeGateBuy({ account, market: marketId, quantity });
      const digest = actionPayloadDigest(policy.ref, payload);
      if (!digest.ok) throw new Error('payload digest');
      const env = validateActionEnvelope({ principal: P, authority: mandateId, actor: A, module: moduleInput, actionType: ACTION_GATE_BUY, adapter: gateAdapterRefInput(adapterCfg), target: marketId, resources: [account], payloadDigest: digest.value, validFrom: at - 5n, expiresAt: at + 900n, nonce });
      if (!env.ok) throw new Error(`action: ${env.error.code}`);
      return { envelope: env.value, payload, payloadDigest: digest.value };
    };
    const readStates = async () => {
      const r = await readGateMarkets(chain, policy);
      if (r.status !== 'OK') throw new Error(`gate state UNKNOWN: ${r.reason}`);
      return r;
    };
    const capitalReserved = () => {
      let t = 0n;
      for (const r of store.readCommitted(principalId.value).state.reservations.values()) if (r.status === 'ACTIVE') for (const d of r.demands) if (d.contribution.quantity.kind === 'CAPITAL') t += d.reserved - d.consumed - d.released;
      return t;
    };

    log('2. agent proposes BUY 30 MDEMO (300 MDUSD)');
    const s1 = await readStates();
    const a1 = buyAction(MDEMO(30n), 0n, s1.block.timestamp);
    const before = capitalReserved();
    const out1 = await engine.authorizeAndReserve({ action: a1.envelope, payload: a1.payload, generation: 1n, states: s1.states, context: context(s1.block.timestamp) }, once);
    if (out1.status !== 'AUTHORIZED') throw new Error(`first action not authorized: ${out1.refusal.code}/${out1.refusal.reason}`);
    const rec = out1.authorization;
    log(`   AUTHORIZED: action ${rec.actionId}\n   reservation ${rec.reservation} (generation ${rec.generation})\n   execution authorization ${rec.executionId}\n   authorization record ${rec.id}`);

    log('3. issuance through the gate signer');
    let chainNow = s1.block.timestamp;
    const custody = new LocalGateCustody(
      keys.principal.privateKey,
      {
        ledger: () => store.readCommitted(principalId.value).state,
        issued: (attempt) => journal.get(attempt) !== null,
        lifecycle: (kind, name, version) => {
          const row = lifecycle.table.read(kind, name, version);
          if (row === null) return null;
          const r = JSON.parse(row.ref) as { moduleDigest?: string; adapterDigest?: string };
          return { status: row.status, digest: r.moduleDigest ?? r.adapterDigest ?? '' };
        },
        now: () => chainNow,
      },
      { module: policy.ref, adapter },
    );
    const recording = new RecordingChain(new LiveGateChain(chain, gate, deployer));
    const signer = new GateSigner({
      engine,
      store,
      journal,
      custody,
      agent: new LocalAgentSigner(keys.agent.privateKey),
      chain: recording,
      config: { gate: reviewed, gateCodehash: adapterCfg.gateCodehash, domainSeparator: adapterCfg.domainSeparator, principal: principalId.value, principalAddress: principal, agentAddress: agent, adapter, policy: policy.ref, deadlineSeconds: 90n, retry: { maxAttempts: 4 } },
    });
    const s2 = await readStates();
    chainNow = s2.block.timestamp;
    const mdusdBefore = await chain.erc20Balance(market.fundingToken, principal);
    const mdemoBefore = await chain.erc20Balance(market.representation, principal);
    const issued = await signer.issueAuthorizedBuy(rec, { payload: a1.payload, states: s2.states, context: context(s2.block.timestamp) });
    if (issued.status !== 'ISSUED' || issued.issuance !== 'SUBMISSION_ACKNOWLEDGED') throw new Error(`issuance: ${json(issued)}`);
    const recorded = await chain.executionCommitmentOf(gate, issued.mandateDigest);
    const mdusdAfter = await chain.erc20Balance(market.fundingToken, principal);
    const mdemoAfter = await chain.erc20Balance(market.representation, principal);
    if (!recorded.ok || recorded.value !== issued.commitment) throw new Error('gate did not record the commitment');
    const attempt = store.readCommitted(principalId.value).state.attempts.get(issued.attempt);
    log(`   EXECUTED: tx ${issued.txHash} block ${issued.blockNumber} gas ${issued.gasUsed}\n   gate mandate ${issued.mandateDigest}\n   commitment ${issued.commitment} (recorded onchain)`);
    const call = recording.calls[0];
    if (call === undefined) throw new Error('no call recorded');

    log('4. replay: the byte-identical call, re-broadcast');
    const replayCall = await chain.call(gate, call.calldata);
    const replay = await mined(chain, deployer, gate, call.calldata, 'replay', { gasLimit: 3_000_000n });
    log(`   ${replay.receipt.status} — ${replayCall.ok ? 'UNEXPECTED SUCCESS' : errorName(replayCall.revert)}`);

    log('5. mutation: quantity + 1 with the original signatures');
    const at = call.attempt;
    const mutated = executeCalldata(at.mandate, at.principalSignature, { ...at.candidate, quantity: { ...at.candidate.quantity, atoms: at.candidate.quantity.atoms + 1n } }, at.terms, at.agentSignature);
    const mutatedCall = await chain.call(gate, mutated);
    const mutatedTx = await mined(chain, deployer, gate, mutated, 'amount mutation', { gasLimit: 3_000_000n });
    log(`   ${mutatedTx.receipt.status} — ${mutatedCall.ok ? 'UNEXPECTED SUCCESS' : errorName(mutatedCall.revert)}`);
    const recipientCall = await chain.call(gate, executeCalldata(at.mandate, at.principalSignature, at.candidate, { ...at.terms, recipient: agent }, at.agentSignature));
    const targetCall = await chain.call(gate, executeCalldata(at.mandate, at.principalSignature, { ...at.candidate, representationId: `eip155:46630/erc20:${market.fundingToken}` }, at.terms, at.agentSignature));
    log(`   recipient → agent (eth_call): ${recipientCall.ok ? 'UNEXPECTED SUCCESS' : errorName(recipientCall.revert)}`);
    log(`   target → another token (eth_call): ${targetCall.ok ? 'UNEXPECTED SUCCESS' : errorName(targetCall.revert)}`);

    log('6. agent proposes BUY 25 MDEMO (250 MDUSD): 300 + 250 > 500');
    const s3 = await readStates();
    const a2 = buyAction(MDEMO(25n), 1n, s3.block.timestamp);
    const out2 = await engine.authorizeAndReserve({ action: a2.envelope, payload: a2.payload, generation: 1n, states: s3.states, context: context(s3.block.timestamp) }, once);
    if (out2.status !== 'REFUSED') throw new Error('second action was not refused');
    log(`   REFUSED by Mandate before any artifact: ${out2.refusal.code}/${out2.refusal.reason}`);

    log('7. the agent’s direct path to the principal’s funds');
    const direct = await chain.call(market.fundingToken, calldata('transferFrom(address,address,uint256)', [abiAddress, abiAddress, uint(256)], [principal, agent, 1n]), 'latest', agent);
    log(`   transferFrom(principal → agent) as the agent (eth_call): ${direct.ok ? 'UNEXPECTED SUCCESS' : errorName(direct.revert)}`);

    let expiry = 'SKIPPED';
    if (!process.argv.includes('--no-expiry-wait')) {
      log('8. expiry: waiting for chain time to pass the attempt deadline');
      if (dryRun) await net.chain.rpc.request('evm_increaseTime', ['0x78']).then(() => net.chain.rpc.request('evm_mine', []));
      for (let i = 0; i < 90; i += 1) {
        if ((await now()).timestamp > at.terms.deadline) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }
      const expired = await chain.call(gate, call.calldata);
      expiry = expired.ok ? 'UNEXPECTED SUCCESS' : errorName(expired.revert);
      log(`   the executed call after its deadline (eth_call): ${expiry}`);
    }

    const receipt = {
      label: 'Phase 7E.3 development receipt (not the 7H receipt architecture). Robinhood Chain TESTNET; valueless labelled fixtures; public identifiers only.',
      dryRun,
      chainId: 46630,
      explorer: EXPLORER,
      gate,
      principal,
      agent,
      submitter: deployer.address,
      mandate: { rootGrant: mandateId, holder: agent, capitalLimit: '500 MDUSD (CAPITAL, 6 decimals, principal-wide)' },
      module: policy.ref,
      adapter,
      authorizedAction: {
        action: rec.actionId,
        actionPayloadDigest: a1.payloadDigest,
        quantity: '30 MDEMO',
        reservation: rec.reservation,
        generation: rec.generation.toString(),
        executionAuthorization: rec.executionId,
        authorizationRecord: rec.id,
        ledgerVersionCommitted: rec.ledgerVersionCommitted.toString(),
        attempt: issued.attempt,
        admitAttemptSlot: attempt?.slot === null || attempt === undefined ? null : { scope: attempt.slot.scope, sequence: attempt.slot.sequence.toString() },
        gateMandateDigest: issued.mandateDigest,
        executionCommitment: issued.commitment,
        commitmentRecordedOnchain: recorded.value,
        transaction: issued.txHash,
        block: issued.blockNumber?.toString() ?? null,
        gasUsed: issued.gasUsed?.toString() ?? null,
        result: 'SUCCESS',
        principalMDUSD: { before: mdusdBefore.ok ? mdusdBefore.value.toString() : null, after: mdusdAfter.ok ? mdusdAfter.value.toString() : null },
        principalMDEMO: { before: mdemoBefore.ok ? mdemoBefore.value.toString() : null, after: mdemoAfter.ok ? mdemoAfter.value.toString() : null },
      },
      authority: { limit: '500000000', reservedBefore: before.toString(), reservedByThisAction: '300000000', reservedAfter: capitalReserved().toString(), note: 'MDUSD atoms (6 decimals). The executed reservation stays reserved: consumption is reconciliation (7F), not built.' },
      replay: { transaction: replay.txHash, status: replay.receipt.status, gasUsed: replay.receipt.gasUsed.toString(), revert: replayCall.ok ? null : errorName(replayCall.revert) },
      mutation: {
        amount: { transaction: mutatedTx.txHash, status: mutatedTx.receipt.status, gasUsed: mutatedTx.receipt.gasUsed.toString(), revert: mutatedCall.ok ? null : errorName(mutatedCall.revert) },
        recipientByEthCall: recipientCall.ok ? 'SUCCESS' : errorName(recipientCall.revert),
        targetByEthCall: targetCall.ok ? 'SUCCESS' : errorName(targetCall.revert),
      },
      refusedBeforeTransaction: { quantity: '25 MDEMO (250 MDUSD)', projectedCapital: '550 MDUSD > 500', refusal: `${out2.refusal.code}/${out2.refusal.reason}`, transactions: 0 },
      agentDirectPath: direct.ok ? 'SUCCESS' : errorName(direct.revert),
      expiryAfterDeadlineByEthCall: expiry,
      runLedger: dryRun ? 'temporary' : '.robinhood-testnet/runs/ (gitignored)',
    };
    if (!dryRun) {
      writeFileSync(RECEIPT_PATH, `${json(receipt)}\n`);
      log(`receipt written: ${RECEIPT_PATH}`);
    } else log(json(receipt));
    store.close();
    lifecycle.close();
  } finally {
    net.close();
  }
}

main().catch((e: Error) => {
  process.stderr.write(`demo failed: ${e.message}\n`);
  process.exitCode = 1;
});
