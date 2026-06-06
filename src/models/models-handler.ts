/**
 * Models Handler — GET /v1/models
 */
import * as http from 'http';
import { resolveAuth, ensureFreshKiroToken, buildKiroAuthResult } from '../auth/credential-discovery-ext';
import { selectAdapter, buildModelsListResponse } from '../adapters/index';
import { RefreshTokenExpiredError } from '../auth/token-refresh';

export function handleModelsRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  let pathOnly = (req.url || '').split('?')[0];
  if (pathOnly.startsWith('/anthropic/')) pathOnly = pathOnly.slice('/anthropic'.length);
  else if (pathOnly === '/anthropic') pathOnly = '/v1/models';
  if (pathOnly !== '/v1/models') return false;
  const apiKeyHeader = (req.headers['x-api-key'] as string) || '';
  void listModelsResponse(apiKeyHeader, res);
  return true;
}

async function listModelsResponse(apiKeyHeader: string, res: http.ServerResponse): Promise<void> {
  let auth = resolveAuth(apiKeyHeader);
  if (auth.mode === 'kiro') {
    try {
      const fresh = await ensureFreshKiroToken();
      if (fresh) auth = buildKiroAuthResult(fresh);
    } catch (err: any) {
      if (!(err instanceof RefreshTokenExpiredError)) console.error('[kiro-gateway] models token refresh failed:', err.message);
    }
  }
  try {
    const adapter = selectAdapter(auth);
    const models = await adapter.listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildModelsListResponse(models)));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err?.message || 'Failed to list models' } }));
  }
}
