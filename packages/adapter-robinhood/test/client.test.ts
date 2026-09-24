import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { UnixSeconds } from '@mandate/kernel';
import { AdapterErrorCode, RobinhoodClient, type FetchLike } from '../src/index.ts';
import { MAINNET_FIXTURE_ROOT } from './support/mainnet-fixture.ts';

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function one(value: Response | (() => Promise<Response>)): FetchLike {
  return async () => typeof value === 'function' ? value() : value;
}

describe('Robinhood live client failure behavior', () => {
  it('uses the same strict parser for a live-shaped response', async () => {
    const body = readFileSync(`${MAINNET_FIXTURE_ROOT}raw/price-NVDA.json`, 'utf8');
    const client = new RobinhoodClient({
      fetch: one(response(body)), nowUnixSeconds: () => 1_790_289_408n as UnixSeconds,
    });
    const result = await client.price('NVDA');
    assert.ok(result.ok);
    assert.equal(result.value.tokenSymbol.value, 'NVDA');
  });

  it('distinguishes rate limit, missing asset, HTTP error and timeout', async () => {
    const rate = await new RobinhoodClient({ fetch: one(response('', 429)) }).assets();
    assert.equal(rate.ok ? '' : rate.error.code, AdapterErrorCode.RATE_LIMITED);
    const missing = await new RobinhoodClient({ fetch: one(response('', 404)) }).price('WYFI');
    assert.equal(missing.ok ? '' : missing.error.code, AdapterErrorCode.ASSET_NOT_FOUND);
    const http = await new RobinhoodClient({ fetch: one(response('', 503)) }).assets();
    assert.equal(http.ok ? '' : http.error.code, AdapterErrorCode.HTTP_ERROR);
    const timeout = await new RobinhoodClient({ fetch: one(async () => { throw { name: 'AbortError' }; }) }).assets();
    assert.equal(timeout.ok ? '' : timeout.error.code, AdapterErrorCode.TIMEOUT);
  });

  it('rejects malformed JSON and partial security-critical responses', async () => {
    const malformed = await new RobinhoodClient({ fetch: one(response('{')) }).assets();
    assert.equal(malformed.ok ? '' : malformed.error.code, AdapterErrorCode.MALFORMED_RESPONSE);
    const partial = await new RobinhoodClient({ fetch: one(response('{"assets":[{}]}')) }).assets();
    assert.equal(partial.ok ? '' : partial.error.code, AdapterErrorCode.MISSING_REQUIRED_FIELD);
  });

  it('rejects unsafe symbols before issuing a request', async () => {
    let called = false;
    const client = new RobinhoodClient({ fetch: async () => { called = true; return response('{}'); } });
    const result = await client.price('../assets');
    assert.equal(result.ok ? '' : result.error.code, AdapterErrorCode.INVALID_IDENTITY);
    assert.equal(called, false);
  });

  it('detects RPC errors and a chain mismatch', async () => {
    const rpcError = await new RobinhoodClient({
      fetch: one(response('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}')),
    }).assertMainnetChain();
    assert.equal(rpcError.ok ? '' : rpcError.error.code, AdapterErrorCode.RPC_ERROR);
    const wrongChain = await new RobinhoodClient({
      fetch: one(response('{"jsonrpc":"2.0","id":1,"result":"0x1"}')),
    }).assertMainnetChain();
    assert.equal(wrongChain.ok ? '' : wrongChain.error.code, AdapterErrorCode.CHAIN_MISMATCH);
  });
});
