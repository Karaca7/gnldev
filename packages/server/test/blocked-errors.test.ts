// K1 — auto-REST's blocked errors (SideEffectRetryBlockedError/RunBusyError/RetryLimitExceededError)
// verify that when thrown from runDurable, /run and /resume now return a machine-readable
// {code,resumable} body (consistent with BLOCKED_CODES on the SSE path (sse.ts) — see review finding A).
// Previously these errors fell through to a generic 400 (no code/detail/resumable).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '@gnl/durable';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Produces a chargeCard tool-call with toolCallId 'call-1' on every call (same pattern as durable/test/blocked-sentinel.test.ts). */
function stubbornModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) }],
      finishReason: 'tool-calls',
      usage,
      warnings: [],
    }),
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('@gnl/server — K1 blocked errors (side_effect_retry_blocked/run_busy)', () => {
  it('/run: unapproved side-effect retry (failed record) → 409 + code=side_effect_retry_blocked + resumable:true', async () => {
    const journal = new InMemoryJournal();
    // chargeCard has a side effect (NOT idempotent): a prior 'failed' record is NOT auto-retried without approval.
    await journal.put(runKeys.tool('r1', 'call-1'), { status: 'failed', error: 'timeout', attempts: 1 });
    let charges = 0;
    const api = createRestApi({
      journal,
      agents: {
        pay: {
          model: stubbornModel(),
          tools: { chargeCard: { execute: async () => { charges++; return { charged: 20 }; } } as any },
        },
      },
    });

    const res = await api.request('/agents/pay/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'process a refund' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('side_effect_retry_blocked');
    expect(body.resumable).toBe(true);
    expect(charges).toBe(0); // NO double charge — tool never executed
  });

  it('/resume: concurrent execution (fresh running record) → 409 + code=run_busy + resumable:true', async () => {
    const journal = new InMemoryJournal();
    // /resume reads the input from the journal → :input must be seeded first (server/src/index.ts resume route).
    await journal.put(runKeys.input('r2'), { prompt: 'process a refund' });
    // Fresh 'running' record (within the claim TTL) → treated as another executor still running.
    await journal.put(runKeys.tool('r2', 'call-1'), { status: 'running', startedAt: Date.now() });
    const api = createRestApi({
      journal,
      agents: {
        pay: {
          model: stubbornModel(),
          tools: { chargeCard: { execute: async () => ({ charged: 20 }) } as any },
        },
      },
    });

    const res = await api.request('/agents/pay/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r2', approvals: {} }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('run_busy');
    expect(body.resumable).toBe(true);
  });
});
