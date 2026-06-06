/**
 * Kiro Converter
 * Converts Anthropic Messages API request into CodeWhisperer conversationState.
 */
import * as crypto from 'crypto';

const ORIGIN = 'AI_EDITOR';
const AGENT_TASK_TYPE = 'vibe';
const CHAT_TRIGGER_TYPE = 'MANUAL';
const TOOL_NAME_MAX_LEN = 63;

const NATIVE_KIRO_MODEL_IDS = new Set([
  'auto', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5',
  'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4', 'claude-haiku-4.5',
  'deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1', 'glm-5', 'qwen3-coder-next',
]);

export function mapModel(model: string): string | null {
  const m = model.toLowerCase();
  if (NATIVE_KIRO_MODEL_IDS.has(m)) return m;
  if (m.includes('sonnet')) {
    if (m.includes('4-6') || m.includes('4.6')) return 'claude-sonnet-4.6';
    if (m.includes('4-5') || m.includes('4.5')) return 'claude-sonnet-4.5';
    return 'claude-sonnet-4.5';
  }
  if (m.includes('opus')) {
    if (m.includes('4-5') || m.includes('4.5')) return 'claude-opus-4.5';
    if (m.includes('4-6') || m.includes('4.6')) return 'claude-opus-4.6';
    if (m.includes('4-7') || m.includes('4.7')) return 'claude-opus-4.7';
    if (m.includes('4-8') || m.includes('4.8')) return 'claude-opus-4.8';
    return 'claude-opus-4.5';
  }
  if (m.includes('haiku')) return 'claude-haiku-4.5';
  if (/^(deepseek|minimax|glm|qwen|kimi|grok|gpt|llama)[-.\w]*$/.test(m)) return m;
  return null;
}

export class ConversionError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversionError'; }
}

function normalizeContent(content: any): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function getImageFormat(mediaType: string): string | null {
  switch (mediaType) {
    case 'image/jpeg': return 'jpeg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return null;
  }
}

function extractToolResultContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((item: any) => item && typeof item === 'object' && typeof item.text === 'string')
      .map((item: any) => item.text).join('\n');
  }
  if (content == null) return '';
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function processMessageContent(content: any) {
  const blocks = normalizeContent(content);
  const textParts: string[] = [];
  const images: any[] = [];
  const toolResults: any[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text': if (block.text) textParts.push(block.text); break;
      case 'image': {
        const source = block.source;
        if (source) {
          const format = getImageFormat(source.media_type);
          if (format && source.data) images.push({ format, source: { bytes: source.data } });
        }
        break;
      }
      case 'tool_result': {
        if (block.tool_use_id) {
          toolResults.push({ toolUseId: block.tool_use_id, content: [{ text: extractToolResultContent(block.content) }], status: block.is_error === true ? 'error' : 'success' });
        }
        break;
      }
    }
  }
  return { text: textParts.join('\n'), images, toolResults };
}

function shortenToolName(name: string): string {
  const hashHex = crypto.createHash('sha256').update(name, 'utf8').digest('hex');
  return `${name.substring(0, TOOL_NAME_MAX_LEN - 9)}_${hashHex.substring(0, 8)}`;
}

function mapToolName(name: string, toolNameMap: Record<string, string>): string {
  if (name.length <= TOOL_NAME_MAX_LEN) return name;
  const short = shortenToolName(name);
  toolNameMap[short] = name;
  return short;
}

function convertTools(tools: any[] | undefined, toolNameMap: Record<string, string>): any[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t: any) => ({
    toolSpecification: {
      name: mapToolName(t.name, toolNameMap),
      description: (t.description || '').substring(0, 10000),
      inputSchema: { json: t.input_schema || { type: 'object', properties: {} } },
    },
  }));
}

function createPlaceholderTool(name: string) {
  return { toolSpecification: { name, description: 'Tool used in conversation history', inputSchema: { json: { type: 'object', properties: {}, additionalProperties: true } } } };
}

function convertAssistantMessage(msg: any, toolNameMap: Record<string, string>) {
  const blocks = normalizeContent(msg.content);
  let thinkingContent = '', textContent = '';
  const toolUses: any[] = [];
  for (const block of blocks) {
    if (block.type === 'thinking' && block.thinking) thinkingContent += block.thinking;
    else if (block.type === 'text' && block.text) textContent += block.text;
    else if (block.type === 'tool_use' && block.id && block.name) toolUses.push({ toolUseId: block.id, name: mapToolName(block.name, toolNameMap), input: block.input ?? {} });
  }
  let finalContent: string;
  if (thinkingContent) finalContent = textContent ? `<thinking>${thinkingContent}</thinking>\n\n${textContent}` : `<thinking>${thinkingContent}</thinking>`;
  else if (!textContent && toolUses.length > 0) finalContent = ' ';
  else finalContent = textContent;
  return { content: finalContent, toolUses };
}

function mergeUserMessages(msgs: any[], modelId: string) {
  const contentParts: string[] = [], allImages: any[] = [], allToolResults: any[] = [];
  for (const msg of msgs) { const { text, images, toolResults } = processMessageContent(msg.content); if (text) contentParts.push(text); allImages.push(...images); allToolResults.push(...toolResults); }
  const userInputMessage: any = { content: contentParts.join('\n'), modelId, origin: ORIGIN };
  if (allImages.length > 0) userInputMessage.images = allImages;
  if (allToolResults.length > 0) userInputMessage.userInputMessageContext = { toolResults: allToolResults };
  return { userInputMessage };
}

function mergeAssistantMessages(msgs: any[], toolNameMap: Record<string, string>) {
  const allToolUses: any[] = [], contentParts: string[] = [];
  for (const msg of msgs) { const c = convertAssistantMessage(msg, toolNameMap); if (c.content.trim()) contentParts.push(c.content); allToolUses.push(...c.toolUses); }
  const content = contentParts.length === 0 && allToolUses.length > 0 ? ' ' : contentParts.join('\n\n');
  const assistantResponseMessage: any = { content };
  if (allToolUses.length > 0) assistantResponseMessage.toolUses = allToolUses;
  return { assistantResponseMessage };
}

function buildHistory(req: any, messages: any[], modelId: string, toolNameMap: Record<string, string>) {
  const history: any[] = [];
  if (req.system && req.system.trim().length > 0) {
    history.push({ userInputMessage: { content: req.system, modelId, origin: ORIGIN } });
    history.push({ assistantResponseMessage: { content: 'I will follow these instructions.' } });
  }
  const historyEnd = Math.max(0, messages.length - 1);
  let userBuffer: any[] = [], assistantBuffer: any[] = [];
  for (let i = 0; i < historyEnd; i++) {
    const msg = messages[i];
    if (msg.role === 'user') { if (assistantBuffer.length > 0) { history.push(mergeAssistantMessages(assistantBuffer, toolNameMap)); assistantBuffer = []; } userBuffer.push(msg); }
    else if (msg.role === 'assistant') { if (userBuffer.length > 0) { history.push(mergeUserMessages(userBuffer, modelId)); userBuffer = []; } assistantBuffer.push(msg); }
  }
  if (assistantBuffer.length > 0) history.push(mergeAssistantMessages(assistantBuffer, toolNameMap));
  if (userBuffer.length > 0) { history.push(mergeUserMessages(userBuffer, modelId)); history.push({ assistantResponseMessage: { content: 'OK' } }); }
  return history;
}

function collectHistoryToolNames(history: any[]): string[] {
  const names: string[] = [];
  for (const msg of history) if ('assistantResponseMessage' in msg && msg.assistantResponseMessage.toolUses) for (const tu of msg.assistantResponseMessage.toolUses) if (!names.includes(tu.name)) names.push(tu.name);
  return names;
}

function collectHistoryToolUseIds(history: any[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of history) if ('assistantResponseMessage' in msg && msg.assistantResponseMessage.toolUses) for (const tu of msg.assistantResponseMessage.toolUses) ids.add(tu.toolUseId);
  return ids;
}

function collectHistoryToolResultIds(history: any[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of history) if ('userInputMessage' in msg && msg.userInputMessage.userInputMessageContext?.toolResults) for (const tr of msg.userInputMessage.userInputMessageContext.toolResults) ids.add(tr.toolUseId);
  return ids;
}

export function convertRequest(req: any): { conversationState: any; toolNameMap: Record<string, string> } {
  const modelId = mapModel(req.model);
  if (!modelId) throw new ConversionError(`Unsupported model: ${req.model}`);
  if (!req.messages || req.messages.length === 0) throw new ConversionError('messages list is empty');
  let messages = req.messages;
  if (messages[messages.length - 1].role !== 'user') {
    const lastUserIdx = messages.map((m: any) => m.role).lastIndexOf('user');
    if (lastUserIdx < 0) throw new ConversionError('messages list has no user message');
    messages = messages.slice(0, lastUserIdx + 1);
  }
  const lastMessage = messages[messages.length - 1];
  const { text, images, toolResults } = processMessageContent(lastMessage.content);
  const toolNameMap: Record<string, string> = {};
  const tools = convertTools(req.tools, toolNameMap);
  const history = buildHistory(req, messages, modelId, toolNameMap);
  const allToolUseIds = collectHistoryToolUseIds(history);
  const historyResultIds = collectHistoryToolResultIds(history);
  const unpaired = new Set<string>();
  for (const id of allToolUseIds) if (!historyResultIds.has(id)) unpaired.add(id);
  const filtered: any[] = [];
  for (const result of toolResults) { if (unpaired.has(result.toolUseId)) { filtered.push(result); unpaired.delete(result.toolUseId); } }
  if (unpaired.size > 0) for (const msg of history) if ('assistantResponseMessage' in msg && msg.assistantResponseMessage.toolUses) { msg.assistantResponseMessage.toolUses = msg.assistantResponseMessage.toolUses.filter((tu: any) => !unpaired.has(tu.toolUseId)); if (msg.assistantResponseMessage.toolUses.length === 0) msg.assistantResponseMessage.toolUses = undefined; }
  const historyToolNames = collectHistoryToolNames(history);
  const existing = new Set(tools.map((t: any) => t.toolSpecification.name.toLowerCase()));
  for (const name of historyToolNames) if (!existing.has(name.toLowerCase())) { tools.push(createPlaceholderTool(name)); existing.add(name.toLowerCase()); }
  const context: any = {};
  if (tools.length > 0) context.tools = tools;
  if (filtered.length > 0) context.toolResults = filtered;
  const currentMessage: any = { userInputMessage: { content: text, modelId, origin: ORIGIN, userInputMessageContext: context } };
  if (images.length > 0) currentMessage.userInputMessage.images = images;
  return { conversationState: { conversationId: crypto.randomUUID(), agentContinuationId: crypto.randomUUID(), agentTaskType: AGENT_TASK_TYPE, chatTriggerType: CHAT_TRIGGER_TYPE, currentMessage, history }, toolNameMap };
}
