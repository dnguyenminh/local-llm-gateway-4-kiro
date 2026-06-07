/**
 * Kiro Stream Converter
 * Converts parsed Kiro AWS Event Stream frames into Anthropic SSE events.
 * KG-5: Reverses tool name truncation in responses using toolNameMap.
 */
import * as crypto from 'crypto';
import { EventFrame, messageType, eventType, exceptionType, errorCode } from './event-stream-parser';

export interface SSEEvent {
  event: string;
  data: unknown;
}

export class KiroStreamConverter {
  private messageId: string;
  private model: string;
  private toolNameMap: Record<string, string>;
  private messageStarted = false;
  private messageEnded = false;
  private nextIndex = 0;
  private currentTextBlock: { index: number; type: string } | null = null;
  private currentToolBlock: { index: number; type: string } | null = null;
  private outputTokens = 0;
  private stopReason = 'end_turn';

  constructor(model: string, toolNameMap?: Record<string, string>, messageId?: string) {
    this.model = model;
    this.toolNameMap = toolNameMap || {};
    this.messageId = messageId || `msg_${crypto.randomBytes(12).toString('hex')}`;
  }

  start(): SSEEvent[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    return [{
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId, type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    }];
  }

  processFrame(frame: EventFrame): SSEEvent[] {
    const mType = messageType(frame) || 'event';
    if (mType === 'exception') {
      return this.handleException(exceptionType(frame) || 'UnknownException', frame.payload.toString('utf8'));
    }
    if (mType === 'error') {
      const code = errorCode(frame) || 'UnknownError';
      return [{ event: 'error', data: { type: 'error', error: { type: 'api_error', message: `${code}: ${frame.payload.toString('utf8')}` } } }];
    }
    const eType = eventType(frame) || 'unknown';
    let payload: any;
    try { payload = JSON.parse(frame.payload.toString('utf8')); } catch { return []; }

    switch (eType) {
      case 'assistantResponseEvent': return this.handleAssistantResponse(typeof payload.content === 'string' ? payload.content : '');
      case 'toolUseEvent': return this.handleToolUse(payload);
      case 'contextUsageEvent': return [];
      default: return [];
    }
  }

  finish(): SSEEvent[] {
    const events: SSEEvent[] = [];
    events.push(...this.closeOpenBlocks());
    events.push({
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: { output_tokens: this.outputTokens } },
    });
    if (!this.messageEnded) {
      this.messageEnded = true;
      events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    }
    return events;
  }

  private handleAssistantResponse(content: string): SSEEvent[] {
    if (!content) return [];
    const events: SSEEvent[] = [];
    this.outputTokens += Math.ceil(content.length / 4);
    if (this.currentToolBlock) events.push(...this.closeToolBlock());
    if (!this.currentTextBlock) {
      const index = this.nextIndex++;
      this.currentTextBlock = { index, type: 'text' };
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    }
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.currentTextBlock.index, delta: { type: 'text_delta', text: content } } });
    return events;
  }

  private handleToolUse(payload: any): SSEEvent[] {
    const events: SSEEvent[] = [];
    let name = typeof payload.name === 'string' ? payload.name : '';
    const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    const input = typeof payload.input === 'string' ? payload.input : '';
    const stop = payload.stop === true;

    // KG-5: Reverse tool name truncation — map shortened name back to original
    if (name && this.toolNameMap[name]) {
      name = this.toolNameMap[name];
    }

    if (this.currentTextBlock) events.push(...this.closeTextBlock());
    if (!this.currentToolBlock) {
      const index = this.nextIndex++;
      this.currentToolBlock = { index, type: 'tool_use' };
      this.stopReason = 'tool_use';
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolUseId, name, input: {} } } });
    }
    if (input.length > 0) {
      this.outputTokens += Math.ceil(input.length / 4);
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.currentToolBlock.index, delta: { type: 'input_json_delta', partial_json: input } } });
    }
    if (stop) events.push(...this.closeToolBlock());
    return events;
  }

  private handleException(exType: string, message: string): SSEEvent[] {
    if (exType === 'ContentLengthExceededException') { this.stopReason = 'max_tokens'; return []; }
    return [{ event: 'error', data: { type: 'error', error: { type: 'api_error', message: `${exType}: ${message}` } } }];
  }

  private closeTextBlock(): SSEEvent[] {
    if (!this.currentTextBlock) return [];
    const index = this.currentTextBlock.index;
    this.currentTextBlock = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index } }];
  }

  private closeToolBlock(): SSEEvent[] {
    if (!this.currentToolBlock) return [];
    const index = this.currentToolBlock.index;
    this.currentToolBlock = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index } }];
  }

  private closeOpenBlocks(): SSEEvent[] {
    return [...this.closeTextBlock(), ...this.closeToolBlock()];
  }
}
