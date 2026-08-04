// TASK W1: per-run cost ceiling as a server-side UPPER BOUND (opt-in). The `limits` in the request
// body (client request) CANNOT EXCEED `opts.limits` (server ceiling) — see server/src/index.ts `clampLimits`.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(tokens = 15): any {
  let step = 0;
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      step++;
      return {
        content: [{ type: 'text', text: `step ${step}` }],
        finishReason: 'stop',
        usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens },
        warnings: [],
      };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

const run = (api: any, runId: string, limits?: any) =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, prompt: 'hi', ...(limits ? { limits } : {}) }),
  });

describe('@gnldev/server run-limits (TASK W1)', () => {
  it('server ceiling (opts.limits) is enforced: a request exceeding it gets 422 + machine-readable body (Decision #1)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(15) } } },
      { limits: { maxTokens: 10 } }, // server ceiling — even a single step (15 tokens) exceeds it
    );
    const res = await run(api, 'r1');
    expect(res.status).toBe(422); // NOT 429 (the SDK auto-retries), NOT 402 (that's specific to org budgets)
    const body = await res.json();
    expect(body.error).toContain('maxTokens');
    expect(body.code).toBe('run_limit_exceeded');
    expect(body.detail).toMatchObject({ kind: 'maxTokens', limit: 10 });
    expect(body.resumable).toBe(true); // remediation: raise limits + resume with the SAME runId
  });

  it('a client limit CANNOT exceed the server ceiling: server ceiling holds even if the client sends a looser limit', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(15) } } },
      { limits: { maxTokens: 10 } }, // server: 10
    );
    // The client wants a MUCH looser limit (1_000_000) — it CANNOT relax the server ceiling.
    const res = await run(api, 'r2', { maxTokens: 1_000_000 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('maxTokens');
    expect(body.code).toBe('run_limit_exceeded');
  });

  it('the client may request a STRICTER limit than the server ceiling (tightening is allowed)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(15) } } },
      { limits: { maxTokens: 1000 } }, // server is loose
    );
    // The client requests a stricter limit (5) — a single step (15 tokens) exceeds this too.
    const res = await run(api, 'r3', { maxTokens: 5 });
    expect(res.status).toBe(422);
  });

  it('when limits are given by neither server nor client: existing behavior is preserved (200)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: { a: { model: mkModel(15) } } });
    const res = await run(api, 'r4');
    expect(res.status).toBe(200);
  });
});
