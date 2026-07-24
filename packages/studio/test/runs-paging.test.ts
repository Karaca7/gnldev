// S4 pagination: GET /runs?limit=&cursor= → a Page envelope (newest first); no parameters → a flat array (backward-compatible).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

/** Seeds N ordered runs (journal append order = oldest → newest). */
async function seedRuns(journal: InMemoryJournal, n: number) {
  for (let i = 1; i <= n; i++) {
    await journal.put(`run-${i}:model:0`, { content: [{ type: 'text', text: `answer ${i}` }], finishReason: 'stop' });
  }
}

describe('GET /runs pagination', () => {
  it('returns a Page envelope when limit is given: newest first, nextCursor + total', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 5);
    const app = createStudioApi({ reader: journal });

    const p1 = await (await app.request('/runs?limit=2')).json();
    expect(p1.total).toBe(5);
    expect(p1.items.map((r: { runId: string }) => r.runId)).toEqual(['run-5', 'run-4']);
    expect(p1.nextCursor).toBe('2');

    const p2 = await (await app.request(`/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((r: { runId: string }) => r.runId)).toEqual(['run-3', 'run-2']);
    expect(p2.nextCursor).toBe('4');

    const p3 = await (await app.request(`/runs?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.items.map((r: { runId: string }) => r.runId)).toEqual(['run-1']);
    expect(p3.nextCursor).toBeUndefined(); // last page
  });

  it('page items carry threadId (from the run\'s :input entry); absent if there is none', async () => {
    // For grouping by thread: durable persistInput stamps threadId onto `:input`; /runs reads it.
    const journal = new InMemoryJournal();
    await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('run-1:input', { prompt: 'hi', threadId: 'th-9', _v: 1 });
    await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' }); // no :input
    const app = createStudioApi({ reader: journal });

    const p = await (await app.request('/runs?limit=10')).json();
    const byId = Object.fromEntries(p.items.map((r: any) => [r.runId, r]));
    expect(byId['run-1'].threadId).toBe('th-9');
    expect(byId['run-2'].threadId).toBeUndefined(); // falls into the ungrouped bucket
  });

  it('a call without parameters returns a backward-compatible flat array', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/runs')).json();
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
  });

  it('malformed limit/cursor values fall back to safe defaults', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    // limit=abc → clamped to a minimum of 1; cursor=-5 → clamped to 0
    const res = await (await app.request('/runs?limit=abc&cursor=-5')).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].runId).toBe('run-3');
    expect(res.total).toBe(3);
  });
});
