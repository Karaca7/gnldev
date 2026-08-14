import type { ModelInfo } from './types.js';

/**
 * Extracts provider/modelId from a model. Handles both input shapes:
 * string `'provider/model'`  → split on '/' (gnl model-router format)
 * LanguageModelV2 object     → `.provider` ('openai.chat' → 'openai') + `.modelId`
 *
 * Unknown/missing fields return an empty string → no rule matches (safe no-op).
 */
export function detectModel(model: unknown): ModelInfo {
  if (typeof model === 'string') {
    const i = model.indexOf('/');
    if (i >= 0) return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
    return { provider: '', modelId: model };
  }
  const m = model as { provider?: unknown; modelId?: unknown } | null;
  const providerRaw = typeof m?.provider === 'string' ? m.provider : '';
  const provider = providerRaw.includes('.') ? providerRaw.split('.')[0]! : providerRaw;
  const modelId = typeof m?.modelId === 'string' ? m.modelId : '';
  return { provider, modelId };
}
