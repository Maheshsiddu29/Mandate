/**
 * Mandate Core v1 canonical-encoding corpus generator (`corpus/core-v1`).
 *
 * Three parts:
 *
 * - `vectors`: one per object instance — the human-readable input (bigints as
 *   decimal strings, exactly what the validator accepts), its canonical bytes,
 *   and its digest under the object's domain tag;
 * - `derivations`: identities Core derives rather than encodes as an object
 *   (`ReservationId`, the module-bound action payload digest);
 * - `negative`: byte strings every conforming decoder must refuse, each with
 *   the structured error it must refuse them with.
 *
 * Every expected value is computed by `@mandate/core` itself. The corpus pins
 * the encoding so that a change to it is a visible diff, and gives a second
 * implementation something to be held to.
 *
 * Run: `npm run core-corpus:generate`. `corpus.test.ts` and
 * `npm run generated:check` fail if the committed file differs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteWriter } from '@mandate/kernel';
import {
  CoreTag,
  actionId,
  actionPayloadDigest,
  bytesToHex,
  encodeActionEnvelope,
  encodeModuleRef,
  encodePrincipalPolicy,
  encodeReservationRef,
  encodeStateBinding,
  reservationIdFor,
  stateBindingInputOf,
  stateId,
  taggedWriter,
  validateActionEnvelope,
  validateModuleRef,
  validatePrincipalPolicy,
  validateReservationRef,
  validateStateBinding,
  validateStateEnvelope,
  validateTerm,
  writeList,
  writeParty,
  writeResourceId,
  writeStateBinding,
  writeTerm,
  ZERO_DIGEST,
  executionAuthorizationId,
  executionBindingId,
  reservationIdOf,
  stateBindingIdsOf,
  validateExecutionAuthorization,
  validateExecutionBindingRef,
  type ActionId,
  type ReservationGeneration,
  type StateBinding,
} from '../../src/index.ts';
import { JSON_CODECS, toJson, type JsonValue } from './cases.ts';
import {
  ACCOUNT_REQUIREMENT,
  BTC,
  EVM_GATE,
  L_SUB,
  MARK_REQUIREMENT,
  PERP_V1,
  PERP_V2,
  USDG,
  USDG_ON_L,
  digestOf,
  must,
  notionalAtLimit,
  sampleActionInput,
  sampleAuthorizationInput,
  sampleBindingInput,
  sampleExecutionBindingInput,
  sampleGrantInput,
  samplePolicyInput,
  sampleReceiptHeaderInput,
  sampleReceiptReferencesInput,
  sampleReservationInput,
  sampleStateInput,
  unvalued,
} from './fixtures.ts';

export const CORE_CORPUS_VERSION = 1;
export const CORE_CORPUS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../corpus/core-v1/vectors.json');

interface Vector {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly input: JsonValue;
  readonly canonical: string;
  readonly digest: string | null;
}

interface Derivation {
  readonly id: string;
  readonly derives: 'ReservationId' | 'ActionPayloadDigest';
  readonly description: string;
  readonly input: JsonValue;
  readonly digest: string;
}

interface Negative {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly bytes: string;
  readonly error: string;
}

/** Tag of each object type, recorded in the corpus so a reader need not consult the source. */
const TAGS: { readonly [type: string]: string } = {
  ModuleRef: CoreTag.MODULE_REF,
  AdapterRef: CoreTag.ADAPTER_REF,
  EconomicQuantity: CoreTag.QUANTITY,
  PrincipalPolicy: CoreTag.PRINCIPAL_POLICY,
  AuthorityGrant: CoreTag.AUTHORITY,
  ActionEnvelope: CoreTag.ACTION,
  StateEnvelope: CoreTag.STATE,
  StateBinding: CoreTag.STATE_BINDING,
  ReservationRef: CoreTag.RESERVATION_REF,
  ExecutionAuthorization: CoreTag.AUTHORIZATION,
  ExecutionBindingRef: CoreTag.EXECUTION_BINDING,
  ReceiptHeader: CoreTag.RECEIPT_HEADER,
  ReceiptReferences: CoreTag.RECEIPT_REFERENCES,
};

function vector(id: string, type: string, description: string, input: object): Vector {
  const codec = JSON_CODECS[type];
  if (codec === undefined) throw new Error(`no codec for ${type}`);
  const json = toJson(input);
  return { id, type, description, input: json, canonical: bytesToHex(must(codec.encodeJson(json))), digest: codec.digestJson(json) };
}

function positives(): Vector[] {
  const action = must(validateActionEnvelope(sampleActionInput()));
  const aId = actionId(action);
  const state = must(validateStateEnvelope(sampleStateInput()));
  const bindingInput = sampleBindingInput(stateId(state));
  const binding = must(validateStateBinding(bindingInput));
  const authorization = must(validateExecutionAuthorization(sampleAuthorizationInput(aId, [stateBindingInputOf(binding)])));
  const bindingIds = [...stateBindingIdsOf(authorization)];
  const executionBinding = must(validateExecutionBindingRef(sampleExecutionBindingInput(executionAuthorizationId(authorization), aId, bindingIds)));

  const spotBuy = {
    ...sampleActionInput(),
    module: { domainId: 'evm-spot', moduleId: 'evm-spot', moduleVersion: 1, moduleDigest: digestOf('manifest:evm-spot:1') },
    actionType: 'evm-spot.buy',
    adapter: EVM_GATE,
    target: { domain: 'evm-spot', kind: 'MARKET', localId: 'fixture:fAAPL' },
    resources: [USDG],
  };

  return [
    vector('module-ref/perp-policy-v1', 'ModuleRef', 'A semantic module: name, version and manifest digest.', PERP_V1),
    vector('module-ref/perp-policy-v2', 'ModuleRef', 'The next version: a new version and a new digest.', PERP_V2),
    vector('module-ref/perp-policy-v2-other-digest', 'ModuleRef', 'Same name and version as v2, different digest: a different semantic module (DOM-2).', {
      ...PERP_V2,
      moduleDigest: digestOf('manifest:perp-policy:2:patched'),
    }),
    vector('adapter-ref/evm-gate-v1', 'AdapterRef', 'An enforcement adapter bound by digest.', EVM_GATE),

    vector('quantity/capital', 'EconomicQuantity', '600.000000 USDG of capital, funding asset USDG.', unvalued('CAPITAL', 'USDG', 6, 600_000_000n, USDG)),
    vector('quantity/margin', 'EconomicQuantity', '600.000000 USDG of margin: same number and unit as the capital vector, different kind and identity.', unvalued('MARGIN', 'USDG', 6, 600_000_000n, USDG_ON_L)),
    vector('quantity/position-long', 'EconomicQuantity', '+0.03 BTC position size, exposure to canonical BTC.', unvalued('POSITION_SIZE', 'BTC', 8, 3_000_000n, BTC)),
    vector('quantity/position-short', 'EconomicQuantity', '−0.01 BTC: a signed kind, encoded as int256.', unvalued('POSITION_SIZE', 'BTC', 8, -1_000_000n, BTC)),
    vector('quantity/notional-at-limit', 'EconomicQuantity', '4,000.00 USD committed notional valued at an order\'s limit price, sourced from the action.', notionalAtLimit(400_000n, 10_000_000n, aId, 1_790_813_800n)),
    vector('quantity/notional-at-execution', 'EconomicQuantity', '2,997.00 USD committed notional valued at the fill price, sourced from an observation.', {
      kind: 'NOTIONAL',
      unit: 'USD',
      decimals: 2,
      atoms: 299_700n,
      asset: BTC,
      valuation: {
        price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: 9_990_000n },
        basis: 'EXECUTION',
        source: { kind: 'OBSERVATION', observationId: digestOf('observation:fill') },
        observedAt: 1_790_813_806n,
      },
    }),
    vector('quantity/gross-exposure-at-mark', 'EconomicQuantity', '19,000.00 USD marked gross exposure: an invariant value at an admitted mark, never a ledger counter.', {
      kind: 'GROSS_EXPOSURE',
      unit: 'USD',
      decimals: 2,
      atoms: 1_900_000n,
      asset: BTC,
      valuation: {
        price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: 10_000_000n },
        basis: 'MARK',
        source: { kind: 'STATE', stateId: stateId(state) },
        observedAt: 1_790_813_800n,
      },
    }),
    vector('quantity/pnl-realized', 'EconomicQuantity', '−35.000000 USDG realized PnL: signed, no asset, no valuation.', unvalued('PNL', 'USDG', 6, -35_000_000n, null)),
    vector('quantity/count', 'EconomicQuantity', '3 actions.', unvalued('COUNT', 'COUNT', 0, 3n, null)),

    vector('principal-policy/sample', 'PrincipalPolicy', 'A global BTC notional dimension, a global marked-exposure invariant and a global mark-price state policy.', samplePolicyInput()),
    vector('principal-policy/empty', 'PrincipalPolicy', 'The explicitly empty policy: roots are independent, by the principal\'s statement.', { ...samplePolicyInput(), terms: [] }),

    vector('authority/root', 'AuthorityGrant', 'A root grant (Core mandate) carrying all seven term kinds.', sampleGrantInput()),
    vector('authority/delegation', 'AuthorityGrant', 'A delegation: parent by AuthorityId, issued by the parent\'s holder.', {
      ...sampleGrantInput(),
      lineage: { kind: 'DELEGATION', parent: digestOf('sample:authority:parent'), issuer: sampleGrantInput().holder },
      holder: { kind: 'eip155-address', value: `0x${'22'.repeat(20)}` },
      terms: [
        { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1] },
        { kind: 'RIGHT', right: 'OPEN_RISK' },
        { kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [L_SUB], params: '0x0300' },
      ],
    }),

    vector('action/perp-order', 'ActionEnvelope', 'A perp order envelope: no perp field in it; the payload is a module-bound digest.', sampleActionInput()),
    vector('action/spot-buy', 'ActionEnvelope', 'A spot buy envelope: the same Core fields as the perp order.', spotBuy),

    vector('state/mark-price', 'StateEnvelope', 'A venue mark-price observation at a venue sequence, normalized under perp-policy v1.', sampleStateInput()),
    vector('state/mark-price-under-v2', 'StateEnvelope', 'The same observation normalized under perp-policy v2: same domain, different module, different state identity.', {
      ...sampleStateInput(),
      module: PERP_V2,
    }),
    vector('state/account-with-validity', 'StateEnvelope', 'An account snapshot with a source-declared validUntil.', {
      ...sampleStateInput(),
      stateKind: 'perp.account',
      subject: L_SUB,
      validUntil: 1_790_813_830n,
      finality: { ladder: 'venue-l.account', level: 'ACKNOWLEDGED' },
      payloadDigest: digestOf('sample:state-payload:account'),
    }),

    vector('state-binding/mark-recheck', 'StateBinding', 'A mark-price binding: AGE 5 s, RECHECK at issue, enforced at execution by the limit price.', bindingInput),
    vector('state-binding/account-sequence', 'StateBinding', 'An account binding: SEQUENCE freshness, WITHIN_POLICY, pre-trade only.', { ...bindingInput, requirement: ACCOUNT_REQUIREMENT }),
    vector('state-binding/bounded-by-freshness', 'StateBinding', 'A binding whose artifact must expire with the state (AGE + BOUNDED_BY_FRESHNESS).', {
      ...bindingInput,
      requirement: { ...MARK_REQUIREMENT, atExecution: { kind: 'BOUNDED_BY_FRESHNESS' } },
    }),

    vector('reservation-ref/generation-1', 'ReservationRef', 'Generation 1 of the sample action.', sampleReservationInput(aId)),
    vector('reservation-ref/generation-2', 'ReservationRef', 'Generation 2 of the same action: a different reservation.', { ...sampleReservationInput(aId), generation: 2n, ledgerVersion: 61n }),

    vector('execution-authorization/sample', 'ExecutionAuthorization', 'An authorization of generation 1 with the state binding it relied on.', sampleAuthorizationInput(aId, [bindingInput])),
    vector('execution-binding/sample', 'ExecutionBindingRef', 'The adapter\'s binding of execution parameters to that authorization.', {
      ...sampleExecutionBindingInput(executionAuthorizationId(authorization), aId, bindingIds),
    }),

    vector('receipt-header/decision', 'ReceiptHeader', 'A decision receipt header that wrote ledger version 58.', sampleReceiptHeaderInput()),
    vector('receipt-references/sample', 'ReceiptReferences', 'Every lifecycle object a receipt names, by digest.', {
      ...sampleReceiptReferencesInput(aId, reservationIdOf(authorization.reservation), bindingIds, executionBindingId(executionBinding)),
    }),
  ];
}

function derivations(): Derivation[] {
  const aId = actionId(must(validateActionEnvelope(sampleActionInput())));
  const payload = new TextEncoder().encode('opaque perp order payload');
  const v1 = must(validateModuleRef(PERP_V1));
  const v2 = must(validateModuleRef(PERP_V2));
  return [
    ...[1n, 2n].map((g) => ({
      id: `reservation-id/generation-${g}`,
      derives: 'ReservationId' as const,
      description: `H("${CoreTag.RESERVATION}", actionId, generation ${g}).`,
      input: toJson({ actionId: aId, generation: g }),
      digest: reservationIdFor(aId as ActionId, g as ReservationGeneration),
    })),
    ...[v1, v2].map((m) => ({
      id: `payload-digest/perp-policy-v${m.moduleVersion}`,
      derives: 'ActionPayloadDigest' as const,
      description: `One payload under module v${m.moduleVersion}: the module digest is inside the hash.`,
      input: toJson({ moduleDigest: m.moduleDigest, payload: bytesToHex(payload) }),
      digest: must(actionPayloadDigest(m, payload)),
    })),
  ];
}

function tagLength(tag: string): number {
  return 2 + tag.length;
}

function negatives(): Negative[] {
  const action = must(validateActionEnvelope(sampleActionInput()));
  const actionBytes = encodeActionEnvelope(action);
  const policyBytes = encodePrincipalPolicy(must(validatePrincipalPolicy(samplePolicyInput())));
  const state = must(validateStateEnvelope(sampleStateInput()));
  const binding = must(validateStateBinding(sampleBindingInput(stateId(state))));

  const out: Negative[] = [];
  const add = (id: string, type: string, description: string, bytes: Uint8Array, error: string): void => {
    const codec = JSON_CODECS[type];
    if (codec === undefined) throw new Error(`no codec for ${type}`);
    const actual = codec.decodeError(bytes);
    if (actual?.code !== error) throw new Error(`${id}: expected ${error}, got ${actual?.code ?? 'OK'}`);
    out.push({ id, type, description, bytes: bytesToHex(bytes), error });
  };

  add('truncated', 'ActionEnvelope', 'The sample action with its last byte removed.', actionBytes.subarray(0, actionBytes.length - 1), 'ENCODING_MALFORMED');

  const trailing = new Uint8Array(actionBytes.length + 1);
  trailing.set(actionBytes);
  add('trailing-bytes', 'ActionEnvelope', 'The sample action with one extra zero byte.', trailing, 'ENCODING_TRAILING_BYTES');

  add('wrong-tag', 'AuthorityGrant', 'A principal policy decoded as a grant: domain separation.', policyBytes, 'ENCODING_WRONG_TAG');

  const version = actionBytes.slice();
  version[tagLength(CoreTag.ACTION) + 1] = 2;
  add('unsupported-version', 'ActionEnvelope', 'The sample action with schema version 2.', version, 'ENCODING_UNSUPPORTED_VERSION');

  // The action's two resources, written in descending rather than ascending order.
  const [first, second] = action.resources;
  if (first === undefined || second === undefined) throw new Error('sample action needs two resources');
  const encodeResource = (r: typeof first): Uint8Array => {
    const w = new ByteWriter();
    writeResourceId(w, r);
    return w.finish();
  };
  const a = encodeResource(first);
  const b = encodeResource(second);
  const hex = bytesToHex(actionBytes);
  const swapped = hex.replace(bytesToHex(a).slice(2) + bytesToHex(b).slice(2), bytesToHex(b).slice(2) + bytesToHex(a).slice(2));
  add('non-canonical-set-order', 'ActionEnvelope', 'Resources out of canonical order: refused, not re-sorted.', hexBytes(swapped), 'ENCODING_NON_CANONICAL');

  // The state binding's validUntil presence flag follows its observedAt.
  const prefix = new ByteWriter().str(CoreTag.STATE_BINDING).u16(1).str(binding.stateKind);
  writeResourceId(prefix, binding.subject);
  prefix.str(binding.sourceId).u8(2).u8(3).u64(1040n).i64(binding.observedAt);
  const flagAt = prefix.finish().length;
  const flag = encodeStateBinding(binding).slice();
  if (flag[flagAt] !== 0) throw new Error('flag offset moved');
  flag[flagAt] = 2;
  add('invalid-presence-flag', 'StateBinding', 'A presence flag of 2: only 0 and 1 decode.', flag, 'ENCODING_INVALID_FLAG');

  const unknownCode = policyBytes.slice();
  unknownCode[tagLength(CoreTag.PRINCIPAL_POLICY) + 2 + 2 + 'eip155-address'.length + 2 + 42 + 8 + 2] = 0xee;
  add('unknown-enum-code', 'PrincipalPolicy', 'A term-kind wire code that does not exist.', unknownCode, 'ENCODING_UNKNOWN_CODE');

  const withRight = taggedWriter(CoreTag.PRINCIPAL_POLICY);
  writeParty(withRight, must(validatePrincipalPolicy(samplePolicyInput())).principal);
  withRight.u64(1n);
  writeList(withRight, [must(validateTerm({ kind: 'RIGHT', right: 'OPEN_RISK' }, 't'))], writeTerm);
  withRight.u64(1n);
  add('policy-with-right', 'PrincipalPolicy', 'A principal policy carrying an OPEN_RISK right: it grants nothing.', withRight.finish(), 'PRINCIPAL_POLICY_GRANTS_AUTHORITY');

  const reservation = encodeReservationRef(must(validateReservationRef(sampleReservationInput(actionId(action))))).slice();
  reservation.fill(0, tagLength(CoreTag.RESERVATION_REF) + 2 + 32, tagLength(CoreTag.RESERVATION_REF) + 2 + 40);
  add('generation-zero', 'ReservationRef', 'A reservation ref at generation 0: no reservation has generation 0.', reservation, 'GENERATION_ZERO');

  const zero = encodeModuleRef(must(validateModuleRef(PERP_V1))).slice();
  zero.fill(0, zero.length - 32);
  add('module-digest-zero', 'ModuleRef', 'A ModuleRef whose digest is the all-zero placeholder.', zero, 'ZERO_DIGEST');
  if (ZERO_DIGEST !== bytesToHex(zero.subarray(zero.length - 32))) throw new Error('zero digest mismatch');

  const untrusted = taggedWriter(CoreTag.STATE_BINDING);
  writeStateBinding(untrusted, { ...binding, trustClass: 'UNTRUSTED' } as unknown as StateBinding);
  add('binding-untrusted', 'StateBinding', 'A binding at trust class UNTRUSTED: never admissible.', untrusted.finish(), 'TRUST_CLASS_NOT_ADMISSIBLE');

  const bounded = taggedWriter(CoreTag.STATE_BINDING);
  writeStateBinding(bounded, {
    ...binding,
    requirement: { ...binding.requirement, freshness: { kind: 'SEQUENCE' }, atExecution: { kind: 'BOUNDED_BY_FRESHNESS' } },
  } as unknown as StateBinding);
  add('bounded-by-sequence', 'StateBinding', 'BOUNDED_BY_FRESHNESS with SEQUENCE freshness: sequence distance has no expiry time.', bounded.finish(), 'EXECUTION_DEPENDENCE_INCOMPATIBLE');

  return out;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function buildCorpus(): object {
  const vectors = positives();
  const ids = [...vectors.map((v) => v.id), ...derivations().map((d) => d.id), ...negatives().map((n) => n.id)];
  if (new Set(ids).size !== ids.length) throw new Error('duplicate vector id');
  return {
    corpusVersion: CORE_CORPUS_VERSION,
    encoding: 'Mandate Core v1 canonical encoding, keccak-256 (docs/adr/0020-mandate-core-package-and-encoding.md)',
    note: 'Integers are decimal strings; the validators accept exactly that form. `canonical` is the tagged top-level encoding; `digest` is keccak-256 of it.',
    tags: TAGS,
    vectorCount: vectors.length,
    vectors,
    derivations: derivations(),
    negative: negatives(),
  };
}

export function serializeCorpus(): string {
  return `${JSON.stringify(buildCorpus(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(CORE_CORPUS_PATH), { recursive: true });
  writeFileSync(CORE_CORPUS_PATH, serializeCorpus(), 'utf8');
  process.stdout.write(`wrote ${CORE_CORPUS_PATH}\n`);
}
