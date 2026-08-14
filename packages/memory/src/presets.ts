// @gnldev/memory ergonomics: zero-dependency default embed + ready-made presets. Does NOT change existing
// AgentMemory behavior (opt-in): defaultEmbed is not auto-wired (so it won't change recall), presets are a separate helper.
// P2-memory OM retrieval mode (`AgentMemory.recallObservations`/`expandObservation`,
// `createOmRecallTool`) is ALSO opt-in — neither preset below auto-registers the recall tool in
// `loadContext`'s `out.tools` the way the WM update tool is, so turning on `observationalMemory` here does
// Not silently hand the model a new tool. Callers who want it wire `createOmRecallTool` themselves.
import type { Storage } from '@gnldev/durable';
import type { Embed } from './keys.js';
import { AgentMemory } from './agent-memory.js';
import type { WorkingMemoryConfig } from './working-memory.js';
import type { ObservationalMemoryConfig } from './observational.js';

/**
 * Deterministic, dependency-free embed (token-hash → fixed size, L2-normalized → compatible with cosineSimilarity).
 * Use a real embedding model for real semantic recall; this one is for demo/test/fallback purposes.
 */
export function createDefaultEmbed(dims = 64): Embed {
  return async (text: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const tok of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
}

/** Ready-made default embed (64 dimensions). */
export const defaultEmbed: Embed = createDefaultEmbed();

export type MemoryPresetKind = 'chat' | 'assistant';
export interface MemoryPresetOptions {
  /** Embed for recall (falls back to defaultEmbed if not given in the assistant preset). */
  embed?: Embed;
  workingMemory?: WorkingMemoryConfig;
  observationalMemory?: ObservationalMemoryConfig;
}

/**
 * Pre-configured AgentMemory (sensible defaults). `chat`: last 10 messages, no recall.
 * `assistant`: last 8 messages + resource-scope recall (defaultEmbed). Does not touch the constructor.
 */
export function memoryPreset(storage: Storage, kind: MemoryPresetKind = 'assistant', opts: MemoryPresetOptions = {}): AgentMemory {
  const common = {
    ...(opts.workingMemory ? { workingMemory: opts.workingMemory } : {}),
    ...(opts.observationalMemory ? { observationalMemory: opts.observationalMemory } : {}),
  };
  if (kind === 'chat') {
    return new AgentMemory({ storage, recentN: 10, ...(opts.embed ? { embed: opts.embed } : {}), ...common });
  }
  // P1.5 callers of memoryPreset can pass `messageRange`/`filter` (operator
  // Subset: $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin) via AgentMemory's own `recall` config directly — this
  // Preset doesn't default them (kept minimal), but they flow end-to-end once set (see agent-memory.ts).
  return new AgentMemory({
    storage,
    recentN: 8,
    embed: opts.embed ?? defaultEmbed,
    recall: { topK: 3, scope: 'resource', threshold: 0.1 },
    ...common,
  });
}
