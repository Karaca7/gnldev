import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';

describe('guard (general policy) — allow/deny', () => {
  it('deny → execute is not called, denial output is returned', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      { execute: async () => { calls++; return 'ran'; } },
      { journal, runId: 'r1', guard: async () => ({ action: 'deny', reason: 'forbidden' }) },
      'dangerous',
    );

    const out: any = await dt.execute!({}, { toolCallId: 'c1' });

    expect(calls).toBe(0);
    expect(out.__denied).toBe(true);
    expect(out.reason).toBe('forbidden');
  });

  it('allow → runs normally', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      { execute: async () => { calls++; return 'ran'; } },
      { journal, runId: 'r1', guard: async () => ({ action: 'allow' }) },
      't',
    );

    const out = await dt.execute!({}, { toolCallId: 'c1' });

    expect(calls).toBe(1);
    expect(out).toBe('ran');
  });

  it('toolName is passed to guard; deny decision is journaled → replay produces the same denial', async () => {
    const journal = new InMemoryJournal();
    let guardCalls = 0;
    let seenName = '';
    const guard = async ({ toolName }: any) => {
      guardCalls++;
      seenName = toolName;
      return { action: 'deny' as const, reason: 'x' };
    };
    const dt = durableTool({ execute: async () => 'ran' }, { journal, runId: 'r1', guard }, 'refund');

    const out1: any = await dt.execute!({}, { toolCallId: 'c1' });
    const out2: any = await dt.execute!({}, { toolCallId: 'c1' }); // replay

    expect(seenName).toBe('refund');
    expect(out1.__denied).toBe(true);
    expect(out2.__denied).toBe(true);
    expect(guardCalls).toBe(1); // 2nd call returned from journal, guard did not run again
  });
});
