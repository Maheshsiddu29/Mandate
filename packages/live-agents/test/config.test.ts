import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, readConfig } from '../src/config.ts';

describe('Live AI Lab runtime configuration', () => {
  it('keeps local mode loopback-only with the existing port, origins and persistence defaults', () => {
    const config = readConfig({ LIVE_AGENTS_PORT: '9123' });
    assert.equal(config.publicDemo, false);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 9123);
    assert.deepEqual(config.allowedOrigins, ['http://localhost:3000', 'http://127.0.0.1:3000']);
    assert.equal(config.stateDir, '.live');
  });

  it('uses Railway PORT and one exact HTTPS origin only in explicit public-demo mode', () => {
    const config = readConfig({
      MANDATE_PUBLIC_DEMO: '1',
      MANDATE_ALLOWED_ORIGIN: 'https://mandateai.vercel.app',
      PORT: '54321',
      LIVE_AGENTS_PORT: '9123',
      LIVE_ALLOWED_ORIGINS: 'http://localhost:3000',
      LIVE_STATE_DIR: '/private/state',
    });
    assert.equal(config.publicDemo, true);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 54321);
    assert.deepEqual(config.allowedOrigins, ['https://mandateai.vercel.app']);
    assert.equal(config.stateDir, '/private/state');
  });

  it('falls back safely when Railway PORT is absent and refuses unsafe public origins', () => {
    assert.equal(readConfig({ MANDATE_PUBLIC_DEMO: '1', MANDATE_ALLOWED_ORIGIN: 'https://mandateai.vercel.app' }).port, DEFAULTS.port);
    for (const origin of [undefined, '*', 'http://mandateai.vercel.app', 'https://user:pass@mandateai.vercel.app', 'https://mandateai.vercel.app/path']) {
      assert.throws(() => readConfig({ MANDATE_PUBLIC_DEMO: '1', ...(origin === undefined ? {} : { MANDATE_ALLOWED_ORIGIN: origin }) }), /exact HTTPS origin/);
    }
  });
});
