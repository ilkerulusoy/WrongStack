/**
 * Kiro model id resolution.
 *
 * WrongStack model ids use dashes for version numbers (e.g. `claude-opus-4-6`);
 * the Kiro API expects dots (`claude-opus-4.6`). Only digit-dash-digit
 * sequences are version separators, so the conversion is scoped to those.
 */

export const KIRO_MODEL_IDS = new Set([
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'deepseek-3.2',
  'minimax-m2.1',
  'minimax-m2.5',
  'glm-5',
  'qwen3-coder-next',
  'auto',
]);

const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 } as const;

export interface KiroModel {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** Static Kiro model catalog (WrongStack-format ids, dashes for versions). */
export const KIRO_MODELS: KiroModel[] = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reasoning: true, vision: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', reasoning: true, vision: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, vision: true, contextWindow: 1_000_000, maxTokens: 32_768 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, vision: true, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 65_536 },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 65_536 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, vision: true, contextWindow: 200_000, maxTokens: 65_536 },
  { id: 'deepseek-3-2', name: 'DeepSeek 3.2', reasoning: true, vision: false, contextWindow: 164_000, maxTokens: 8_192 },
  { id: 'minimax-m2-5', name: 'MiniMax M2.5', reasoning: false, vision: false, contextWindow: 196_000, maxTokens: 8_192 },
  { id: 'minimax-m2-1', name: 'MiniMax M2.1', reasoning: false, vision: false, contextWindow: 196_000, maxTokens: 8_192 },
  { id: 'glm-5', name: 'GLM 5', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 8_192 },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', reasoning: true, vision: false, contextWindow: 256_000, maxTokens: 8_192 },
  { id: 'auto', name: 'Auto', reasoning: true, vision: true, contextWindow: 1_000_000, maxTokens: 65_536 },
];

/** Models.dev-shaped models for catalog registration. */
export function kiroModelsDev(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of KIRO_MODELS) {
    out[m.id] = {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      tool_call: true,
      modalities: { input: m.vision ? ['text', 'image'] : ['text'], output: ['text'] },
      cost: { ...ZERO_COST },
      limit: { context: m.contextWindow, output: m.maxTokens },
    };
  }
  return out;
}

/** Convert a WrongStack model id to the Kiro API model id. */
export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, '$1.$2');
  if (!KIRO_MODEL_IDS.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}
