/**
 * Request Validator
 * Validates incoming Anthropic Messages API requests.
 */

export interface ValidationResult {
  valid: boolean;
  error?: { type: string; error: { type: string; message: string } };
}

export function validateRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return makeError('invalid_request_error', 'Request body must be a JSON object');
  }
  const data = body as Record<string, unknown>;

  if (!data.model || typeof data.model !== 'string' || data.model.trim().length === 0) {
    return makeError('invalid_request_error', 'model is required and must be a non-empty string');
  }
  if ((data.model as string).length > 100) {
    return makeError('invalid_request_error', 'model must be at most 100 characters');
  }

  if (!Array.isArray(data.messages) || data.messages.length === 0) {
    return makeError('invalid_request_error', 'messages is required and must be a non-empty array');
  }

  if (data.max_tokens === undefined || data.max_tokens === null) {
    return makeError('invalid_request_error', 'max_tokens is required');
  }
  if (typeof data.max_tokens !== 'number' || !Number.isInteger(data.max_tokens)) {
    return makeError('invalid_request_error', 'max_tokens must be an integer');
  }
  if (data.max_tokens < 1 || data.max_tokens > 200000) {
    return makeError('invalid_request_error', 'max_tokens must be between 1 and 200000');
  }

  if (data.temperature !== undefined && data.temperature !== null) {
    if (typeof data.temperature !== 'number' || data.temperature < 0 || data.temperature > 1) {
      return makeError('invalid_request_error', 'temperature must be a number between 0.0 and 1.0');
    }
  }

  if (data.stream !== undefined && typeof data.stream !== 'boolean') {
    return makeError('invalid_request_error', 'stream must be a boolean');
  }

  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools)) {
      return makeError('invalid_request_error', 'tools must be an array');
    }
    for (let i = 0; i < data.tools.length; i++) {
      const tool = data.tools[i] as Record<string, unknown>;
      if (!tool.name || typeof tool.name !== 'string') {
        return makeError('invalid_request_error', `tools[${i}].name is required and must be a string`);
      }
    }
  }

  return { valid: true };
}

function makeError(type: string, message: string): ValidationResult {
  return {
    valid: false,
    error: { type: 'error', error: { type, message } },
  };
}
