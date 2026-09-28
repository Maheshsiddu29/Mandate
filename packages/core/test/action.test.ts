/**
 * The generic action envelope (action-state-model.md §4.1): domain-independent,
 * digest-identified, and carrying its payload only by a module-bound digest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ACTION_PAYLOAD_BYTES,
  MAX_ACTION_RESOURCES,
  actionId,
  actionPayloadDigest,
  validateActionEnvelope,
  validateModuleRef,
  type ActionEnvelopeInput,
  type CoreResult,
  type ResourceIdInput,
} from '../src/index.ts';
import {
  BTC_PERP_L,
  EVM_ACCOUNT,
  EVM_GATE,
  EVM_SPOT_V1,
  FAAPL,
  FAAPL_MARKET,
  L_SUB,
  PERP_AGENT,
  PERP_V1,
  PERP_V2,
  PRINCIPAL,
  SPOT_AGENT,
  USDG,
  USDG_ON_L,
  VENUE_SIGNER_L,
  digestOf,
  must,
} from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

const PERP_ORDER: ActionEnvelopeInput = {
  principal: PRINCIPAL,
  authority: digestOf('authority:perp-agent'),
  actor: PERP_AGENT,
  module: PERP_V1,
  actionType: 'perp.order',
  adapter: VENUE_SIGNER_L,
  target: BTC_PERP_L,
  resources: [L_SUB, USDG_ON_L],
  payloadDigest: digestOf('payload:perp-order'),
  validFrom: 1_000n,
  expiresAt: 1_300n,
  nonce: 1n,
};

const SPOT_BUY: ActionEnvelopeInput = {
  principal: PRINCIPAL,
  authority: digestOf('authority:spot-agent'),
  actor: SPOT_AGENT,
  module: EVM_SPOT_V1,
  actionType: 'evm-spot.buy',
  adapter: EVM_GATE,
  target: FAAPL_MARKET,
  resources: [EVM_ACCOUNT, FAAPL, USDG],
  payloadDigest: digestOf('payload:spot-buy'),
  validFrom: 1_000n,
  expiresAt: 1_300n,
  nonce: 1n,
};

describe('ActionEnvelope', () => {
  it('has the same Core fields in every domain, and no domain field', () => {
    const perp = must(validateActionEnvelope(PERP_ORDER));
    const spot = must(validateActionEnvelope(SPOT_BUY));
    const fields = [
      'actionType',
      'actor',
      'adapter',
      'authority',
      'expiresAt',
      'module',
      'nonce',
      'payloadDigest',
      'principal',
      'resources',
      'target',
      'validFrom',
    ];
    assert.deepEqual(Object.keys(perp).sort(), fields);
    assert.deepEqual(Object.keys(spot).sort(), fields);
  });

  it('refuses a domain field placed in the envelope', () => {
    for (const field of ['side', 'size', 'leverage', 'limitPrice', 'reduceOnly', 'riskDirection', 'stateRefs', 'actionId']) {
      assert.deepEqual(validateActionEnvelope({ ...PERP_ORDER, [field]: 'x' } as never), { ok: false, error: { code: 'UNKNOWN_FIELD', path: `action.${field}` } }, field);
    }
  });

  it('is identified by its content: the ActionId is computed, and every field moves it', () => {
    const a = must(validateActionEnvelope(PERP_ORDER));
    assert.equal(actionId(a), actionId(must(validateActionEnvelope({ ...PERP_ORDER }))));
    assert.notEqual(actionId(a), actionId(must(validateActionEnvelope({ ...PERP_ORDER, nonce: 2n }))));
  });

  it('refuses the target restated among the other resources, and duplicate resources', () => {
    assert.deepEqual(validateActionEnvelope({ ...PERP_ORDER, resources: [L_SUB, BTC_PERP_L] }), {
      ok: false,
      error: { code: 'TARGET_REPEATED_IN_RESOURCES', path: 'action.resources[1]' },
    });
    assert.equal(code(validateActionEnvelope({ ...PERP_ORDER, resources: [L_SUB, L_SUB] })), 'DUPLICATE_SET_MEMBER');
  });

  it('bounds its resource set', () => {
    const many: ResourceIdInput[] = Array.from({ length: MAX_ACTION_RESOURCES + 1 }, (_, i) => ({ domain: 'perp', kind: 'ACCOUNT', localId: `acct-${i}` }));
    assert.equal(code(validateActionEnvelope({ ...PERP_ORDER, resources: many })), 'COLLECTION_TOO_LARGE');
  });

  it('requires a non-empty reservable window', () => {
    assert.deepEqual(validateActionEnvelope({ ...PERP_ORDER, validFrom: 1_300n }), { ok: false, error: { code: 'INVALID_TIME_WINDOW', path: 'action' } });
    assert.deepEqual(validateActionEnvelope({ ...PERP_ORDER, validFrom: 'soon' }), { ok: false, error: { code: 'NON_CANONICAL_INTEGER', path: 'action.validFrom' } });
  });

  it('names its module exactly: no shorthand, and a missing digest is refused', () => {
    assert.deepEqual(validateActionEnvelope({ ...PERP_ORDER, module: 'perp-policy@1' as never }), { ok: false, error: { code: 'WRONG_TYPE', path: 'action.module' } });
    const { moduleDigest: _d, ...noDigest } = PERP_V1;
    assert.equal(code(validateActionEnvelope({ ...PERP_ORDER, module: noDigest as never })), 'MISSING_FIELD');
  });

  it('the same action under two module versions is two actions', () => {
    assert.notEqual(actionId(must(validateActionEnvelope(PERP_ORDER))), actionId(must(validateActionEnvelope({ ...PERP_ORDER, module: PERP_V2 }))));
  });
});

describe('payload digest', () => {
  const payload = new TextEncoder().encode('opaque perp order bytes');

  it('binds the payload to the module that reads it', () => {
    const v1 = must(validateModuleRef(PERP_V1));
    const v2 = must(validateModuleRef(PERP_V2));
    assert.notEqual(must(actionPayloadDigest(v1, payload)), must(actionPayloadDigest(v2, payload)));
    assert.equal(must(actionPayloadDigest(v1, payload)), must(actionPayloadDigest(v1, payload.slice())));
    assert.notEqual(must(actionPayloadDigest(v1, payload)), must(actionPayloadDigest(v1, payload.subarray(1))));
  });

  it('is bounded, and never parses the payload', () => {
    const v1 = must(validateModuleRef(PERP_V1));
    assert.equal(code(actionPayloadDigest(v1, new Uint8Array(MAX_ACTION_PAYLOAD_BYTES + 1))), 'COLLECTION_TOO_LARGE');
    assert.equal(code(actionPayloadDigest(v1, new Uint8Array(0))), 'OK');
  });
});
