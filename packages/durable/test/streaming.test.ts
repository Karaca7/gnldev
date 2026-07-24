import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { createMockStreamModel } from './mock.js';

async function collect(stream: any): Promise<any[]> {
  const out: any[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe('streaming replay — withDurableModel.wrapStream', () => {
  it('records, then replays (second time the underlying doStream is not called)', async () => {
    const journal = new InMemoryJournal();
    const parts = [
      { type: 'text-delta', id: '0', delta: 'Hello' },
      { type: 'text-delta', id: '0', delta: ' world' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const counter = { calls: 0 };
    const model = createMockStreamModel(parts, counter);

    // Call 1 — record
    const m1 = withDurableModel(model, { journal, runId: 'r1' });
    const r1 = await (m1 as any).doStream({ prompt: [] });
    const got1 = await collect(r1.stream);
    expect(counter.calls).toBe(1);
    expect(got1).toEqual(parts);

    // Call 2 — new instance, same runId/journal → REPLAY from the journal
    const m2 = withDurableModel(model, { journal, runId: 'r1' });
    const r2 = await (m2 as any).doStream({ prompt: [] });
    const got2 = await collect(r2.stream);
    expect(counter.calls).toBe(1); // DID NOT increase → underlying was not called
    expect(got2).toEqual(parts);
  });
});
