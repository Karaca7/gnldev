// The status the CALLER sees when the provider fails.
//
// The classifier has its own unit tests; this asks the only question that matters at the edge —
// does the endpoint actually answer with it. Measured before the fix on a live rig: a free provider
// answering 429 reached the caller as `400 {"error":"Failed after 3 attempts. Last error: Too Many
// Requests"}`, and a client with retry logic reads 400 as "never retry" at the exact moment it
// should wait.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

/** A model that fails the way a rate-limited provider fails, wrapper and all. */
function throwingModel(err: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'test',
    modelId: 'm',
    supportedUrls: {},
    async doGenerate() { throw err; },
    async doStream() { throw err; },
  };
}

function rateLimited() {
  const inner = Object.assign(new Error('Too Many Requests'), {
    name: 'AI_APICallError',
    statusCode: 429,
    responseHeaders: { 'retry-after': '12' },
  });
  return Object.assign(new Error('Failed after 3 attempts. Last error: Too Many Requests'), {
    name: 'AI_RetryError', lastError: inner, errors: [inner],
  });
}

function api(err: unknown) {
  return createRestApi({
    journal: new InMemoryJournal(),
    agents: { a: { model: throwingModel(err) as never, maxSteps: 1 } },
  });
}

const run = (h: ReturnType<typeof createRestApi>, runId: string) =>
  call(h, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, prompt: 'selam' }),
  });

describe('provider failures reach the caller as themselves', () => {
  it('a rate limit answers 429 with Retry-After, not 400', async () => {
    const res = await run(api(rateLimited()), 'r1');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    const body = await res.json() as { code?: string; retryAfter?: number };
    expect(body.code).toBe('upstream_rate_limited');
    expect(body.retryAfter).toBe(12);
  });

  it('a rejected operator credential answers 502, never 401', async () => {
    // 401 would tell the caller to fix an API key it has never seen and cannot reach.
    const err = Object.assign(new Error('Unauthorized'), { name: 'AI_APICallError', statusCode: 401 });
    const res = await run(api(err), 'r2');
    expect(res.status).toBe(502);
    expect((await res.json() as { code?: string }).code).toBe('upstream_unauthorized');
  });

  it('an upstream outage answers 502', async () => {
    const err = Object.assign(new Error('Bad Gateway'), { name: 'AI_APICallError', statusCode: 503 });
    const res = await run(api(err), 'r3');
    expect(res.status).toBe(502);
  });

  it('a genuinely malformed request still answers 400', async () => {
    // The taxonomy must not swallow the caller's own mistakes: no runId is the caller's problem.
    const res = await call(api(rateLimited()), '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'selam' }),
    });
    expect(res.status).toBe(400);
  });

  it('an error that is ours keeps its own status', async () => {
    // A plain failure inside the agent is not an upstream failure — it must not become a 502.
    const res = await run(api(new Error('boom')), 'r4');
    expect(res.status).toBe(400);
    expect((await res.json() as { code?: string }).code).toBeUndefined();
  });
});

describe('an empty answer says so', () => {
  /** What the free provider actually returned: a response with no content and finishReason 'unknown'. */
  function emptyModel() {
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      specificationVersion: 'v2' as const, provider: 'test', modelId: 'm', supportedUrls: {},
      async doGenerate() { return { content: [], finishReason: 'unknown' as never, usage, warnings: [] }; },
      async doStream() { throw new Error('not used'); },
    };
  }

  it('reports finishReason, so empty-because-nothing-came is not empty-because-nothing-to-say', async () => {
    // Both answer 200 with `text: ""`. Without finishReason on the wire they are the same response,
    // and the caller cannot tell a provider that failed to answer from a model that chose not to.
    // Measured in the field: an empty response was journaled as a completed run and the screen sat
    // waiting, because nothing in the reply said anything had gone wrong.
    const h = createRestApi({
      journal: new InMemoryJournal(),
      agents: { a: { model: emptyModel() as never, maxSteps: 1 } },
    });
    const res = await run(h, 'empty-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { text?: string; finishReason?: string };
    expect(body.text).toBe('');
    expect(body.finishReason).toBe('unknown');
  });
});
