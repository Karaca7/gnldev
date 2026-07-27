// Recall provenance: the similarity score used to RANK a recall hit now survives to the caller
// (MessageRecord.score, stamped per-call by the storage adapters) and loadContext exposes the full
// "where did this context come from" breakdown (LoadedContext.provenance) — the memory-side half of
// the ':memctx' journal record durable freezes per run. Before this, every adapter computed the
// score and dropped it at the return boundary (a gap comparable pipelines still have).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const DIMS = ['refund', 'shipping', 'weather', 'joke'];
const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1);
};
const u = (content: string) => ({ role: 'user', content });

describe('recall provenance', () => {
  it('adapter recall stamps the similarity on HITS; messageRange neighbors ride unscored', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 2, recall: { topK: 1, messageRange: 1 } });
    await mem.append('t', [u('refund policy here'), u('filler neighbor'), u('weather talk'), u('recent a'), u('recent b')]);

    const recalled = await storage.memory.recall('t', await embed('refund'), { topK: 1, messageRange: 1, scope: 'thread' });
    const hit = recalled.find((r) => r.text?.includes('refund policy'));
    const neighbor = recalled.find((r) => r.text?.includes('filler neighbor'));
    expect(hit?.score).toBeGreaterThan(0);
    expect(neighbor?.score).toBeUndefined();
  });

  it('loadContext.provenance: recall refs (seq/preview/score) + recentCount + WM chars', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({
      storage, embed, recentN: 2, recall: { topK: 1 },
      workingMemory: { enabled: true },
    });
    await mem.append('th', [u('refund policy is thirty days'), u('filler one'), u('filler two'), u('recent a'), u('recent b')]);
    await mem.setWorkingMemory('th', 'user prefers refunds in store credit');

    const ctx = await mem.loadContext('th', { query: 'refund' });
    const prov = ctx.provenance!;
    expect(prov.recentCount).toBe(2);
    // The window refs themselves — "what went to the model", not just how many.
    expect(prov.recent?.map((r) => r.preview)).toEqual(['recent a', 'recent b']);
    expect(prov.recalled.length).toBe(1);
    expect(prov.recalled[0]).toMatchObject({ threadId: 'th', seq: 0, role: 'user' });
    expect(prov.recalled[0]!.preview).toContain('refund policy');
    expect(prov.recalled[0]!.score).toBeGreaterThan(0);
    expect(prov.workingMemoryChars).toBeGreaterThan(0);
    // The provenance refs point at exactly the messages that were actually injected.
    expect(JSON.stringify(ctx.messages)).toContain('refund policy');
  });

  it('no query / no embed → empty recall provenance, recentCount = the served window', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, recentN: 3 });
    await mem.append('th2', [u('a'), u('b')]);
    const ctx = await mem.loadContext('th2', {});
    expect(ctx.provenance).toMatchObject({ recalled: [], recentCount: 2 });
  });

  it('getMessages public behavior is unchanged by the provenance refactor', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 2, recall: { topK: 1 } });
    await mem.append('t3', [u('refund policy old'), u('filler'), u('recent a'), u('recent b')]);
    const msgs = await mem.getMessages('t3', { query: 'refund' });
    // recalled-first then recent — the pre-refactor contract.
    expect(msgs.length).toBe(3);
    expect(JSON.stringify(msgs[0])).toContain('refund policy');
    expect(JSON.stringify(msgs[2])).toContain('recent b');
  });
});
