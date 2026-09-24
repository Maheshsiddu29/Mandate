/**
 * Documentation that is generated from code must not drift from it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DOC_PATH, renderReasonCodesDoc } from './support/generate-reason-codes-doc.ts';

test('the committed reason-code registry matches the code', () => {
  assert.equal(
    readFileSync(DOC_PATH, 'utf8'),
    renderReasonCodesDoc(),
    'docs/reason-codes.md is stale; run `npm run docs:generate`',
  );
});
