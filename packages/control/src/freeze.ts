/**
 * Inputs handed to a domain module are deep-frozen copies (brief §47): a
 * module that tries to mutate what it was given throws — in strict-mode
 * modules, assigning to a frozen property is a `TypeError` — and the engine
 * refuses it as a module fault. The caller's own objects are never frozen or
 * shared with a module; byte payloads, which cannot be frozen, are copied and
 * compared after the call.
 */

function isObject(x: object | bigint | string | number | boolean | null | undefined): x is object {
  return typeof x === 'object' && x !== null;
}

/** Freeze `x` and everything reachable from it, except typed arrays (which cannot be frozen). */
export function deepFreeze<T extends object>(x: T): T {
  if (ArrayBuffer.isView(x) || Object.isFrozen(x)) return x;
  Object.freeze(x);
  for (const value of Object.values(x) as (object | bigint | string | number | boolean | null | undefined)[]) {
    if (isObject(value)) deepFreeze(value);
  }
  return x;
}

/** A structural copy (bigints and byte arrays included), deep-frozen. */
export function frozenCopy<T extends object>(x: T): T {
  return deepFreeze(structuredClone(x));
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
