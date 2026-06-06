/**
 * Health Checker — GET /v1/health
 */
import * as https from 'https';
import { resolveAuth, ensureFreshKiroToken, resolveApiRegionAsync, invalidateApiRegionCache } from '../auth/credential-discovery-ext';
import { RefreshTokenExpiredError } from '../auth/token-refresh';

const HEALTH_TIMEOUT_MS = 5000;

export async function checkHealth(): Promise<any> {
  const startTime = Date.now();
  const result: any = {
    status: 'healthy',
    credentials: { status: 'not_configured' },
    api_connectivity: { status: 'failed', error: 'Not checked' },
    model_available: { status: 'failed', error: 'Not checked' },
    timestamp: new Date().toISOString(),
  };

  let region = 'us-east-1';
  let isKiroMode = false;
  try {
    try { await ensureFreshKiroToken(); } catch (err: any) {
      if (err instanceof RefreshTokenExpiredError) {
        result.credentials = { status: 'failed', type: 'kiro', error: err.message };
        result.status = 'unhealthy'; result.timestamp = new Date().toISOString(); return result;
      }
    }
    const auth = resolveAuth();
    if (auth.mode === 'api_key') result.credentials = { status: 'ok', type: 'api_key' };
    else if (auth.mode === 'kiro') {
      isKiroMode = true;
      const expiresIn = auth.credentials.expiration.getTime() - Date.now();
      result.credentials = { status: 'ok', type: 'kiro', expires_in: `${Math.floor(expiresIn / 60000)}m` };
    }
  } catch {
    result.credentials = { status: 'failed', error: 'Unknown error' };
    result.status = 'unhealthy'; result.timestamp = new Date().toISOString(); return result;
  }

  try { region = await resolveApiRegionAsync(); } catch { region = 'us-east-1'; }
  result.api_region = region;

  const elapsed = Date.now() - startTime;
  const remainingMs = HEALTH_TIMEOUT_MS - elapsed;
  if (remainingMs <= 0) { result.status = 'unhealthy'; result.api_connectivity = { status: 'failed', error: 'Health check timed out' }; return result; }

  try {
    const connectStart = Date.now();
    await pingApi(`q.${region}.amazonaws.com`, remainingMs);
    result.api_connectivity = { status: 'ok', latency_ms: Date.now() - connectStart };
    result.model_available = { status: 'ok', model: 'claude-sonnet-4-20250514' };
  } catch (err: any) {
    if (isKiroMode) invalidateApiRegionCache();
    result.api_connectivity = { status: 'failed', error: err.message || 'Connection failed' };
    result.model_available = { status: 'failed', error: 'Cannot verify without connectivity' };
    result.status = 'degraded';
  }
  result.timestamp = new Date().toISOString();
  return result;
}

function pingApi(host: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, port: 443, path: '/generateAssistantResponse', method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, (res) => { res.resume(); resolve(); });
    req.on('error', (err) => reject(new Error(`API unreachable: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('API connection timed out')); });
    req.end('{}');
  });
}
