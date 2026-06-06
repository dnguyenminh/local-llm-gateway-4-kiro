/**
 * LLM Backend Adapter interface
 */
import * as http from 'http';

export interface AnthropicModel {
  type: string;
  id: string;
  display_name: string;
  created_at?: string;
  description?: string;
  rate_multiplier?: number;
}

export interface LLMBackendAdapter {
  name: string;
  listModels(): Promise<AnthropicModel[]>;
  createMessage(request: any, res: http.ServerResponse, stream: boolean): Promise<void>;
}

export function buildModelsListResponse(models: AnthropicModel[]) {
  return {
    data: models,
    has_more: false,
    first_id: models.length > 0 ? models[0].id : null,
    last_id: models.length > 0 ? models[models.length - 1].id : null,
  };
}
