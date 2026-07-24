// AUDIT A3: markRunTainted used to SWALLOW a write failure. The common shape is a single untrusted fetch
// then act — no "next" untrusted output to retry the mark — so one transient blip left the run
// permanently un-tainted and the injection defense disarmed. It now retries and, on final failure,
// surfaces the loss LOUDLY (without throwing — the mark runs at the untrusted tool's invocation, so
// throwing would kill that tool).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { markRunTainted, readRunTaint } from '../src/taint.js';

afterEach(() => vi.restoreAllMocks());

describe('markRunTainted (audit A3)', () => {
  it('A3: retries a transient write failure instead of silently swallowing', async () => {
    const store = new Map<string, unknown>();
    let attempts = 0;
    const journal: any = {
      get: async (k: string) => store.get(k),
      putIfAbsent: async (k: string, v: unknown) => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        if (store.has(k)) return false;
        store.set(k, v);
        return true;
      },
      put: async (k: string, v: unknown) => { store.set(k, v); },
    };
    await markRunTainted(journal, 'r1', { toolCallId: 'c', toolName: 'fetch', source: 'tool' });
    expect(attempts).toBeGreaterThanOrEqual(3); // did not give up after the first failure
    expect(await readRunTaint(journal, 'r1')).toMatchObject({ toolName: 'fetch' }); // eventually persisted
  });

  it('A3: a permanent write failure is surfaced LOUDLY (not swallowed) and does not throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const journal: any = {
      get: async () => undefined,
      putIfAbsent: async () => { throw new Error('storage down'); },
      put: async () => { throw new Error('storage down'); },
    };
    await expect(
      markRunTainted(journal, 'r2', { toolCallId: 'c', toolName: 'fetch', source: 'tool' }),
    ).resolves.toBeUndefined(); // does not throw — must not kill the run
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('DISARMED');
  });
});
