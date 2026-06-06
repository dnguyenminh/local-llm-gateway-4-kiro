/**
 * Stream Proxy — SSE helpers and Anthropic passthrough streaming.
 */
import * as http from 'http';
import * as https from 'https';

export function formatSSEEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function writeSSEHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

export interface ProxyOptions {
  targetUrl: string;
  headers: Record<string, string>;
  body: string;
}

export class UpstreamError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message); this.name = 'UpstreamError'; this.statusCode = statusCode;
  }
}

export function proxyStream(
  options: ProxyOptions,
  clientRes: http.ServerResponse,
  onComplete: (blocks: unknown[]) => void,
  onError: (err: Error) => void,
): void {
  const parsedUrl = new URL(options.targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const reqOptions: https.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: { ...options.headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(options.body)) },
  };

  const upstreamReq = transport.request(reqOptions, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode || 500;
    if (statusCode >= 400) {
      let errBody = '';
      upstreamRes.on('data', (chunk: Buffer) => { errBody += chunk; });
      upstreamRes.on('end', () => { onError(new UpstreamError(statusCode, errBody)); });
      return;
    }
    writeSSEHeaders(clientRes);
    const contentBlocks: unknown[] = [];
    let buffer = '';
    upstreamRes.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (part.trim().length === 0) continue;
        clientRes.write(part + '\n\n');
        const dataLine = part.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.substring(6));
            if (parsed.type === 'content_block_start' || parsed.type === 'content_block_delta') contentBlocks.push(parsed);
          } catch { /* ignore */ }
        }
      }
    });
    upstreamRes.on('end', () => {
      if (buffer.trim().length > 0) clientRes.write(buffer + '\n\n');
      clientRes.end();
      onComplete(contentBlocks);
    });
    upstreamRes.on('error', (err: Error) => {
      clientRes.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Upstream connection dropped' } }));
      clientRes.end();
      onError(err);
    });
  });

  clientRes.on('close', () => { upstreamReq.destroy(); });
  upstreamReq.on('error', (err: Error) => { onError(new UpstreamError(502, err.message)); });
  upstreamReq.setTimeout(120000, () => { upstreamReq.destroy(); onError(new UpstreamError(504, 'Upstream timeout')); });
  upstreamReq.write(options.body);
  upstreamReq.end();
}

export async function proxyNonStreaming(options: ProxyOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(options.targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(options.body)) },
    };
    const req = transport.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 500, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Upstream timeout')); });
    req.write(options.body);
    req.end();
  });
}
