/**
 * The domain leg: the existing Phase 7E.3 Robinhood path, for one fixture
 * settlement.
 *
 * The deployed gate moves the 7E.3 principal's MDUSD only for a mandate
 * that principal signs, and its custody signs only for a Core authorization
 * with a committed `ADMIT_ATTEMPT` in the Robinhood domain's own ledger. So
 * the fixture settlement is authorized there exactly as `npm run
 * robinhood:testnet:demo` authorizes a BUY — the same GateSpotPolicy v1
 * over the manifest's gate, the same `robinhood-gate-signer` adapter, the
 * SQLite reference store with its durable lifecycle table and issuance
 * journal — with authority scoped to this one settlement and nothing more:
 *
 * - the root grant's `CAPITAL` limit is exactly the fixture debit, so once
 *   it is reserved nothing else fits;
 * - its only market is MDEMO, its only adapter and module the reviewed ones;
 * - the action's nonce is the settlement binding digest's first eight bytes,
 *   so the gate mandate id — derived from this action's execution
 *   authorization — commits to the Live AI authorization it came from.
 *
 * The principal and agent keys are the 7E.3 disposable testnet keys. They
 * are handed to `LocalGateCustody` and `LocalAgentSigner` here and nowhere
 * else, and neither exposes them.
 */

import {
  actionPayloadDigest,
  authorityId,
  validateActionEnvelope,
  validateAuthorityGrant,
  validatePrincipalId,
  validatePrincipalPolicy,
  type PartyIdInput,
  type PrincipalId,
  type StateSourceId,
} from '@mandate/core';
import { ControlEngine, ModuleCatalog, controlRules, type AuthorizationRecord, type EvaluationContextInput, type SuppliedState } from '@mandate/control';
import { DurableAdapterRegistry, DurableModuleRegistry, IssuanceJournal, SqliteLedgerStore, openLifecycle } from '@mandate/ledger-sqlite';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID,
  GateSigner,
  LocalAgentSigner,
  LocalGateCustody,
  STATE_GATE_MARKET,
  accountResource,
  createGateSpotPolicy,
  encodeGateBuy,
  gateAdapterRef,
  gateAdapterRefInput,
  marketResource,
  type GateSpotPolicy,
} from '@mandate/evm-robinhood';
import type { AdapterRef } from '@mandate/core';
import type { TestnetDeployment } from './deployment.ts';
import type { Eligibility } from './eligibility.ts';
import { guardCustody, type GuardedCustody } from './custody-guard.ts';
import type { FixtureSettlement } from './fixture-mapping.ts';
import type { SettlementGateChain } from './settlement-chain.ts';

/** The 7E.3 source id for gate-market state read from the testnet RPC. */
export const GATE_STATE_SOURCE = 'robinhood.testnet.rpc' as StateSourceId;
/** How long the one-settlement grant and action live, in chain seconds. */
export const DOMAIN_AUTHORITY_SECONDS = 900n;
/** An attempt's chain-time deadline from issue (the 7E.3 demo's). */
export const ATTEMPT_DEADLINE_SECONDS = 90n;

/** The 7E.3 disposable testnet keys the gate's principal and agent need. Private: passed through, never kept here. */
export interface DomainKeys {
  readonly principal: string;
  readonly agent: string;
}

export interface DomainLeg {
  readonly policy: GateSpotPolicy;
  readonly adapter: AdapterRef;
  readonly engine: ControlEngine;
  readonly store: SqliteLedgerStore;
  readonly journal: IssuanceJournal;
  readonly principalId: PrincipalId;
  readonly record: AuthorizationRecord;
  readonly payload: Uint8Array;
  readonly custody: GuardedCustody;
  readonly signer: GateSigner;
  /** Fresh gate-market state and context for issue-time revalidation. */
  readonly issueContext: (states: readonly SuppliedState[], at: bigint) => { readonly payload: Uint8Array; readonly states: readonly SuppliedState[]; readonly context: EvaluationContextInput };
  close(): void;
}

export type DomainLegResult = { readonly ok: true; readonly leg: DomainLeg } | { readonly ok: false; readonly stage: string; readonly reason: string };

export function domainPolicy(d: TestnetDeployment): GateSpotPolicy {
  return createGateSpotPolicy({ gate: d.reviewed, sources: { gateMarket: GATE_STATE_SOURCE }, maxMarketAgeSeconds: 300n, lifetimeSeconds: DOMAIN_AUTHORITY_SECONDS });
}

function context(at: bigint): EvaluationContextInput {
  return { evaluationTime: at, sources: [{ sourceId: GATE_STATE_SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: DOMAIN_ID, stateKind: STATE_GATE_MARKET }] }], blockHeads: [], sequenceWatermarks: [] };
}

export interface DomainLegInput {
  readonly deployment: TestnetDeployment;
  readonly settlement: FixtureSettlement;
  readonly keys: DomainKeys;
  /** The SQLite file of this settlement's domain ledger. */
  readonly ledgerPath: string;
  /** Gate-market state read from the chain at `at` (chain time). */
  readonly states: readonly SuppliedState[];
  readonly at: bigint;
  readonly chain: SettlementGateChain;
  /** The Live AI side's eligibility, re-derived when custody is asked to sign. */
  readonly eligibleNow: () => Eligibility;
  /**
   * When set, custody signs only if its address is this principal. V2 passes
   * the wallet. Omitted on the B.5.2 demonstration path.
   */
  readonly boundPrincipal?: string;
}

/**
 * Register the one-settlement authority, reserve the fixture BUY through the
 * control engine and wire the existing `GateSigner` to it. Nothing here
 * signs or sends: issuance does, through `leg.signer`.
 */
export async function openDomainLeg(i: DomainLegInput): Promise<DomainLegResult> {
  const { deployment: d, settlement: s } = i;
  const policy = domainPolicy(d);
  const adapterCfg = { gate: d.reviewed, gateCodehash: d.gate.runtimeCodeHash, domainSeparator: d.gate.domainSeparator };
  const adapter = gateAdapterRef(adapterCfg);
  const lifecycle = openLifecycle(i.ledgerPath);
  lifecycle.table.setModule({ module: policy.ref, status: 'ACTIVE', implementations: [policy.implementation] });
  lifecycle.table.setAdapter({ adapter, status: 'ACTIVE' });
  const registry = new DurableModuleRegistry(lifecycle.table);
  const catalog = ModuleCatalog.create(registry, [{ module: policy, corpus: [] }]);
  if (!catalog.ok) {
    lifecycle.close();
    return { ok: false, stage: 'DOMAIN_SETUP', reason: 'CATALOG_REFUSED' };
  }
  const store = SqliteLedgerStore.open({ path: i.ledgerPath, rules: controlRules(catalog.value) });
  const engine = new ControlEngine({ store, registry, catalog: catalog.value, adapters: new DurableAdapterRegistry(lifecycle.table) });
  const journal = new IssuanceJournal(store);
  const close = () => {
    store.close();
    lifecycle.close();
  };
  const fail = (stage: string, reason: string): DomainLegResult => {
    close();
    return { ok: false, stage, reason };
  };

  const P: PartyIdInput = { kind: 'eip155-address', value: d.principal };
  const A: PartyIdInput = { kind: 'eip155-address', value: d.agent };
  const principalId = validatePrincipalId(P, 'principal');
  if (!principalId.ok) return fail('DOMAIN_SETUP', 'PRINCIPAL_INVALID');

  // Custody reads chain time as of the latest issue context.
  let custodyNow = i.at;
  // Keys must be the manifest's parties: a key for any other address never reaches the gate.
  const inner = new LocalGateCustody(
    i.keys.principal,
    {
      ledger: () => store.readCommitted(principalId.value).state,
      issued: (attempt) => journal.get(attempt) !== null,
      lifecycle: (kind, name, version) => {
        const row = lifecycle.table.read(kind, name, version);
        if (row === null) return null;
        const r = JSON.parse(row.ref) as { moduleDigest?: string; adapterDigest?: string };
        return { status: row.status, digest: r.moduleDigest ?? r.adapterDigest ?? '' };
      },
      now: () => custodyNow,
    },
    { module: policy.ref, adapter },
  );
  const agent = new LocalAgentSigner(i.keys.agent);
  if (inner.principal() !== d.principal) return fail('DOMAIN_SETUP', 'PRINCIPAL_KEY_NOT_MANIFEST_PRINCIPAL');
  if (agent.address() !== d.agent) return fail('DOMAIN_SETUP', 'AGENT_KEY_NOT_MANIFEST_AGENT');

  const ref = policy.ref;
  const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
  const account = accountResource(d.chainId, d.principal);
  const market = marketResource(d.chainId, s.tokenOut);
  const pol = validatePrincipalPolicy({ principal: P, sequence: 1n, terms: [], nonce: 0n });
  if (!pol.ok) return fail('DOMAIN_SETUP', 'POLICY_INVALID');
  const grant = validateAuthorityGrant({
    lineage: { kind: 'ROOT', issuer: P },
    principal: P,
    holder: A,
    notBefore: i.at - 60n,
    expiresAt: i.at + DOMAIN_AUTHORITY_SECONDS,
    terms: [
      { kind: 'SET', vocabulary: 'MODULES', members: [moduleInput] },
      { kind: 'SET', vocabulary: 'ADAPTERS', members: [gateAdapterRefInput(adapterCfg)] },
      { kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: DOMAIN_ID, actionType: ACTION_GATE_BUY }] },
      { kind: 'SET', vocabulary: 'MARKETS', members: [{ domain: market.domain, kind: market.kind, localId: market.localId }] },
      { kind: 'RIGHT', right: 'OPEN_RISK' },
      // Exactly this settlement's debit: once reserved, the grant has nothing left.
      { kind: 'LEDGER_DIMENSION', dimensionId: 'capital-mdusd', limit: { kind: 'CAPITAL', unit: d.market.settlementUnit, decimals: d.market.fundingDecimals, atoms: s.debit }, accounting: 'CAPACITY', restoration: 'AS_CHARGED', epoch: null, sign: 'UNSIGNED', scope: { asset: null, market: null, domain: null, account: null } },
    ],
    nonce: 0n,
  });
  if (!grant.ok) return fail('DOMAIN_SETUP', `GRANT_INVALID.${grant.error.code}`);
  const once = { maxAttempts: 1 };
  const rp = await engine.registerPolicy(pol.value, i.at - 30n, once);
  if (rp.status !== 'REGISTERED') return fail('DOMAIN_SETUP', `POLICY_REFUSED.${rp.refusal.code}`);
  const rg = await engine.registerDelegation(grant.value, i.at - 30n, once);
  if (rg.status !== 'REGISTERED') return fail('DOMAIN_SETUP', `GRANT_REFUSED.${rg.refusal.code}`);

  const payload = encodeGateBuy({ account, market, quantity: s.quantity });
  const digest = actionPayloadDigest(ref, payload);
  if (!digest.ok) return fail('DOMAIN_AUTHORIZE', 'PAYLOAD_DIGEST');
  const env = validateActionEnvelope({ principal: P, authority: authorityId(grant.value), actor: A, module: moduleInput, actionType: ACTION_GATE_BUY, adapter: gateAdapterRefInput(adapterCfg), target: market, resources: [account], payloadDigest: digest.value, validFrom: i.at - 5n, expiresAt: i.at + DOMAIN_AUTHORITY_SECONDS, nonce: s.actionNonce });
  if (!env.ok) return fail('DOMAIN_AUTHORIZE', `ACTION_INVALID.${env.error.code}`);
  const out = await engine.authorizeAndReserve({ action: env.value, payload, generation: 1n, states: i.states, context: context(i.at) }, once);
  if (out.status !== 'AUTHORIZED') return fail('DOMAIN_AUTHORIZE', `${out.refusal.code}.${out.refusal.reason}`);
  const record = out.authorization;
  i.chain.bind({ executionId: record.executionId, reservation: record.reservation, generation: record.generation, adapter });

  const custody = guardCustody(inner, s, i.eligibleNow, i.boundPrincipal);
  const signer = new GateSigner({
    engine,
    store,
    journal,
    custody,
    agent,
    chain: i.chain,
    config: { gate: d.reviewed, gateCodehash: d.gate.runtimeCodeHash, domainSeparator: d.gate.domainSeparator, principal: principalId.value, principalAddress: d.principal, agentAddress: d.agent, adapter, policy: ref, deadlineSeconds: ATTEMPT_DEADLINE_SECONDS, retry: { maxAttempts: 4 } },
  });
  return {
    ok: true,
    leg: {
      policy,
      adapter,
      engine,
      store,
      journal,
      principalId: principalId.value,
      record,
      payload,
      custody,
      signer,
      issueContext: (states, at) => {
        custodyNow = at;
        return { payload, states, context: context(at) };
      },
      close,
    },
  };
}
