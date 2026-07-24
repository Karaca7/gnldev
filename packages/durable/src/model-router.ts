// Model router: converts a 'provider/model' string into an AI SDK model (lazy import → no provider lock-in).
// + withModelFallback: a multi-model chain — the winner is written to the journal via CAS → DETERMINISTIC
// fallback (resume and subsequent steps stick to the same model; in most model-fallback implementations the decision isn't persistent).
import { claim, runKeys } from './journal.js';
import type { Journal } from './journal.js';

const PROVIDER_PKG: Record<string, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  mistral: '@ai-sdk/mistral',
};

export async function resolveModel(spec: string): Promise<any> {
  const i = spec.indexOf('/');
  if (i < 0) throw new Error(`model: expected 'provider/model', got '${spec}'`);
  const provider = spec.slice(0, i);
  const modelId = spec.slice(i + 1);
  const pkg = PROVIDER_PKG[provider];
  if (!pkg) {
    throw new Error(`Unknown provider '${provider}'. Supported: ${Object.keys(PROVIDER_PKG).join(', ')}`);
  }
  let mod: any;
  try {
    mod = await import(pkg);
  } catch {
    throw new Error(`${pkg} is not installed for '${spec}'. Run: npm i ${pkg}`);
  }
  const factory = mod[provider] ?? mod.default;
  if (typeof factory !== 'function') {
    throw new Error(`${pkg} does not export the expected provider factory`);
  }
  return factory(modelId);
}

export interface FallbackCandidate {
  /** The stable label written to the journal: a string spec ('openai/gpt-4o') or '#<index>' for object models. */
  spec: string;
  model: any; // LanguageModelV2
}

/**
 * Deterministic model fallback: tries the candidates in order; the spec of the FIRST SUCCESSFUL call is
 * written to `<runId>:cfg:model` via CAS → the same run's subsequent steps and resumes (even after a
 * transient failure clears) use the SAME model. withDurableModel wraps AROUND this: on replay the
 * response from the journal is returned, the fallback logic never runs at all.
 */
export function withModelFallback(candidates: FallbackCandidate[], journal: Journal, runId: string): any {
  if (candidates.length === 0) throw new Error('withModelFallback: at least one candidate is required');
  if (candidates.length === 1) return candidates[0]!.model;
  const key = runKeys.cfgModel(runId);
  let sticky: number | null = null;

  const order = async (): Promise<number[]> => {
    if (sticky != null) return [sticky];
    const rec = await journal.get<{ spec: string }>(key);
    if (rec) {
      const i = candidates.findIndex((c) => c.spec === rec.spec);
      if (i >= 0) { sticky = i; return [i]; } // frozen choice: only the winner is tried
    }
    return candidates.map((_, i) => i);
  };
  const record = async (i: number): Promise<void> => {
    if (sticky === i) return;
    sticky = i;
    await claim(journal, key, { spec: candidates[i]!.spec }); // first winner; doesn't touch if already present (CAS)
  };
  const attempt = async <T>(fn: (m: any) => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (const i of await order()) {
      try {
        const r = await fn(candidates[i]!.model);
        await record(i);
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };

  const first = candidates[0]!.model;
  return {
    specificationVersion: first.specificationVersion,
    provider: first.provider,
    modelId: first.modelId,
    supportedUrls: first.supportedUrls,
    doGenerate: (options: any) => attempt((m) => m.doGenerate(options)),
    doStream: (options: any) => attempt((m) => m.doStream(options)),
  };
}
