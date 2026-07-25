// API-06: /agents/:name/stream must map the SAME error taxonomy as the non-streaming
// /agents/:name/run handler (runErrorResponse) — a run_limit_exceeded/tool_loop_detected/run_busy
// breach thrown BEFORE the SSE body starts must not be flattened into a bare 400. The catch in
// server.ts wraps `await gnl.stream(...)` (the runner's setup call) — this fires strictly BEFORE
// pipeAgentStream() ever touches the response, so a runner that throws synchronously there is a
// faithful stand-in for any pre-stream breach (e.g. streamDurable's run-lock RunBusyError, which
// throws before streamText() is invoked — see run.ts's streamDurable). Errors raised mid-stream
// (after pipeAgentStream has started writing SSE frames) are a DIFFERENT contract, unaffected by
// this fix — they surface as an SSE `error` event (see stream-finish-error.test.ts).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, RunLimitExceededError } from '@gnl/durable';
import { createStudioApp, type StudioAgentRunner } from '../src/server.js';

function runnerThatThrowsOnStream(err: unknown): StudioAgentRunner {
  return {
    listAgents: () => [{ name: 'flaky', model: 'custom', hasTools: false, maxSteps: 6 }],
    run: async () => ({ text: 'unused', interrupts: [] }),
    stream: async () => { throw err; },
  };
}

describe('/agents/:name/stream — error taxonomy parity with /agents/:name/run (API-06)', () => {
  it('a RunLimitExceededError thrown before streaming starts → 422 + code + resumable (NOT a flat 400)', async () => {
    const journal = new InMemoryJournal();
    const err = new RunLimitExceededError("run 'r1' exceeded the maxTokens limit (20) with 30 tokens", {
      kind: 'maxTokens', value: 30, limit: 20,
    });
    const app = createStudioApp({ reader: journal, gnl: runnerThatThrowsOnStream(err) });

    const res = await app.request('/api/agents/flaky/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });

    expect(res.status).toBe(422);
    // Never entered pipeAgentStream — a JSON error body, not an SSE stream.
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    const body = await res.json();
    expect(body.code).toBe('run_limit_exceeded');
    expect(body.resumable).toBe(true);
  });

  it('an error runErrorResponse does NOT recognize keeps the old flat 400 (unchanged fallback)', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApp({ reader: journal, gnl: runnerThatThrowsOnStream(new Error('boom')) });

    const res = await app.request('/api/agents/flaky/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r2', prompt: 'hi' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('boom');
    expect(body.code).toBeUndefined();
  });
});
