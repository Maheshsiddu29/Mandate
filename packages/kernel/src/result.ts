/**
 * Result values.
 *
 * The kernel does not throw to signal a domain outcome. A malformed mandate, an
 * unsupported version and an out-of-range amount are all *answers*, returned as
 * values, because an exception is something a caller can swallow and a value is
 * not (design section 10.1, property 2).
 *
 * Exceptions remain reserved for programmer error — a bug in this package —
 * where failing loudly is correct.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}
