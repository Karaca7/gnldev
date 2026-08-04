// GET /runs/:id/memory-context — the ':memctx' provenance record durable freezes next to ':input'
// (see run.ts persistMemoryContext): recall hits with similarity, recent-window count, WM/OM, and
// the echo-trim counters. Contract: `null` (not an error) for runs without a record — old runs,
// memory-less runs, read-only journals.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('GET /runs/:id/memory-context', () => {
  it('serves the frozen provenance record', async () => {
    const journal = new InMemoryJournal();
    const rec = {
      v: 1, threadId: 'th-1',
      recalled: [{ threadId: 'th-1', seq: 4, role: 'user', preview: 'refund policy…', score: 0.87 }],
      recentCount: 6, workingMemoryChars: 42, incomingCount: 1, echoTrimmed: 2,
    };
    await journal.put(runKeys.memoryContext('r1'), rec);

    const app = createStudioApi({ reader: journal });
    const res = await call(app, '/runs/r1/memory-context');
    expect(res.status).toBe(200);
    expect((await res.json()).context).toEqual(rec);
  });

  it('no record → { context: null }, still 200', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await call(app, '/runs/unknown/memory-context');
    expect(res.status).toBe(200);
    expect((await res.json()).context).toBeNull();
  });
});
