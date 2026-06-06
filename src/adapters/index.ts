/**
 * Adapter Factory — selects the right backend adapter based on auth context.
 */
import { AuthResult } from '../auth/types';
import { LLMBackendAdapter, buildModelsListResponse } from './adapter';
import { KiroAdapter, KiroAdapterOptions, KIRO_MODELS } from './kiro-adapter';
import { AnthropicPassthroughAdapter, PassthroughOptions, ANTHROPIC_FALLBACK_MODELS } from './anthropic-passthrough';

export { buildModelsListResponse, KIRO_MODELS, ANTHROPIC_FALLBACK_MODELS };
export { KiroAdapter } from './kiro-adapter';
export { AnthropicPassthroughAdapter } from './anthropic-passthrough';

export interface AdapterOptions {
  messages?: any[];
  buildBody?: (req: any) => any;
  onComplete?: (blocks: any[]) => void;
}

export function selectAdapter(auth: AuthResult, options: AdapterOptions = {}): LLMBackendAdapter {
  if (auth.mode === 'kiro') {
    return new KiroAdapter(auth, { messages: options.messages, onComplete: options.onComplete });
  }
  return new AnthropicPassthroughAdapter(auth.apiKey, { buildBody: options.buildBody, onComplete: options.onComplete });
}
