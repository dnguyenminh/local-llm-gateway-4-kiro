/**
 * HTTP Server + Request Router
 */
import * as http from 'http';
import { GatewayConfig } from './config';
import { handleModelsRoute } from './models/models-handler';
import { checkHealth } from './health/health-checker';
import { handleChatRoute } from './chat-handler';
import { getGatewayApiKey } from './auth/gateway-key';
import { resolveAuth, ensureFreshKiroToken, buildKiroAuthResult } from './auth/credential-discovery-ext';
import { RefreshTokenExpiredError } from './auth/token-refresh';

export function createServer(config: GatewayConfig): http.Server {
  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Add CORS headers to all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

    let pathOnly = (req.url || '').split('?')[0];
    // Strip /anthropic prefix for routing
    let routePath = pathOnly;
    if (routePath.startsWith('/anthropic/')) routePath = routePath.slice('/anthropic'.length);
    else if (routePath === '/anthropic') routePath = '/';

    // Health check
    if (req.method === 'GET' && (routePath === '/v1/health' || pathOnly === '/v1/health')) {
      void handleHealthRoute(res);
      return;
    }

    // Gateway key endpoint
    if (req.method === 'GET' && (routePath === '/v1/gateway-key' || pathOnly === '/v1/gateway-key')) {
      const key = getGatewayApiKey();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ gateway_key: key }));
      return;
    }

    // Models
    if (handleModelsRoute(req, res)) return;

    // Chat/Messages
    if (handleChatRoute(req, res)) return;

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `Route not found: ${req.method} ${req.url}` } }));
  });

  return server;
}

async function handleHealthRoute(res: http.ServerResponse): Promise<void> {
  try {
    const health = await checkHealth();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'unhealthy', error: err.message }));
  }
}
