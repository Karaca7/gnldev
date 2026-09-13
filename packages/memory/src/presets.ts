// @gnldev/memory ergonomics: zero-dependency default embed + ready-made presets. Does NOT change existing
// AgentMemory behavior (opt-in): defaultEmbed is not auto-wired (so it won't change recall), presets are a separate helper.
// P2-memory OM retrieval mode (`AgentMemory.recallObservations`/`expandObservation`,
// `createOmRecallTool`) is ALSO opt-in — neither preset below auto-registers the recall tool in
// `loadContext`'s `out.tools` the way the WM update tool is, so turning on `observationalMemory` here does
// not silently hand the model a new tool. Callers who want it wire `createOmRecallTool` themselves.
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

/**
 * How much a conversation REMEMBERS. `chat` keeps the last 10 turns and nothing else; `recall` keeps
 * the last 8 and additionally searches the resource's older messages by similarity.
 *
 * `recall` was called 'assistant' until the framework grew a second, unrelated switch spelled the same
 * way: `preset: 'assistant'` on a gnl config decides WHAT A REPEATED SIDE EFFECT DOES (ask a human /
 * refuse / lock). Two axes, one word, nothing in common — and the config-level one is the word a
 * reader meets first, in the file `gnl init` writes. So the one that is really about retrieval now
 * says retrieval. `chat` stays: it collides with nothing.
 */
export type MemoryPresetKind = 'chat' | 'recall';
export interface MemoryPresetOptions {
  /** Embed for recall (falls back to defaultEmbed if not given in the assistant preset). */
  embed?: Embed;
  workingMemory?: WorkingMemoryConfig;
  observationalMemory?: ObservationalMemoryConfig;
}

/**
 * Pre-configured AgentMemory (sensible defaults). `chat`: last 10 messages, no recall.
 * `recall`: last 8 messages + resource-scope recall (defaultEmbed). Does not touch the constructor.
 */
export function memoryPreset(storage: Storage, kind: MemoryPresetKind = 'recall', opts: MemoryPresetOptions = {}): AgentMemory {
  // The old spelling is REFUSED, not quietly accepted. An alias would leave the collision in place in
  // every project that already wrote it, which is the whole thing the rename is undoing; and because
  // this argument is read once at wiring time, the refusal lands while someone is looking at the file
  // rather than in the middle of a conversation. Typed callers never get here — `MemoryPresetKind` no
  // longer contains the word — so this is for JavaScript callers and for values that arrived as data.
  if ((kind as string) === 'assistant') {
    throw new Error(
      "@gnldev/memory: memoryPreset kind 'assistant' was renamed to 'recall'. It had nothing to do with " +
      "a gnl config's `preset: 'assistant'` (which decides what a repeated side effect does) — this one " +
      'chooses how much history is recalled. Write `recall` for the same behaviour.',
    );
  }
  const common = {
    ...(opts.workingMemory ? { workingMemory: opts.workingMemory } : {}),
    ...(opts.observationalMemory ? { observationalMemory: opts.observationalMemory } : {}),
  };
  if (kind === 'chat') {
    return new AgentMemory({ storage, recentN: 10, ...(opts.embed ? { embed: opts.embed } : {}), ...common });
  }
  // P1.5 callers of memoryPreset can pass `messageRange`/`filter` (operator
  // subset: $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin) via AgentMemory's own `recall` config directly — this
  // preset doesn't default them (kept minimal), but they flow end-to-end once set (see agent-memory.ts).
  return new AgentMemory({
    storage,
    recentN: 8,
    embed: opts.embed ?? defaultEmbed,
    recall: { topK: 3, scope: 'resource', threshold: 0.1 },
    ...common,
  });
}
