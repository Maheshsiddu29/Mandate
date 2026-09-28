/**
 * Fixtures for the durable store: temporary database files, a canonical
 * three-batch history (policy, grant, reservation) plus an attempt admission,
 * and a child-process runner for real crashes. Offline and deterministic; the
 * only I/O is the temporary directory each test creates and removes.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reservationIdFor, validateAdapterRef, validateResourceId, type AdapterRef, type Digest32, type ExecutionAuthorizationId } from '@mandate/core';
import type { Identifier } from '@mandate/kernel';
import { attemptIdFor, deriveReserveEvent, type AttemptAdmission, type LedgerEvent, type LedgerState } from '@mandate/ledger';
import { ALL_MODULES, PRINCIPAL, T0, capital, contribution, digestOf, dim, must, plan, policy, root, units } from '../../../ledger/test/support/fixtures.ts';

export { PRINCIPAL, T0, must, root, policy, digestOf, units, dim, ALL_MODULES };

export function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-ledger-sqlite-'));
  return { path: join(dir, 'ledger.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const GRANT = root({ terms: [ALL_MODULES, dim('capital', units(10_000))] });
export const PLAN = plan({ authority: GRANT, action: 'x', contributions: [contribution(capital(units(100)))] });
export const ADAPTER: AdapterRef = must(validateAdapterRef({ adapterId: 'test-venue-signer', adapterVersion: 1, adapterDigest: digestOf('adapter:test:1') }));

export const SETUP: LedgerEvent[] = [
  { kind: 'REGISTER_POLICY', at: T0, policy: policy() },
  { kind: 'REGISTER_GRANT', at: T0, grant: GRANT },
];

export function reserveEvent(s: LedgerState): LedgerEvent {
  return must(deriveReserveEvent(s, PLAN, T0));
}

export function admission(label = 'a', nonce = 7n): AttemptAdmission {
  const reservation = reservationIdFor(PLAN.action, PLAN.generation);
  const base = { reservation, generation: PLAN.generation, action: PLAN.action, module: PLAN.module, adapter: ADAPTER, authorization: digestOf('execution-authorization:1') as ExecutionAuthorizationId, ordinal: 1 };
  return {
    attempt: attemptIdFor(base),
    ...base,
    venueAccount: must(validateResourceId({ domain: 'perp', kind: 'ACCOUNT', localId: 'venue-l:sub-1' }, ['ACCOUNT'] as const, 'a')),
    artifact: { kind: 'test.tx-hash' as Identifier, id: new TextEncoder().encode(`tx:${label}`) },
    slot: { scope: 'test:sub-1:key-2' as Identifier, sequence: nonce },
    validUntil: T0 + 600n,
    requirements: digestOf('pre-execution:ok') as Digest32,
    revalidation: digestOf('revalidation:ok') as Digest32,
  };
}

export const admitEvent = (a: AttemptAdmission = admission()): LedgerEvent => ({ kind: 'ADMIT_ATTEMPT', at: T0, admission: a });

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

/** Run the child synchronously; it ends however it ends (a kill is reported as the signal). */
export function runChild(args: readonly string[]): { status: number | null; signal: string | null; stderr: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, ...args], { encoding: 'utf8' });
  return { status: r.status, signal: r.signal, stderr: r.stderr };
}

/** Run the child asynchronously, for concurrent writers. */
export function runChildAsync(args: readonly string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', CHILD, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    c.on('close', (status) => resolve({ status, stderr }));
  });
}
