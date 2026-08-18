// A collector that accepts the connection and then never answers.
//
// Every retry test in otlp.test.ts stubs a fetch that SETTLES — a status or a throw. Both are the easy
// shapes. The one an unhealthy collector actually produces is neither: the socket is accepted and then
// nothing comes back — a wedged process, a load balancer with no backend, a receiver mid-restart.
// `fetch` has no default timeout, so that attempt never settles.
//
// `fetchWithRetry` counts ATTEMPTS, and an attempt that never finishes is never a failure, so the
// backoff configured for exactly this situation never got to run: the option that exists to survive an
// unhealthy collector was disabled by one particular kind of unhealthy, and the export simply never
// returned. Measured before the bound, against the socket below, `exportRunToOtlp` was still pending
// after 20 seconds with no reason to ever finish.
//
// Why a real socket and not a stub: nothing about a hang is expressible as a mocked fetch. A stub that
// never resolves would hang the test runner instead of the code under test, proving only that a promise
// can be left pending.
//
// Why its own file: otlp.test.ts is built around `vi.stubGlobal('fetch', …)` and fake timers. This test
// needs the real fetch and real timers, and run inside that file it did not get them — the export hung
// there while passing in isolation. Rather than keep adding restore calls until the interference
// happened to clear, the test that must not be interfered with lives apart from the machinery.
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { InMemoryJournal } from '@gnldev/durable';
import { exportRunToOtlp } from '../src/otlp.js';

/** Enough of a run for the exporter to have a span to send — no model, no runDurable, no wall time. */
async function seeded(runId: string): Promise<InMemoryJournal> {
  const journal = new InMemoryJournal();
  await journal.put(`${runId}:input`, { prompt: 'x' });
  await journal.put(`${runId}:model:0`, {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    response: { modelId: 'gpt-test' },
  });
  return journal;
}

/** Accepts the TCP connection, reads whatever is sent, and replies with nothing, ever. */
async function blackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((s) => { s.on('data', () => { /* swallow */ }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('exportRunToOtlp against an endpoint that never answers', () => {
  it('returns instead of hanging forever', async () => {
    const black = await blackHole();
    try {
      const journal = await seeded('bh-1');
      const started = Date.now();
      const call = exportRunToOtlp(journal, 'bh-1', {
        endpoint: `http://127.0.0.1:${black.port}/v1/traces`,
        timeoutMs: 200,
      }).then(() => 'RESOLVED' as const, (e) => e as Error);

      const outcome = await Promise.race([
        call,
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 5_000)),
      ]);
      await call.catch(() => { });

      expect(outcome, 'the export never returned — this is the pre-fix behaviour').not.toBe('HUNG');
      // It fails as a timeout, not as some unrelated error that happens to end the wait.
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('TimeoutError');
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await black.close();
    }
  });

  it('bounds each ATTEMPT, so a configured retry still runs', async () => {
    // The part that makes `retry` meaningful again. A single signal shared across the whole retry loop
    // would abort the second attempt before it began — the call would return, and the backoff would
    // still be dead. Two attempts of 200ms each cannot fit in less than 400ms, which is what separates
    // "bounded per attempt" from "bounded overall".
    const black = await blackHole();
    try {
      const journal = await seeded('bh-2');
      const started = Date.now();
      const call = exportRunToOtlp(journal, 'bh-2', {
        endpoint: `http://127.0.0.1:${black.port}/v1/traces`,
        timeoutMs: 200,
        retry: { attempts: 2, backoffMs: 0 },
      }).then(() => 'RESOLVED' as const, (e) => e as Error);

      const outcome = await Promise.race([
        call,
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 8_000)),
      ]);
      await call.catch(() => { });
      const elapsed = Date.now() - started;

      expect(outcome).not.toBe('HUNG');
      expect((outcome as Error).name).toBe('TimeoutError');
      expect(elapsed, 'the second attempt was aborted by the first attempt\'s signal').toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await black.close();
    }
  });
});
