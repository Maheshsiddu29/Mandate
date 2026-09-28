/**
 * The deterministic in-memory reference store (ADR 0022).
 *
 * It exists to pin the store contract's semantics for tests, not to be
 * durable: it has no disk, no fsync and no crash model. It does not pretend
 * to model machine crashes — durable atomicity is the production store's
 * responsibility — but it does let a test inject a failure at every point of
 * a commit and observe that the result is always the entire old state or the
 * entire new one.
 *
 * Per principal it keeps the committed batches and the folded state. A
 * commit is one synchronous critical section — version check, head check,
 * the reducer over the whole batch, publish — with no `await` inside it, so
 * in a single-threaded runtime nothing interleaves with it. That is
 * per-principal mutual exclusion without a lock, and there is no lock or
 * shared counter across principals at all: two principals' commits never
 * contend.
 *
 * Two test hooks, both optional:
 *
 * - `delay(point, principal)` is awaited after a read captures its snapshot
 *   (`READ`) and before a commit's critical section begins (`COMMIT`). It lets
 *   a test widen the read-to-commit window, run another agent's commit inside
 *   it, or randomize interleavings. It can never run inside the critical
 *   section.
 * - `fault(point, principal)` is called synchronously at each named point
 *   inside the critical section and may throw. The publish is a single step
 *   after the last fault point, so a throw anywhere leaves nothing written.
 */

import type { LedgerEvent } from './events.ts';
import type { LedgerHeadDigest, LedgerVersion, PrincipalId } from '@mandate/core';
import { applyBatch } from './reducer.ts';
import { emptyLedgerState, type LedgerState } from './state.ts';
import { principalKey, type CommitResult, type CommittedBatch, type LedgerSnapshot, type LedgerStore } from './store.ts';

export type DelayPoint = 'READ' | 'COMMIT';
export type FaultPoint = 'BEFORE_CAS' | 'AFTER_VERSION_CHECK' | 'AFTER_VALIDATION' | 'BEFORE_PUBLISH';

export interface InMemoryStoreHooks {
  readonly delay?: (point: DelayPoint, principal: PrincipalId) => Promise<void>;
  readonly fault?: (point: FaultPoint, principal: PrincipalId) => void;
}

interface PrincipalLog {
  state: LedgerState;
  readonly batches: CommittedBatch[];
}

export interface StoreCounters {
  reads: number;
  commits: number;
  conflicts: number;
  refusals: number;
}

export class InMemoryLedgerStore implements LedgerStore {
  readonly #logs = new Map<string, PrincipalLog>();
  readonly #hooks: InMemoryStoreHooks;
  readonly counters: StoreCounters = { reads: 0, commits: 0, conflicts: 0, refusals: 0 };

  constructor(hooks: InMemoryStoreHooks = {}) {
    this.#hooks = hooks;
  }

  #log(principal: PrincipalId): PrincipalLog {
    const key = principalKey(principal);
    let log = this.#logs.get(key);
    if (log === undefined) {
      log = { state: emptyLedgerState(principal), batches: [] };
      this.#logs.set(key, log);
    }
    return log;
  }

  async read(principal: PrincipalId): Promise<LedgerSnapshot> {
    const state = this.#log(principal).state;
    this.counters.reads += 1;
    const snapshot: LedgerSnapshot = { principal, version: state.version, head: state.head, state };
    if (this.#hooks.delay !== undefined) await this.#hooks.delay('READ', principal);
    return snapshot;
  }

  async compareAndAppend(principal: PrincipalId, expectedVersion: LedgerVersion, expectedHead: LedgerHeadDigest, events: readonly LedgerEvent[]): Promise<CommitResult> {
    if (this.#hooks.delay !== undefined) await this.#hooks.delay('COMMIT', principal);
    // --- critical section: synchronous from here to the publish ---
    const fault = this.#hooks.fault;
    fault?.('BEFORE_CAS', principal);
    const log = this.#log(principal);
    const current = log.state;
    if (current.version !== expectedVersion || current.head !== expectedHead) {
      this.counters.conflicts += 1;
      return { status: 'CONFLICT', reason: current.version !== expectedVersion ? 'VERSION_CONFLICT' : 'HEAD_MISMATCH', version: current.version, head: current.head };
    }
    fault?.('AFTER_VERSION_CHECK', principal);
    const applied = applyBatch(current, events);
    if (!applied.ok) {
      this.counters.refusals += 1;
      return { status: 'REFUSED', refusal: applied.error };
    }
    fault?.('AFTER_VALIDATION', principal);
    const next = applied.value.state;
    const batch: CommittedBatch = { version: next.version, previousHead: current.head, head: next.head, events: [...events], encoded: applied.value.encoded };
    fault?.('BEFORE_PUBLISH', principal);
    // Publish: two synchronous assignments, with nothing that can fail or yield between them.
    log.batches.push(batch);
    log.state = next;
    this.counters.commits += 1;
    return { status: 'COMMITTED', snapshot: { principal, version: next.version, head: next.head, state: next } };
  }

  async history(principal: PrincipalId): Promise<readonly CommittedBatch[]> {
    return [...this.#log(principal).batches];
  }
}
