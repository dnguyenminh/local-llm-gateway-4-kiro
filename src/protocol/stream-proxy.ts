/**
 * Stream Proxy — SSE helpers and Anthropic passthrough streaming.
 * KG-3: Body accumulation uses Buffer.concat
 * KG-4: onComplete properly collects and assembles content blocks
 * KG-7: Debug logging for catch blocks
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
      // KG-3: Buffer.concat for error body
      const errChunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => { errChunks.push(chunk); });
      upstreamRes.on('end', () => { onError(new UpstreamError(statusCode, Buffer.concat(errChunks).toString('utf8'))); });
      return;
    }
    writeSSEHeaders(clientRes);
    // KG-4: Properly collect content blocks for onComplete
    const blockMap = new Map<number, any>();
    const partialJson = new Map<number, string>();
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
            if (parsed.type === 'content_block_start' && parsed.content_block) {
              const block: any = { type: parsed.content_block.type };
              if (parsed.content_block.type === 'text') block.text = '';
              else if (parsed.content_block.type === 'tool_use') { block.id = parsed.content_block.id; block.name = parsed.content_block.name; block.input = {}; }
              blockMap.set(parsed.index, block);
            } else if (parsed.type === 'content_block_delta' && parsed.delta) {
              const block = blockMap.get(parsed.index);
              if (block) {
                if (parsed.delta.type === 'text_delta' && parsed.delta.text) block.text = (block.text || '') + parsed.delta.text;
                else if (parsed.delta.type === 'input_json_delta' && parsed.delta.partial_json) partialJson.set(parsed.index, (partialJson.get(parsed.index) || '') + parsed.delta.partial_json);
              }
            }
          } catch (err: any) {
            // KG-7: Debug logging for parse errors in stream
            console.error('[kiro-gateway] stream-proxy SSE parse error:', err.message);
          }
        }
      }
    });
    upstreamRes.on('end', () => {
      if (buffer.trim().length > 0) clientRes.write(buffer + '\n\n');
      clientRes.end();
      // Assemble final blocks and fire onComplete
      const blocks: any[] = [];
      for (const [index, block] of blockMap) {
        if (block.type === 'tool_use') { const pj = partialJson.get(index); if (pj) try { block.input = JSON.parse(pj); } catch { block.input = {}; } }
        blocks.push(block);
      }
      onComplete(blocks);
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
      // KG-3: Buffer.concat for response body
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Upstream timeout')); });
    req.write(options.body);
    req.end();
  });
}
