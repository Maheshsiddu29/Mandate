/**
 * The provider a restored session reports: the name, kind and model the
 * session was started with, read from its durable record. It calls no model
 * — a restored session is evidence, and runs no agents — so every call
 * refuses.
 */

import { ProviderError } from './errors.ts';
import type { AgentModelProvider, ModelResponse, ProviderKind } from './provider.ts';

const KINDS: readonly ProviderKind[] = ['LIVE', 'STUB', 'SCRIPTED'];

export class RecordedProvider implements AgentModelProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly model: string;

  constructor(recorded: { readonly name: string; readonly kind: string; readonly model: string }) {
    this.name = recorded.name;
    this.kind = (KINDS as readonly string[]).includes(recorded.kind) ? (recorded.kind as ProviderKind) : 'STUB';
    this.model = recorded.model;
  }

  #refuse(): Promise<ModelResponse> {
    return Promise.reject(new ProviderError('NOT_CONFIGURED', 'a restored session calls no model'));
  }

  decide(): Promise<ModelResponse> {
    return this.#refuse();
  }

  negotiate(): Promise<ModelResponse> {
    return this.#refuse();
  }

  interpretMandateDraft(): Promise<ModelResponse> {
    return this.#refuse();
  }

  selectPolicyCase(): Promise<ModelResponse> {
    return this.#refuse();
  }

  assessOpportunity(): Promise<ModelResponse> {
    return this.#refuse();
  }
}
