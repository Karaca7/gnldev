// M1 downstream exactly-once: durableTool, tool execute'a stabil idempotencyKey enjekte eder
// (a tool can forward this to an external payment/HTTP API as an Idempotency-Key).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';

describe('M1 idempotencyKey', () => {
  it('execute icine (runId:toolCallId) stabil key gelir', async () => {
    const journal = new InMemoryJournal();
    let seen = '';
    const dt = durableTool(
      { execute: async (_args: any, opts: any) => { seen = opts.idempotencyKey; return 'ok'; } },
      { journal, runId: 'r1' },
      'pay',
    );
    await dt.execute!({ amount: 5 }, { toolCallId: 'call-9' });
    expect(seen).toBe('r1:call-9');
  });
});
