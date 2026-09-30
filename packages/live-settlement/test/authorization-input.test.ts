/**
 * The operator's send authorization, parser and reader only: in-memory
 * streams, no RPC, no settlement, nothing that could broadcast.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { readAuthorizationLine, type AuthorizationInput } from '../scripts/authorization-input.ts';
import { SEND_AUTHORIZATION_PHRASE, SendGate, isSendAuthorization } from '../src/send-gate.ts';

const PHRASE = 'AUTHORIZE ROBINHOOD TESTNET SEND';

/** What the runner does with a stream: read one line, then ask a fresh gate. */
async function authorizes(write: (s: PassThrough) => void, timeoutMs = 1_000): Promise<{ readonly input: AuthorizationInput; readonly accepted: boolean }> {
  const stream = new PassThrough();
  const pending = readAuthorizationLine(stream, timeoutMs);
  write(stream);
  const input = await pending;
  const gate = new SendGate();
  return { input, accepted: input.kind === 'LINE' && gate.authorize(input.line) && gate.state === 'AUTHORIZED' };
}

describe('the send-authorization parser', () => {
  it('accepts only the exact phrase, after removing one line ending', () => {
    assert.equal(SEND_AUTHORIZATION_PHRASE, PHRASE);
    for (const ok of [PHRASE, `${PHRASE}\n`, `${PHRASE}\r\n`, `${PHRASE}\r`]) assert.equal(isSendAuthorization(ok), true, JSON.stringify(ok));
    for (const bad of [
      '',
      '\n',
      'authorize robinhood testnet send',
      'Authorize Robinhood Testnet Send',
      ` ${PHRASE}`,
      `${PHRASE} `,
      `${PHRASE} \n`,
      `${PHRASE}\t`,
      `${PHRASE} NOW`,
      `YES ${PHRASE}`,
      'AUTHORIZE ROBINHOOD TESTNET',
      'AUTHORIZE ROBINHOOD MAINNET SEND',
      'AUTHORIZE  ROBINHOOD TESTNET SEND',
      'AUTHORIZE ROBINHOOD TESTNET SEND',
      `${PHRASE}\n\n`,
      `${PHRASE}\r\r\n`,
      `\u001b[200~${PHRASE}\u001b[201~`,
      `"${PHRASE}"`,
    ]) assert.equal(isSendAuthorization(bad), false, JSON.stringify(bad));
  });
});

describe('reading the authorization from the operator', () => {
  it('exact phrase + LF → accepted (the B.5.2 regression: this used to come back as "nothing")', async () => {
    const r = await authorizes((s) => s.write(`${PHRASE}\n`));
    assert.deepEqual(r.input, { kind: 'LINE', line: PHRASE });
    assert.equal(r.accepted, true);
  });

  it('exact phrase + CRLF → accepted, also when the CR and LF arrive separately', async () => {
    assert.equal((await authorizes((s) => s.write(`${PHRASE}\r\n`))).accepted, true);
    const split = await authorizes((s) => {
      s.write(`${PHRASE}\r`);
      setImmediate(() => s.write('\n'));
    });
    assert.equal(split.accepted, true);
  });

  it('typed in pieces, as a terminal delivers it → accepted', async () => {
    const r = await authorizes((s) => {
      for (const part of ['AUTHORIZE ', 'ROBINHOOD ', 'TESTNET ', 'SEND', '\n']) s.write(part);
    });
    assert.equal(r.accepted, true);
  });

  it('wrong capitalization, leading space, trailing space, extra text, empty input → refused', async () => {
    for (const text of ['authorize robinhood testnet send\n', ` ${PHRASE}\n`, `${PHRASE} \n`, `${PHRASE} PLEASE\n`, '\n']) {
      const r = await authorizes((s) => s.write(text));
      assert.equal(r.input.kind, 'LINE', JSON.stringify(text));
      assert.equal(r.accepted, false, JSON.stringify(text));
    }
  });

  it('only the first line counts: an earlier line is not skipped past', async () => {
    const r = await authorizes((s) => s.write(`\n${PHRASE}\n`));
    assert.deepEqual(r.input, { kind: 'LINE', line: '' });
    assert.equal(r.accepted, false);
  });

  it('timeout → refused', async () => {
    const r = await authorizes(() => {}, 20);
    assert.deepEqual(r.input, { kind: 'TIMEOUT' });
    assert.equal(r.accepted, false);
  });

  it('EOF → refused, including a phrase with no line ending before EOF only when it is exact', async () => {
    const eof = await authorizes((s) => s.end());
    assert.deepEqual(eof.input, { kind: 'EOF' });
    assert.equal(eof.accepted, false);
    // readline hands over a final unterminated line at end of input; it is judged like any other line.
    assert.equal((await authorizes((s) => s.end(PHRASE))).accepted, true);
    assert.equal((await authorizes((s) => s.end(`${PHRASE} `))).accepted, false);
  });

  it('the reader is parser-only: it cannot reach settlement, RPC or signing code', () => {
    const text = readFileSync(new URL('../scripts/authorization-input.ts', import.meta.url), 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:readline', 'node:stream']);
  });
});
