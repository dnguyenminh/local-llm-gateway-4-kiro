/**
 * AWS Event Stream Parser
 * Parses binary AWS Event Stream frames from generateAssistantResponse.
 */

const PRELUDE_SIZE = 12;
const MIN_MESSAGE_SIZE = PRELUDE_SIZE + 4;
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;
const DEFAULT_MAX_ERRORS = 5;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EventFrame {
  headers: Record<string, unknown>;
  payload: Buffer;
}

export function messageType(frame: EventFrame): string | undefined {
  const v = frame.headers[':message-type'];
  return typeof v === 'string' ? v : undefined;
}

export function eventType(frame: EventFrame): string | undefined {
  const v = frame.headers[':event-type'];
  return typeof v === 'string' ? v : undefined;
}

export function exceptionType(frame: EventFrame): string | undefined {
  const v = frame.headers[':exception-type'];
  return typeof v === 'string' ? v : undefined;
}

export function errorCode(frame: EventFrame): string | undefined {
  const v = frame.headers[':error-code'];
  return typeof v === 'string' ? v : undefined;
}

class ParseError extends Error {
  constructor(message: string) { super(message); this.name = 'ParseError'; }
}

function parseHeaders(data: Buffer, headerLength: number): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  let offset = 0;
  while (offset < headerLength) {
    if (offset >= data.length) break;
    const nameLen = data[offset]; offset += 1;
    if (nameLen === 0) throw new ParseError('Header name length cannot be 0');
    if (offset + nameLen > data.length) throw new ParseError('Incomplete header name');
    const name = data.toString('utf8', offset, offset + nameLen); offset += nameLen;
    if (offset >= data.length) throw new ParseError('Incomplete header value type');
    const valueType = data[offset]; offset += 1;

    switch (valueType) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: headers[name] = data.readInt8(offset); offset += 1; break;
      case 3: headers[name] = data.readInt16BE(offset); offset += 2; break;
      case 4: headers[name] = data.readInt32BE(offset); offset += 4; break;
      case 5: headers[name] = data.readBigInt64BE(offset); offset += 8; break;
      case 6: { const len = data.readUInt16BE(offset); offset += 2; headers[name] = data.subarray(offset, offset + len); offset += len; break; }
      case 7: { const len = data.readUInt16BE(offset); offset += 2; headers[name] = data.toString('utf8', offset, offset + len); offset += len; break; }
      case 8: headers[name] = data.readBigInt64BE(offset); offset += 8; break;
      case 9: headers[name] = data.subarray(offset, offset + 16); offset += 16; break;
      default: throw new ParseError(`Invalid header value type: ${valueType}`);
    }
  }
  return headers;
}

export function parseFrame(buffer: Buffer): { frame: EventFrame; consumed: number } | null {
  if (buffer.length < PRELUDE_SIZE) return null;
  const totalLength = buffer.readUInt32BE(0);
  const headerLength = buffer.readUInt32BE(4);
  const preludeCrc = buffer.readUInt32BE(8);

  if (totalLength < MIN_MESSAGE_SIZE) throw new ParseError(`Message too small: ${totalLength}`);
  if (totalLength > MAX_MESSAGE_SIZE) throw new ParseError(`Message too large: ${totalLength}`);
  if (buffer.length < totalLength) return null;

  const actualPreludeCrc = crc32(buffer, 0, 8);
  if (actualPreludeCrc !== preludeCrc) throw new ParseError('Prelude CRC mismatch');

  const messageCrc = buffer.readUInt32BE(totalLength - 4);
  const actualMessageCrc = crc32(buffer, 0, totalLength - 4);
  if (actualMessageCrc !== messageCrc) throw new ParseError('Message CRC mismatch');

  const headersStart = PRELUDE_SIZE;
  const headersEnd = headersStart + headerLength;
  const headers = parseHeaders(buffer.subarray(headersStart, headersEnd), headerLength);
  const payload = Buffer.from(buffer.subarray(headersEnd, totalLength - 4));
  return { frame: { headers, payload }, consumed: totalLength };
}

export class EventStreamDecoder {
  private buffer = Buffer.alloc(0);
  private errorCount = 0;
  private stopped = false;
  private maxErrors: number;

  constructor(maxErrors = DEFAULT_MAX_ERRORS) { this.maxErrors = maxErrors; }

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
  }

  decodeAll(): EventFrame[] {
    const frames: EventFrame[] = [];
    if (this.stopped) return frames;
    while (true) {
      if (this.buffer.length === 0) break;
      let result;
      try { result = parseFrame(this.buffer); }
      catch (err: any) {
        this.errorCount++;
        if (this.errorCount >= this.maxErrors) { this.stopped = true; break; }
        this.recover(err); continue;
      }
      if (result === null) break;
      frames.push(result.frame);
      this.buffer = this.buffer.subarray(result.consumed);
      this.errorCount = 0;
    }
    return frames;
  }

  private recover(error: Error): void {
    if (this.buffer.length === 0) return;
    if (error.message.includes('Message CRC') || error.message.includes('Header')) {
      if (this.buffer.length >= PRELUDE_SIZE) {
        const totalLength = this.buffer.readUInt32BE(0);
        if (totalLength >= MIN_MESSAGE_SIZE && totalLength <= this.buffer.length) {
          this.buffer = this.buffer.subarray(totalLength); return;
        }
      }
    }
    this.buffer = this.buffer.subarray(1);
  }
}
