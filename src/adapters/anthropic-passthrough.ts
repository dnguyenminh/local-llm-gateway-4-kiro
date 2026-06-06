/**
 * Anthropic Passthrough Adapter — bring-your-own-key fallback
 */
import * as https from 'https';
import * as http from 'http';
import { LLMBackendAdapter, AnthropicModel } from './adapter';
import { proxyStream, proxyNonStreaming, UpstreamError } from '../protocol/stream-proxy';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export const ANTHROPIC_FALLBACK_MODELS: AnthropicModel[] = [
  { type: 'model', id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z' },
  { type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
  { type: 'model', id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-14T00:00:00Z' },
  { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
  { type: 'model', id: 'claude-3-5-sonnet-20241022', display_name: 'Claude Sonnet 3.5', created_at: '2024-10-22T00:00:00Z' },
];

export interface PassthroughOptions {
  buildBody?: (req: any) => any;
  onComplete?: (blocks: any[]) => void;
}

function sendError(res: http.ServerResponse, statusCode: number, errorType: string, message: string): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: errorType, message } }));
}

export class AnthropicPassthroughAdapter implements LLMBackendAdapter {
  name = 'anthropic-passthrough';
  private apiKey: string;
  private options: PassthroughOptions;

  constructor(apiKey: string, options: PassthroughOptions = {}) {
    this.apiKey = apiKey;
    this.options = options;
  }

  async listModels(): Promise<AnthropicModel[]> {
    if (!this.apiKey || this.apiKey === 'local-trusted') return ANTHROPIC_FALLBACK_MODELS;
    try {
      const models = await fetchAnthropicModels(this.apiKey);
      return models.length > 0 ? models : ANTHROPIC_FALLBACK_MODELS;
    } catch { return ANTHROPIC_FALLBACK_MODELS; }
  }

  async createMessage(request: any, res: http.ServerResponse, stream: boolean): Promise<void> {
    const upstreamBody = this.options.buildBody ? this.options.buildBody(request) : defaultBuildBody(request);
    const targetUrl = `${ANTHROPIC_API_BASE}/v1/messages`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': this.apiKey || '', 'anthropic-version': ANTHROPIC_VERSION };
    const bodyStr = JSON.stringify(upstreamBody);
    if (stream) {
      proxyStream({ targetUrl, headers, body: bodyStr }, res,
        () => {},
        (err) => { if (!res.headersSent) sendError(res, err instanceof UpstreamError ? err.statusCode : 502, 'api_error', err.message || 'Failed to connect to AI service'); });
    } else {
      try {
        const upstream = await proxyNonStreaming({ targetUrl, headers, body: bodyStr });
        if (upstream.status >= 400) { res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(upstream.body); return; }
        const response = JSON.parse(upstream.body);
        if (response.content) this.options.onComplete?.(response.content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstream.body);
      } catch (err: any) { sendError(res, 502, 'api_error', err.message || 'Failed to connect to AI service'); }
    }
  }
}

function defaultBuildBody(request: any): any {
  const body: any = { model: request.model, max_tokens: request.max_tokens, messages: request.messages, stream: request.stream !== false };
  if (request.system) body.system = request.system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;
  if (request.stop_sequences && request.stop_sequences.length > 0) body.stop_sequences = request.stop_sequences;
  if (request.metadata) body.metadata = request.metadata;
  return body;
}

export function fetchAnthropicModels(apiKey: string): Promise<AnthropicModel[]> {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.anthropic.com', port: 443, path: '/v1/models?limit=100', method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION } }, (resp) => {
      let body = '';
      resp.on('data', (c: Buffer) => { body += c.toString(); });
      resp.on('end', () => {
        if ((resp.statusCode || 500) >= 400) { reject(new Error(`Anthropic models API error ${resp.statusCode}`)); return; }
        try { const p = JSON.parse(body); resolve((Array.isArray(p.data) ? p.data : []).map((m: any) => ({ type: 'model', id: m.id, display_name: m.display_name || m.id, created_at: m.created_at }))); }
        catch { reject(new Error('Failed to parse Anthropic models response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
