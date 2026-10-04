/**
 * The OpenAI Responses API provider. **Server-side only.**
 *
 * `POST /v1/responses` with strict structured output
 * (`text.format = { type: "json_schema", strict: true, schema }`), streamed
 * so the first chunk can be timed, `store: false`, and the caller's abort
 * signal wired to the request. This module is the package's only network
 * client; it never runs in a browser, and the API key lives in a private
 * field that is never logged, serialized or put in an error: a failure is
 * reported by status and code only.
 *
 * The model's text is returned raw. Whether it is a valid decision is the
 * runtime's question (schemas.ts), never this module's.
 */

import { ProviderError } from './errors.ts';
import { instructionsFor, inputFor } from './prompts.ts';
import type { AgentModelProvider, CallOptions, DecisionRequest, DraftRequest, ModelRequest, ModelResponse, NegotiationRequest, PolicyStressRequest, OpportunityRequest } from './provider.ts';
import { schemaFor } from './schemas.ts';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** Used when `OPENAI_MODEL` is unset. A deployment choice, never a protocol one. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

/**
 * Bounded output budgets by request kind. DRAFT needs room for the nested
 * mandate schema; smaller decision/negotiation/policy answers stay tighter.
 * An explicit constructor `maxOutputTokens` still overrides every kind.
 */
export const OUTPUT_TOKEN_BUDGET: Readonly<Record<ModelRequest['kind'], number>> = {
  DRAFT: 4_000,
  OPPORTUNITY: 2_400,
  NEGOTIATION: 2_000,
  DECISION: 1_600,
  POLICY_STRESS: 1_200,
};

export type FetchLike = (url: string, init: { method: string; headers: { readonly [k: string]: string }; body: string; signal: AbortSignal }) => Promise<Response>;

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly url?: string;
  /** When set, overrides the per-kind budget for every request. */
  readonly maxOutputTokens?: number;
  /** For tests: a stand-in for the network. */
  readonly fetch?: FetchLike;
}

interface StreamEvent {
  readonly type?: unknown;
  readonly delta?: unknown;
  readonly text?: unknown;
  readonly response?: { readonly error?: { readonly code?: unknown } | null; readonly incomplete_details?: { readonly reason?: unknown } | null };
  readonly code?: unknown;
}

const MAX_STREAM_BYTES = 256_000;

export function outputTokenBudget(kind: ModelRequest['kind'], override?: number): number {
  return override ?? OUTPUT_TOKEN_BUDGET[kind];
}

export class OpenAIProvider implements AgentModelProvider {
  readonly name = 'openai';
  readonly kind = 'LIVE' as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #url: string;
  readonly #maxOutputTokens: number | undefined;
  readonly #fetch: FetchLike;

  constructor(o: OpenAIProviderOptions) {
    if (o.apiKey.trim() === '') throw new ProviderError('NOT_CONFIGURED', 'OPENAI_API_KEY is not set');
    this.model = o.model;
    this.#apiKey = o.apiKey;
    this.#url = o.url ?? OPENAI_RESPONSES_URL;
    this.#maxOutputTokens = o.maxOutputTokens;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The request body for `r`. Exposed so tests can check exactly what would leave the process. */
  body(r: ModelRequest): string {
    const { name, schema } = schemaFor(r);
    return JSON.stringify({
      model: this.model,
      instructions: instructionsFor(r),
      input: inputFor(r),
      text: { format: { type: 'json_schema', name, schema, strict: true } },
      stream: true,
      store: false,
      max_output_tokens: outputTokenBudget(r.kind, this.#maxOutputTokens),
    });
  }

  async #complete(r: ModelRequest, o: CallOptions): Promise<ModelResponse> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: this.body(r),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal.aborted) throw e;
      throw new ProviderError('NETWORK', 'the request did not reach the provider');
    }
    if (!res.ok) {
      // The body may echo request details; only the status and the error code leave this function.
      let code = '';
      try {
        const j = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
        const c = j.error?.code ?? j.error?.type;
        if (typeof c === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(c)) code = ` (${c})`;
      } catch {
        // No readable error body.
      }
      throw new ProviderError('HTTP', `the provider answered ${res.status}${code}`, res.status);
    }
    if (res.body === null) throw new ProviderError('MALFORMED_STREAM', 'no response body');
    return { text: await this.#read(res.body, o) };
  }

  async #read(body: ReadableStream<Uint8Array>, o: CallOptions): Promise<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    let bytes = 0;
    let text = '';
    let done: string | null = null;
    let refusal = false;
    const handle = (e: StreamEvent) => {
      switch (e.type) {
        case 'response.output_text.delta':
          if (typeof e.delta === 'string') {
            if (text === '') o.onFirstChunk();
            text += e.delta;
          }
          break;
        case 'response.output_text.done':
          if (typeof e.text === 'string') done = e.text;
          break;
        case 'response.refusal.delta':
        case 'response.refusal.done':
          refusal = true;
          break;
        case 'response.incomplete': {
          const reason = e.response?.incomplete_details?.reason;
          throw new ProviderError('INCOMPLETE', `the response was incomplete${typeof reason === 'string' ? ` (${reason.slice(0, 40)})` : ''}`);
        }
        case 'response.failed': {
          const code = e.response?.error?.code;
          throw new ProviderError('HTTP', `the response failed${typeof code === 'string' ? ` (${code.slice(0, 40)})` : ''}`);
        }
        case 'error':
          throw new ProviderError('HTTP', `the stream reported an error${typeof e.code === 'string' ? ` (${e.code.slice(0, 40)})` : ''}`);
      }
    };
    const reader = body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new ProviderError('MALFORMED_STREAM', 'the stream exceeded its size bound');
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data !== '' && data !== '[DONE]') {
          let event: StreamEvent;
          try {
            event = JSON.parse(data) as StreamEvent;
          } catch {
            throw new ProviderError('MALFORMED_STREAM', 'an event was not JSON');
          }
          handle(event);
        }
        cut = buffer.indexOf('\n\n');
      }
    }
    if (refusal) throw new ProviderError('REFUSAL', 'the model refused');
    return done ?? text;
  }

  decide(r: DecisionRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#complete(r, o);
  }
  negotiate(r: NegotiationRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#complete(r, o);
  }
  interpretMandateDraft(r: DraftRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#complete(r, o);
  }
  selectPolicyCase(r: PolicyStressRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#complete(r, o);
  }

  assessOpportunity(r: OpportunityRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#complete(r, o);
  }

  toJSON(): { readonly name: string; readonly model: string } {
    return { name: this.name, model: this.model };
  }
}
