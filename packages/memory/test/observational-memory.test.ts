// Track 4 observational memory (MemoryStore + RunJournal memoization). The Observer folds old messages into observations;
// loadContext returns observations(system)+unobserved; durable: the same seq again does not call the LLM (RunJournal memoizes).
import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from 'ai';
import { InMemoryStorage } from '@gnl/durable';
import { AgentMemory, createOmRecallTool } from '../src/index.js';
import type { Observation, OmVectorItem, OmVectorMatch } from '../src/index.js';

const u = (content: string) => ({ role: 'user', content });

function observerModel(counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      counter.calls++;
      const userText = (prompt ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : '')).join(' ');
      return { content: [{ type: 'text', text: `OBS(${userText.length})` }], finishReason: 'stop', usage: {}, warnings: [] };
    },
    doStream: async () => { throw new Error('no'); },
  };
}

describe('Track 4 observational memory', () => {
  it('the Observer summarizes once the threshold is exceeded; loadContext returns observations+unobserved', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);

    const ctx = await mem.loadContext('th', {});
    expect(counter.calls).toBe(1);
    const obs = await storage.memory.getObservations('th');
    expect(obs.length).toBe(1);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toContain('Observations');
    expect(ctx.messages.length).toBeLessThan(11);
  });

  it('durable twist: cross-instance replay → the LLM is not called again, same summary', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const cfg = () => ({ enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } });
    const mem = new AgentMemory({ storage, observationalMemory: cfg() });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});
    expect(counter.calls).toBe(1);
    const obsText1 = (await storage.memory.getObservations('th'))[0]!.text;

    // Partial-crash simulation: reset OM progress → compact re-enters the SAME seq=0.
    // The RunJournal memoization KEY (observe:0) is preserved → the LLM IS NOT CALLED.
    await storage.runs.put('om:th:observeSeq', 0);
    await storage.runs.put('om:th:observedSeq', -1);
    await storage.memory.putObservations('th', []);

    const mem2 = new AgentMemory({ storage, observationalMemory: cfg() });
    await mem2.loadContext('th', {});
    expect(counter.calls).toBe(1); // replay: NO second LLM call
    expect((await storage.memory.getObservations('th'))[0]!.text).toBe(obsText1);
  });

  it('Reflector: compresses observations once they accumulate past the threshold (level-1)', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 2 }, reflection: { observationThreshold: 1 } } });
    for (let i = 0; i < 4; i++) await mem.append('th', [u(`a${i}`)]);
    await mem.loadContext('th', {});
    for (let i = 0; i < 4; i++) await mem.append('th', [u(`b${i}`)]);
    await mem.loadContext('th', {});
    const obs = await storage.memory.getObservations('th');
    expect(obs.some((o) => o.level === 1)).toBe(true);
  });

  it('disabled: OM off → normal recall/recent, no observation', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, recentN: 2 });
    for (let i = 0; i < 5; i++) await mem.append('th', [u(`m${i}`)]);
    const ctx = await mem.loadContext('th', {});
    expect(ctx.messages).toHaveLength(2);
    expect(await storage.memory.getObservations('th')).toEqual([]);
  });
});

// P2-memory (AUDIT-R2): OM retrieval mode v1 — source seq ranges on observations +
// recallObservations/expandObservation/createOmRecallTool.
describe('Track 4 OM retrieval mode (P2-memory)', () => {
  it('compaction records the source seq range (fromSeq/toSeq/threadId) on the observation', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    const obs = await storage.memory.getObservations('th');
    expect(obs.length).toBe(1);
    expect(obs[0]!.threadId).toBe('th');
    // messageThreshold=4 (keepBudget=2): the block distilled is the seq-ascending prefix [0..7] (8
    // messages), matching the existing "obs.length===1" compaction test above.
    expect(obs[0]!.fromSeq).toBe(0);
    expect(obs[0]!.toSeq).toBe(7);
  });

  it('old-shape observations (no range fields) remain readable and recallable', async () => {
    const storage = new InMemoryStorage();
    await storage.memory.putObservations('th', [
      { id: 'obs-legacy', text: 'legacy summary about Ada', createdAt: Date.now(), sourceIds: ['0', '1'], level: 0 },
    ]);
    const mem = new AgentMemory({ storage });

    const results = await mem.recallObservations('th', 'legacy');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('legacy summary about Ada');
    expect(results[0]!.range).toBeUndefined();
  });

  it('recallObservations: keyword match returns the observation with its source range', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {}); // observer text is `OBS(<len>)` — see observerModel above

    const results = await mem.recallObservations('th', 'obs'); // case-insensitive
    expect(results.length).toBe(1);
    expect(results[0]!.range).toEqual({ threadId: 'th', fromSeq: 0, toSeq: 7 });
  });

  it('recallObservations: no keyword match → []', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    expect(await mem.recallObservations('th', 'nonexistent-keyword')).toEqual([]);
    expect(await mem.recallObservations('th', '   ')).toEqual([]); // blank query → []
  });

  it('expandObservation returns exactly the source messages for a range', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    const expanded = await mem.expandObservation('th', 0, 7);
    expect(expanded).toHaveLength(8);
    expect(expanded[0]).toEqual(u('message 0'));
    expect(expanded[7]).toEqual(u('message 7'));
  });

  it('createOmRecallTool: the AI SDK tool executes recall + expand end-to-end', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    const tools = createOmRecallTool({
      recall: (query) => mem.recallObservations('th', query),
      expand: (fromSeq, toSeq) => mem.expandObservation('th', fromSeq, toSeq),
    });
    const noExpand = await tools.recallObservations.execute({ query: 'obs' }, {} as any);
    expect(noExpand.matches).toHaveLength(1);
    expect(noExpand.matches[0].source).toBeUndefined();

    const withExpand = await tools.recallObservations.execute({ query: 'obs', expand: true }, {} as any);
    expect(withExpand.matches).toHaveLength(1);
    expect(withExpand.matches[0].source).toHaveLength(8);
  });
});

// D4-om (AUDIT-R2 follow-up): OM retrieval mode, vector-indexed — the honest follow-up the P2
// v1 keyword/substring `recallObservations` promised. `omVectors` is opt-in; absent → behavior stays v1.

/** Mirrors `@gnl/durable`'s `InMemoryVectorStore` EXACTLY (no metadata-filter param on `query`) — proves
 *  `omVectors.store` works against the real (filter-less) VectorStore port surface, not an idealized mock. */
class FakeVectorStore {
  items: OmVectorItem[] = [];
  async upsert(items: OmVectorItem[]): Promise<void> {
    for (const it of items) {
      const i = this.items.findIndex((x) => x.id === it.id);
      if (i >= 0) this.items[i] = it; else this.items.push(it);
    }
  }
  async query(embedding: number[], topK: number): Promise<OmVectorMatch[]> {
    return this.items
      .map((it) => ({ id: it.id, text: it.text, metadata: it.metadata, score: cosineSimilarity(embedding, it.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** Deterministic hand-crafted pseudo-embeddings: "car"/"vehicle"/"drive" cluster together, "banana"/"fruit"
 *  cluster together, orthogonal to the first cluster — lets a test prove "car"≈"vehicle" (cosine 1.0)
 *  while a literal substring/keyword match on "vehicle" would MISS an observation that only says "car". */
function fakeEmbedOne(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes('car') || t.includes('vehicle') || t.includes('drive')) return [1, 0, 0];
  if (t.includes('banana') || t.includes('fruit')) return [0, 1, 0];
  return [0, 0, 1];
}
function countingFakeEmbed(counter: { calls: number }): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]) => { counter.calls++; return texts.map(fakeEmbedOne); };
}

describe('Track 4 OM vector-indexed retrieval (D4-om)', () => {
  it('compaction indexes each new observation with a deterministic id; re-compaction (replay) upserts, does NOT duplicate', async () => {
    const storage = new InMemoryStorage();
    const llmCounter = { calls: 0 };
    const embedCounter = { calls: 0 };
    const store = new FakeVectorStore();
    const cfg = () => ({
      enabled: true,
      observerModel: observerModel(llmCounter),
      observation: { messageThreshold: 4 },
      omVectors: { store, embed: countingFakeEmbed(embedCounter) },
    });
    const mem = new AgentMemory({ storage, observationalMemory: cfg() });
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    expect(llmCounter.calls).toBe(1);
    expect(embedCounter.calls).toBe(1);
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.id).toBe('om:th:0:0'); // deterministic: om:<threadId>:<level>:<seq>
    expect(store.items[0]!.metadata).toEqual({ threadId: 'th', level: 0, fromSeq: 0, toSeq: 7, obsId: 'obs-0' });

    // Partial-crash / replay simulation (same shape as the "durable twist" test above): reset OM progress
    // so compaction re-enters the SAME seq=0. Both the LLM call AND the embed call are journal-memoized →
    // neither runs again; the vector store still holds exactly ONE row (upsert overwrites the same id).
    await storage.runs.put('om:th:observeSeq', 0);
    await storage.runs.put('om:th:observedSeq', -1);
    await storage.memory.putObservations('th', []);

    const mem2 = new AgentMemory({ storage, observationalMemory: cfg() });
    await mem2.loadContext('th', {});

    expect(llmCounter.calls).toBe(1); // no second LLM call (existing guarantee, unaffected)
    expect(embedCounter.calls).toBe(1); // no second embed call (D4-om: same memoization mechanism)
    expect(store.items).toHaveLength(1); // NOT duplicated
    expect(store.items[0]!.id).toBe('om:th:0:0');
  });

  it('recallObservationsSemantic finds the semantically-closest observation where a keyword match would miss it', async () => {
    const storage = new InMemoryStorage();
    const carObs: Observation = { id: 'obs-0', text: 'The user owns a car and drives to work.', createdAt: Date.now(), sourceIds: ['0'], level: 0, fromSeq: 0, toSeq: 3, threadId: 'th' };
    const bananaObs: Observation = { id: 'obs-1', text: 'The user eats a banana every morning.', createdAt: Date.now(), sourceIds: ['4'], level: 0, fromSeq: 4, toSeq: 7, threadId: 'th' };
    await storage.memory.putObservations('th', [carObs, bananaObs]);

    const store = new FakeVectorStore();
    await store.upsert([
      { id: 'om:th:0:0', text: carObs.text, embedding: fakeEmbedOne(carObs.text), metadata: { threadId: 'th', level: 0, fromSeq: 0, toSeq: 3, obsId: 'obs-0' } },
      { id: 'om:th:0:1', text: bananaObs.text, embedding: fakeEmbedOne(bananaObs.text), metadata: { threadId: 'th', level: 0, fromSeq: 4, toSeq: 7, obsId: 'obs-1' } },
    ]);
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel({ calls: 0 }), omVectors: { store, embed: countingFakeEmbed({ calls: 0 }) } } });

    // "vehicle" never appears in carObs.text — a keyword/substring match would find NOTHING.
    expect(await mem.recallObservations('th', 'vehicle')).toEqual([]);

    const results = await mem.recallObservationsSemantic('th', 'vehicle', { topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('obs-0');
    expect(results[0]!.range).toEqual({ threadId: 'th', fromSeq: 0, toSeq: 3 });
  });

  it('threadId isolation: a query from thread A never returns thread B\'s observations, even at a tied score', async () => {
    const storage = new InMemoryStorage();
    const obsA: Observation = { id: 'obs-A0', text: 'The user drives a car.', createdAt: Date.now(), sourceIds: ['0'], level: 0, fromSeq: 0, toSeq: 1, threadId: 'A' };
    const obsB: Observation = { id: 'obs-B0', text: 'The user also drives a car.', createdAt: Date.now(), sourceIds: ['0'], level: 0, fromSeq: 0, toSeq: 1, threadId: 'B' };
    await storage.memory.putObservations('A', [obsA]);
    await storage.memory.putObservations('B', [obsB]);

    const store = new FakeVectorStore();
    await store.upsert([
      { id: 'om:A:0:0', text: obsA.text, embedding: fakeEmbedOne(obsA.text), metadata: { threadId: 'A', level: 0, fromSeq: 0, toSeq: 1, obsId: 'obs-A0' } },
      { id: 'om:B:0:0', text: obsB.text, embedding: fakeEmbedOne(obsB.text), metadata: { threadId: 'B', level: 0, fromSeq: 0, toSeq: 1, obsId: 'obs-B0' } },
    ]);
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel({ calls: 0 }), omVectors: { store, embed: countingFakeEmbed({ calls: 0 }) } } });

    const resultsA = await mem.recallObservationsSemantic('A', 'vehicle', { topK: 5 });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]!.id).toBe('obs-A0');
    expect(resultsA.every((r) => r.range?.threadId === 'A')).toBe(true);

    const resultsB = await mem.recallObservationsSemantic('B', 'vehicle', { topK: 5 });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0]!.id).toBe('obs-B0');
  });

  it('threshold is honored: a low-scoring observation is excluded above the threshold, included below it', async () => {
    const storage = new InMemoryStorage();
    const carObs: Observation = { id: 'obs-0', text: 'The user drives a car.', createdAt: Date.now(), sourceIds: ['0'], level: 0, fromSeq: 0, toSeq: 1, threadId: 'th' };
    const bananaObs: Observation = { id: 'obs-1', text: 'The user eats a banana.', createdAt: Date.now(), sourceIds: ['2'], level: 0, fromSeq: 2, toSeq: 3, threadId: 'th' };
    await storage.memory.putObservations('th', [carObs, bananaObs]);

    const store = new FakeVectorStore();
    await store.upsert([
      { id: 'om:th:0:0', text: carObs.text, embedding: fakeEmbedOne(carObs.text), metadata: { threadId: 'th', level: 0, fromSeq: 0, toSeq: 1, obsId: 'obs-0' } },
      { id: 'om:th:0:1', text: bananaObs.text, embedding: fakeEmbedOne(bananaObs.text), metadata: { threadId: 'th', level: 0, fromSeq: 2, toSeq: 3, obsId: 'obs-1' } },
    ]);
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel({ calls: 0 }), omVectors: { store, embed: countingFakeEmbed({ calls: 0 }) } } });

    // "vehicle" → [1,0,0]: cosine(carObs)=1, cosine(bananaObs)=0.
    const strict = await mem.recallObservationsSemantic('th', 'vehicle', { topK: 5, threshold: 0.5 });
    expect(strict.map((r) => r.id)).toEqual(['obs-0']); // bananaObs (score 0) excluded

    const lenient = await mem.recallObservationsSemantic('th', 'vehicle', { topK: 5, threshold: 0 });
    expect(lenient.map((r) => r.id).sort()).toEqual(['obs-0', 'obs-1']); // both included at threshold 0
  });

  it('absent omVectors → recallObservationsSemantic falls back to v1 keyword behavior, byte-identical', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } } }); // NO omVectors
    for (let i = 0; i < 10; i++) await mem.append('th', [u(`message ${i}`)]);
    await mem.loadContext('th', {});

    const viaKeyword = await mem.recallObservations('th', 'obs');
    const viaSemanticFallback = await mem.recallObservationsSemantic('th', 'obs');
    expect(viaSemanticFallback).toEqual(viaKeyword);

    const viaKeywordEmpty = await mem.recallObservations('th', '   ');
    const viaSemanticFallbackEmpty = await mem.recallObservationsSemantic('th', '   ');
    expect(viaSemanticFallbackEmpty).toEqual(viaKeywordEmpty);
  });

  it('createOmRecallTool bound to recallObservationsSemantic gains the semantic path automatically', async () => {
    const storage = new InMemoryStorage();
    const carObs: Observation = { id: 'obs-0', text: 'The user owns a car.', createdAt: Date.now(), sourceIds: ['0'], level: 0, fromSeq: 0, toSeq: 3, threadId: 'th' };
    await storage.memory.putObservations('th', [carObs]);
    const store = new FakeVectorStore();
    await store.upsert([{ id: 'om:th:0:0', text: carObs.text, embedding: fakeEmbedOne(carObs.text), metadata: { threadId: 'th', level: 0, fromSeq: 0, toSeq: 3, obsId: 'obs-0' } }]);
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel({ calls: 0 }), omVectors: { store, embed: countingFakeEmbed({ calls: 0 }) } } });

    const tools = createOmRecallTool({
      recall: (query) => mem.recallObservationsSemantic('th', query),
      expand: (fromSeq, toSeq) => mem.expandObservation('th', fromSeq, toSeq),
    });
    const result = await tools.recallObservations.execute({ query: 'vehicle' }, {} as any); // no substring match, semantic hit
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe('obs-0');
  });
});
