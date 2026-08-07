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

describe('guard — the denial names the tool it refused', () => {
  it('journals toolName on a denied record', async () => {
    // The entry an auditor most needs to identify used to carry the least: the key held the
    // toolCallId, the output held `{__denied, reason}`, and the name appeared nowhere — answering
    // "what was refused" meant correlating against the model step.
    const journal = new InMemoryJournal();
    const dt = durableTool(
      { execute: async () => 'ran' },
      { journal, runId: 'r1', guard: async () => ({ action: 'deny', reason: 'forbidden' }) },
      'dangerous',
    );
    await dt.execute!({}, { toolCallId: 'c1' });

    const rec = await journal.get<{ status: string; toolName?: string }>('r1:tool:c1');
    expect(rec?.status).toBe('denied');
    expect(rec?.toolName).toBe('dangerous');
  });

  it('a record written before the field existed still replays', async () => {
    // Backward compatibility, asserted rather than assumed: `toolName` is optional, so a journal
    // written by an older version has denied records without it. Replay must serve the SAME output
    // from that record and must NOT re-run the tool — the field's absence is not a cache miss.
    const journal = new InMemoryJournal();
    await journal.put('r-old:tool:c1', { status: 'denied', output: { __denied: true, reason: 'eski' } });

    let calls = 0;
    const dt = durableTool(
      { execute: async () => { calls++; return 'ran'; } },
      { journal, runId: 'r-old', guard: async () => ({ action: 'allow' }) },
      'dangerous',
    );
    const out: any = await dt.execute!({}, { toolCallId: 'c1' });

    expect(calls).toBe(0);
    expect(out.__denied).toBe(true);
    expect(out.reason).toBe('eski');
  });
});
