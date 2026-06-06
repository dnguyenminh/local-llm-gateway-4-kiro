/**
 * Chat Handler — POST /v1/messages
 */
import * as http from 'http';
import { validateRequest } from './utils/request-validator';
import { resolveAuth, ensureFreshKiroToken, buildKiroAuthResult } from './auth/credential-discovery-ext';
import { RefreshTokenExpiredError } from './auth/token-refresh';
import { selectAdapter } from './adapters/index';

const MAX_BODY_SIZE = 4 * 1024 * 1024;

// Simple in-memory conversation store
class ConversationStore {
  private sessions = new Map<string, { messages: any[]; toolUseIndex: Map<string, any> }>();
  getOrCreate(id: string) {
    if (!this.sessions.has(id)) this.sessions.set(id, { messages: [], toolUseIndex: new Map() });
    return this.sessions.get(id)!;
  }
}

const conversationStore = new ConversationStore();

export function handleChatRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'POST') return false;
  let url = req.url || '';
  if (url.startsWith('/anthropic/')) url = url.slice('/anthropic'.length);
  else if (url === '/anthropic') url = '/v1/messages';
  if (url !== '/v1/messages' && url !== '/api/chat/completions') return false;

  const apiKeyHeader = (req.headers['x-api-key'] as string) || '';
  let bodySize = 0, body = '';
  req.on('data', (chunk: Buffer) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) { sendError(res, 413, 'invalid_request_error', 'Request body too large (max 4MB)'); req.destroy(); return; }
    body += chunk.toString();
  });
  req.on('end', async () => {
    if (bodySize > MAX_BODY_SIZE) return;
    try {
      const data = JSON.parse(body);
      await processRequest(data, apiKeyHeader, res);
    } catch (err: any) {
      if (err instanceof SyntaxError) sendError(res, 400, 'invalid_request_error', `Invalid JSON: ${err.message}`);
      else sendError(res, 500, 'api_error', 'Internal server error');
    }
  });
  return true;
}

async function processRequest(data: any, apiKeyHeader: string, res: http.ServerResponse): Promise<void> {
  const validation = validateRequest(data);
  if (!validation.valid && validation.error) {
    sendError(res, 400, validation.error.error.type, validation.error.error.message); return;
  }
  const request = data;
  const sessionId = request.sessionId || 'default';
  const stream = request.stream !== false;
  const session = conversationStore.getOrCreate(sessionId);

  // Handle tool result continuation
  if (request.toolResult) {
    session.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: request.toolResult.toolUseId, content: request.toolResult.content, is_error: request.toolResult.isError ?? false }] });
  }

  // Add user message
  if (request.messages && request.messages.length > 0) {
    const lastMsg = request.messages[request.messages.length - 1];
    if (lastMsg.role === 'user') session.messages.push(lastMsg);
  }

  // Resolve auth
  let auth = resolveAuth(apiKeyHeader);
  if (auth.mode === 'kiro') {
    try {
      const fresh = await ensureFreshKiroToken();
      if (fresh) auth = buildKiroAuthResult(fresh);
    } catch (err: any) {
      if (err instanceof RefreshTokenExpiredError) { sendError(res, 401, 'authentication_error', err.message); return; }
      console.error('[kiro-gateway] Token refresh failed:', err.message);
    }
  }

  const adapter = selectAdapter(auth, {
    messages: session.messages,
    buildBody: (req: any) => {
      const body: any = { model: req.model, max_tokens: req.max_tokens, messages: session.messages, stream: req.stream !== false };
      if (req.system) body.system = req.system;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools?.length > 0) body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;
      if (req.stop_sequences?.length > 0) body.stop_sequences = req.stop_sequences;
      if (req.metadata) body.metadata = req.metadata;
      return body;
    },
    onComplete: (blocks: any[]) => {
      if (blocks.length > 0) session.messages.push({ role: 'assistant', content: blocks });
    },
  });
  await adapter.createMessage(request, res, stream);
}

function sendError(res: http.ServerResponse, statusCode: number, errorType: string, message: string): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: errorType, message } }));
}
