/** 0x-prefixed hex ↔ bytes, for digests of public data (calldata) only. */

export function hexBytes(h: string): Uint8Array {
  const body = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}
