/**
 * Kiro Adapter — SSO -> CodeWhisperer backend
 */
import * as https from 'https';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import { LLMBackendAdapter, AnthropicModel } from './adapter';
import { KiroAuthResult } from '../auth/types';
import { convertRequest, ConversionError } from '../protocol/kiro-converter';
import { EventStreamDecoder } from '../protocol/event-stream-parser';
import { KiroStreamConverter, SSEEvent } from '../protocol/kiro-stream';
import { formatSSEEvent, writeSSEHeaders } from '../protocol/stream-proxy';
import { resolveMachineId } from '../utils/machine-id';
import { KIRO_VERSION, NODE_VERSION } from '../utils/kiro-config';
import { fetchKiroModels } from '../models/kiro-models-client';
import { resolveApiRegionAsync } from '../auth/credential-discovery-ext';

export const KIRO_MODELS: AnthropicModel[] = [
  { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
  { type: 'model', id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  { type: 'model', id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
  { type: 'model', id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
  { type: 'model', id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
  { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
];

const KIRO_MODELS_CREATED_AT = '2025-01-01T00:00:00Z';

export interface KiroAdapterOptions {
  messages?: any[];
  onComplete?: (blocks: any[]) => void;
}

export function buildKiroHeaders(host: string, bearerToken: string, machineId: string): Record<string, string> {
  const sv = `${os.platform()}_${os.release()}`;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearerToken}`,
    'x-amzn-codewhisperer-optout': 'true',
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amz-user-agent': `aws-sdk-js/1.0.34 KiroIDE-${KIRO_VERSION}-${machineId}`,
    'user-agent': `aws-sdk-js/1.0.34 ua/2.1 os/${sv} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${machineId}`,
    host,
    'amz-sdk-invocation-id': crypto.randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  };
}

function sendError(res: http.ServerResponse, statusCode: number, errorType: string, message: string): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: errorType, message } }));
}

export class KiroAdapter implements LLMBackendAdapter {
  name = 'kiro';
  private auth: KiroAuthResult;
  private options: KiroAdapterOptions;

  constructor(auth: KiroAuthResult, options: KiroAdapterOptions = {}) {
    this.auth = auth;
    this.options = options;
  }

  async listModels(): Promise<AnthropicModel[]> {
    if (this.auth.bearerToken) {
      try {
        const region = await resolveApiRegionAsync();
        const machineId = resolveMachineId({ seed: this.auth.refreshToken || this.auth.bearerToken });
        const live = await fetchKiroModels(region, this.auth.bearerToken, machineId);
        if (live.length > 0) return live.map(m => ({ ...m, created_at: m.created_at ?? KIRO_MODELS_CREATED_AT }));
      } catch (err: any) {
        console.error('[kiro-gateway] ListAvailableModels failed, falling back to static:', err.message);
      }
    }
    return KIRO_MODELS.map(m => ({ ...m, created_at: KIRO_MODELS_CREATED_AT }));
  }

  async createMessage(request: any, res: http.ServerResponse, stream: boolean): Promise<void> {
    const region = await resolveApiRegionAsync();
    const host = `q.${region}.amazonaws.com`;
    const requestForConversion = { ...request, messages: this.options.messages ?? request.messages };
    let conversionResult;
    try { conversionResult = convertRequest(requestForConversion); }
    catch (err: any) {
      if (err instanceof ConversionError) sendError(res, 400, 'invalid_request_error', err.message);
      else sendError(res, 500, 'api_error', 'Failed to build upstream request');
      return;
    }
    const bodyObj: any = { conversationState: conversionResult.conversationState };
    if (this.auth.profileArn) bodyObj.profileArn = this.auth.profileArn;
    const bodyStr = JSON.stringify(bodyObj);
    const machineId = resolveMachineId({ seed: this.auth.refreshToken || this.auth.bearerToken });
    const headers = buildKiroHeaders(host, this.auth.bearerToken, machineId);
    this.proxyKiroStream({ targetUrl: `https://${host}/generateAssistantResponse`, headers, body: bodyStr }, res, request.model, stream);
  }

  private proxyKiroStream(options: { targetUrl: string; headers: Record<string, string>; body: string }, clientRes: http.ServerResponse, model: string, stream: boolean): void {
    const parsedUrl = new URL(options.targetUrl);
    const decoder = new EventStreamDecoder();
    const converter = new KiroStreamConverter(model);
    const allEvents: SSEEvent[] = [];
    let started = false, streamHeadersWritten = false;

    const writeSse = (events: SSEEvent[]) => {
      if (events.length === 0) return;
      allEvents.push(...events);
      if (stream) {
        if (!streamHeadersWritten) { writeSSEHeaders(clientRes); streamHeadersWritten = true; }
        for (const ev of events) clientRes.write(formatSSEEvent(ev.event, ev.data));
      }
    };

    const upstreamReq = https.request({
      hostname: parsedUrl.hostname, port: 443,
      path: parsedUrl.pathname + parsedUrl.search, method: 'POST',
      headers: { ...options.headers, 'Content-Length': String(Buffer.byteLength(options.body)) },
    }, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 500;
      if (statusCode >= 400) {
        let errBody = '';
        upstreamRes.on('data', (c: Buffer) => { errBody += c.toString(); });
        upstreamRes.on('end', () => {
          if (!clientRes.headersSent) sendError(clientRes, statusCode, 'api_error', `Kiro API error ${statusCode}: ${errBody.substring(0, 500)}`);
          else { clientRes.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: `Kiro API error ${statusCode}` } })); clientRes.end(); }
        });
        return;
      }
      if (!started) { writeSse(converter.start()); started = true; }
      upstreamRes.on('data', (chunk: Buffer) => { decoder.feed(chunk); for (const frame of decoder.decodeAll()) writeSse(converter.processFrame(frame)); });
      upstreamRes.on('end', () => {
        for (const frame of decoder.decodeAll()) writeSse(converter.processFrame(frame));
        writeSse(converter.finish());
        const blocks = collectBlocksFromSse(allEvents);
        if (blocks.length > 0) this.options.onComplete?.(blocks);
        if (stream) clientRes.end();
        else { clientRes.writeHead(200, { 'Content-Type': 'application/json' }); clientRes.end(JSON.stringify(buildMessageFromSse(allEvents, model))); }
      });
      upstreamRes.on('error', (err: Error) => {
        if (!clientRes.headersSent) sendError(clientRes, 502, 'api_error', 'Kiro stream error: ' + err.message);
        else { clientRes.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Kiro stream dropped' } })); clientRes.end(); }
      });
    });

    clientRes.on('close', () => { upstreamReq.destroy(); });
    upstreamReq.on('error', (err: Error) => { if (!clientRes.headersSent) sendError(clientRes, 502, 'api_error', 'Failed to connect to Kiro AI service: ' + err.message); });
    upstreamReq.setTimeout(120000, () => { upstreamReq.destroy(); if (!clientRes.headersSent) sendError(clientRes, 504, 'api_error', 'Kiro upstream timeout'); });
    upstreamReq.write(options.body);
    upstreamReq.end();
  }
}

function collectBlocksFromSse(events: SSEEvent[]): any[] {
  const blockMap = new Map<number, any>();
  const partialJson = new Map<number, string>();
  for (const ev of events) {
    const data = ev.data as any;
    if (ev.event === 'content_block_start' && data.content_block) {
      const block: any = { type: data.content_block.type };
      if (data.content_block.type === 'tool_use') { block.id = data.content_block.id; block.name = data.content_block.name; block.input = {}; }
      else if (data.content_block.type === 'text') block.text = '';
      blockMap.set(data.index, block);
    } else if (ev.event === 'content_block_delta' && data.delta) {
      const block = blockMap.get(data.index);
      if (block) {
        if (data.delta.type === 'text_delta' && data.delta.text) block.text = (block.text || '') + data.delta.text;
        else if (data.delta.type === 'input_json_delta' && data.delta.partial_json) partialJson.set(data.index, (partialJson.get(data.index) || '') + data.delta.partial_json);
      }
    }
  }
  const blocks: any[] = [];
  for (const [index, block] of blockMap) {
    if (block.type === 'tool_use') { const pj = partialJson.get(index); if (pj) try { block.input = JSON.parse(pj); } catch { block.input = {}; } }
    blocks.push(block);
  }
  return blocks;
}

function buildMessageFromSse(events: SSEEvent[], model: string) {
  const content = collectBlocksFromSse(events);
  let stopReason = 'end_turn', outputTokens = 0;
  for (const ev of events) { if (ev.event === 'message_delta') { const d = ev.data as any; if (d.delta?.stop_reason) stopReason = d.delta.stop_reason; if (d.usage?.output_tokens) outputTokens = d.usage.output_tokens; } }
  return { id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: outputTokens } };
}
