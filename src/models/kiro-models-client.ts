/**
 * Kiro Models Client — fetches real model list from CodeWhisperer backend.
 */
import * as https from 'https';
import { AnthropicModel } from '../adapters/adapter';
import { buildKiroHeaders } from '../adapters/kiro-adapter';

const LIST_MODELS_TARGET = 'AmazonCodeWhispererService.ListAvailableModels';
const LIST_MODELS_TIMEOUT_MS = 8000;

export function fetchKiroModels(region: string, bearerToken: string, machineId: string): Promise<AnthropicModel[]> {
  return new Promise((resolve, reject) => {
    const host = `q.${region}.amazonaws.com`;
    const headers: Record<string, string> = {
      ...buildKiroHeaders(host, bearerToken, machineId),
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': LIST_MODELS_TARGET,
    };
    const body = JSON.stringify({ origin: 'AI_EDITOR' });
    const req = https.request({
      hostname: host, port: 443, path: '/', method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    }, (resp) => {
      let raw = '';
      resp.on('data', (c: Buffer) => { raw += c.toString(); });
      resp.on('end', () => {
        if ((resp.statusCode || 500) >= 400) { reject(new Error(`ListAvailableModels HTTP ${resp.statusCode}`)); return; }
        try {
          const parsed = JSON.parse(raw);
          const models = mapKiroApiModels(parsed);
          if (models.length === 0) { reject(new Error('ListAvailableModels returned no models')); return; }
          resolve(models);
        } catch { reject(new Error('Failed to parse ListAvailableModels response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(LIST_MODELS_TIMEOUT_MS, () => { req.destroy(); reject(new Error('ListAvailableModels timeout')); });
    req.write(body);
    req.end();
  });
}

export function mapKiroApiModels(payload: any): AnthropicModel[] {
  const list = Array.isArray(payload?.models) ? payload.models : [];
  const out: AnthropicModel[] = [];
  for (const m of list) {
    const id = typeof m?.modelId === 'string' ? m.modelId.trim() : '';
    if (!id) continue;
    const entry: AnthropicModel = { type: 'model', id, display_name: (typeof m?.modelName === 'string' && m.modelName.trim()) || id };
    if (typeof m?.description === 'string' && m.description.trim()) entry.description = m.description.trim();
    if (typeof m?.rateMultiplier === 'number') entry.rate_multiplier = m.rateMultiplier;
    out.push(entry);
  }
  return out;
}
