/**
 * Size-bounded response reading.
 *
 * `await response.json()` buffers whatever arrives. A fetch deadline bounds a
 * *slow* body but not a fast large one, so a broken or hostile endpoint could
 * deliver gigabytes inside the timeout and the process would hold all of it.
 * Every other externally sized value in this repository has a deliberate bound;
 * the architecture pressure test found response bodies were the exception
 * (finding F-11).
 *
 * The body is read incrementally and abandoned as soon as the limit is passed,
 * so the peak allocation is bounded by the limit rather than by what the server
 * chose to send. The reader is always cancelled, which closes the underlying
 * connection rather than leaving it draining.
 */

export const BodyReadError = {
  TOO_LARGE: 'TOO_LARGE',
  UNREADABLE: 'UNREADABLE',
  NOT_JSON: 'NOT_JSON',
} as const;
export type BodyReadError = (typeof BodyReadError)[keyof typeof BodyReadError];

export type BodyResult =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | { readonly ok: false; readonly error: BodyReadError; readonly bytes: number };

/**
 * Read at most `limitBytes` and parse the result as JSON.
 *
 * A declared `content-length` past the limit is refused before a byte is read.
 * That is an optimization and not the control: a server may omit or understate
 * it, so the incremental count is what actually enforces the bound.
 */
export async function readJsonBounded(response: Response, limitBytes: number): Promise<BodyResult> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limitBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancelling a body that is already closed is not a failure.
    }
    return { ok: false, error: BodyReadError.TOO_LARGE, bytes: declared };
  }

  const body = response.body;
  if (body === null) {
    // No stream to read incrementally. `text()` is bounded by the fact that
    // there is no body, so this is the empty case rather than an unbounded one.
    const text = await response.text().catch(() => undefined);
    if (text === undefined) return { ok: false, error: BodyReadError.UNREADABLE, bytes: 0 };
    return parse(text, text.length);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        // Stop reading immediately; do not accumulate the rest.
        return { ok: false, error: BodyReadError.TOO_LARGE, bytes: total };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: BodyReadError.UNREADABLE, bytes: total };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    return { ok: false, error: BodyReadError.NOT_JSON, bytes: total };
  }
  return parse(text, total);
}

function parse(text: string, bytes: number): BodyResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, bytes };
  } catch {
    return { ok: false, error: BodyReadError.NOT_JSON, bytes };
  }
}
