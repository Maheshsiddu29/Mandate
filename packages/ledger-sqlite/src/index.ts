/**
 * @mandate/ledger-sqlite — **REFERENCE / SINGLE-NODE TESTNET STORE** (Phase 7E.1).
 *
 * A durable implementation of the ledger store contract on SQLite, and the
 * issuance journal an enforcement adapter keeps in the same database. It is
 * the reference that makes `ADMIT_ATTEMPT` survive a crash on one machine; it
 * is not a replicated or horizontally scalable production store.
 *
 * Dependencies: `@mandate/ledger`, `@mandate/core` and Node's built-in
 * `node:sqlite`; the file-system access is SQLite's own, confined here. The
 * ledger package itself stays free of I/O.
 */

export * from './store.ts';
export * from './journal.ts';
