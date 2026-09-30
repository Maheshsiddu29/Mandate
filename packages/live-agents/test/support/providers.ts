/**
 * Test providers: every answer is scripted, every request is recorded.
 *
 * A handler returns the raw text a model would, after an optional real
 * delay; `ignoreAbort` makes it behave like a provider that does not stop
 * when asked, so late answers can be produced on purpose.
 */

import type { AgentModelProvider, CallOptions, DecisionRequest, DraftRequest, ModelRequest, ModelResponse, NegotiationRequest, RogueRequest } from '../../src/runtime/provider.ts';

export interface Scripted {
  readonly text: string | ((request: ModelRequest) => string);
  readonly delayMs?: number;
  readonly fail?: boolean;
  readonly ignoreAbort?: boolean;
  readonly firstChunkAfterMs?: number;
}

type Handler<R> = (request: R, call: number) => Scripted;

export interface ScriptedHandlers {
  readonly decide?: Handler<DecisionRequest>;
  readonly negotiate?: Handler<NegotiationRequest>;
  readonly interpret?: Handler<DraftRequest>;
  readonly attack?: Handler<RogueRequest>;
}

function delay(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

export class ScriptedProvider implements AgentModelProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-v1';
  readonly kind = 'SCRIPTED' as const;
  readonly requests: ModelRequest[] = [];
  readonly #h: ScriptedHandlers;
  #calls = 0;

  constructor(h: ScriptedHandlers) {
    this.#h = h;
  }

  async #run<R extends ModelRequest>(handler: Handler<R> | undefined, request: R, o: CallOptions): Promise<ModelResponse> {
    this.requests.push(request);
    const call = this.#calls++;
    if (handler === undefined) throw new Error(`no script for ${request.kind}`);
    const s = handler(request, call);
    const signal = s.ignoreAbort === true ? null : o.signal;
    if (s.firstChunkAfterMs !== undefined) {
      await delay(s.firstChunkAfterMs, signal);
      o.onFirstChunk();
    }
    await delay(Math.max(0, (s.delayMs ?? 0) - (s.firstChunkAfterMs ?? 0)), signal);
    if (s.fail === true) throw new Error('scripted failure');
    return { text: typeof s.text === 'function' ? s.text(request) : s.text };
  }

  decide(r: DecisionRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(this.#h.decide, r, o);
  }
  negotiate(r: NegotiationRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(this.#h.negotiate, r, o);
  }
  interpretMandateDraft(r: DraftRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(this.#h.interpret, r, o);
  }
  attack(r: RogueRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(this.#h.attack, r, o);
  }
}

export const json = (v: unknown): string => JSON.stringify(v);
