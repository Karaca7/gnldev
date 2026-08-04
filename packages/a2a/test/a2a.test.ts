// Phase 12 — @gnldev/a2a: in-process remote server (createRestApi). (1) deterministic runId → remote idempotent
// (same toolCallId two calls → remote charge 1); (2) parent runDurable + resume → remote call SKIPPED.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { createRestApi } from '@gnldev/server';
import { createA2ATool, StepTimeoutError } from '../src/index.js';
import { call } from './call.js';

function chargeModel(counter: { gen: number }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'remote',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      counter.gen++;
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'rc', toolName: 'charge', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'charged' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

function remoteServer(a2aSecret?: string) {
  const journal = new InMemoryJournal();
  const remote = { charges: 0, gen: 0 };
  const app = createRestApi(
    {
      journal,
      agents: { billing: { model: chargeModel(remote), tools: { charge: { execute: async () => ({ charged: (remote.charges++, 20) }) } }, maxSteps: 6 } },
    },
    a2aSecret ? { a2aSecret } : {},
  );
  const fetchImpl = ((url: any, init: any) => call(app, String(url), init)) as unknown as typeof fetch;
  return { remote, fetchImpl };
}

describe('@gnldev/a2a', () => {
  it('deterministic runId → remote idempotent (same toolCallId two calls → charge 1)', async () => {
    const { remote, fetchImpl } = remoteServer();
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });

    const r1 = await t.execute!({ task: 'charge' }, { toolCallId: 'c1' } as any);
    expect(r1.text).toContain('charged');
    expect(remote.charges).toBe(1);
    const gen1 = remote.gen;

    const r2 = await t.execute!({ task: 'charge' }, { toolCallId: 'c1' } as any); // SAME toolCallId → same remote runId
    expect(r2.text).toContain('charged');
    expect(remote.charges).toBe(1); // remote run replay → charge not repeated
    expect(remote.gen).toBe(gen1); // even the remote model was not re-consumed (idempotent)
  });

  it('parent runDurable + resume → remote A2A call SKIPPED (handoff exactly-once)', async () => {
    const { remote, fetchImpl } = remoteServer();
    const parentJournal = new InMemoryJournal();
    const askRemote = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });

    const parentModel = () => ({
      specificationVersion: 'v2' as const,
      provider: 'mock',
      modelId: 'parent',
      supportedUrls: {},
      doGenerate: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'p1', toolName: 'askRemote', input: JSON.stringify({ task: 'charge' }) }], finishReason: 'tool-calls' as const, usage, warnings: [] };
        return { content: [{ type: 'text', text: 'parent done' }], finishReason: 'stop' as const, usage, warnings: [] };
      },
      doStream: async () => {
        throw new Error('no stream');
      },
    });

    await runDurable({ runId: 'parent', journal: parentJournal, model: parentModel(), tools: { askRemote }, prompt: 'route' });
    expect(remote.charges).toBe(1);
    const gen1 = remote.gen;

    // Re-run the parent with the same runId (resume) → askRemote tool replays from parent journal → NO remote call.
    await runDurable({ runId: 'parent', journal: parentJournal, model: parentModel(), tools: { askRemote }, prompt: 'route' });
    expect(remote.charges).toBe(1); // no repeated remote charge
    expect(remote.gen).toBe(gen1); // remote server never called (parent memoize)
  });

  // K3 — no silent wrong result: error/timeout/malformed response THROWS ({ text: undefined } is not returned as success).
  it('non-2xx response (500) → throws an error with message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'internal server exploded' }), { status: 500, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'e1' } as any)).rejects.toThrow(/HTTP 500.*internal server exploded/);
  });

  it('non-2xx + non-JSON body → throws an error with text excerpt', async () => {
    const fetchImpl = (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'e2' } as any)).rejects.toThrow(/HTTP 502.*Bad Gateway/);
  });

  it('timeout → throws an error with a clear message', async () => {
    // fetchImpl respects the abort signal but never returns a response → AbortSignal.timeout fires.
    const fetchImpl = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl, timeoutMs: 20 });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'e3' } as any)).rejects.toThrow(/timed out \(20ms\)/);
  });

  it('malformed response (no text field) → throws an error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'e4' } as any)).rejects.toThrow(/does not match expected shape/);
  });

  it('200 response that cannot be JSON-parsed → throws an error', async () => {
    const fetchImpl = (async () => new Response('this is not json', { status: 200 })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'e5' } as any)).rejects.toThrow(/does not match expected shape/);
  });

  it('interrupted response (text empty, interrupts populated) → does not throw (HITL path no regression)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, interrupts: [{ toolName: 'pay' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    const r = await t.execute!({ task: 'charge' }, { toolCallId: 'e6' } as any);
    expect(r.interrupts).toHaveLength(1);
  });

  // TASK (audit: A2A unsigned) — HMAC signing round-trip + error paths.
  it('when secret is provided, signed request round-trips successfully (in-process app.request)', async () => {
    const { remote, fetchImpl } = remoteServer('shared-secret');
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl, secret: 'shared-secret' });
    const r = await t.execute!({ task: 'charge' }, { toolCallId: 'sig-ok' } as any);
    expect(r.text).toContain('charged');
    expect(remote.charges).toBe(1);
  });

  it('request signed with wrong secret → remote server returns 401 → throws an error', async () => {
    const { fetchImpl } = remoteServer('server-secret');
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl, secret: 'wrong-secret' });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'sig-bad' } as any)).rejects.toThrow(/HTTP 401/);
  });

  it('server expects a2aSecret but tool did not provide a secret → 401', async () => {
    const { fetchImpl } = remoteServer('server-secret');
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl }); // no secret
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'sig-missing' } as any)).rejects.toThrow(/HTTP 401/);
  });

  it('if secret is not provided, old behavior is preserved: unsigned request succeeds when server has no a2aSecret (no regression)', async () => {
    const { remote, fetchImpl } = remoteServer(); // no a2aSecret
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl }); // no secret
    const r = await t.execute!({ task: 'charge' }, { toolCallId: 'sig-none' } as any);
    expect(r.text).toContain('charged');
    expect(remote.charges).toBe(1);
  });

  // 1.4: optional budget/quota hook — if not provided, old behavior; if provided and exceeded, remote call is NOT made.
  it('if budgetGuard is not provided, behavior is UNCHANGED (no regression)', async () => {
    const { remote, fetchImpl } = remoteServer();
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });
    const r = await t.execute!({ task: 'charge' }, { toolCallId: 'bg-none' } as any);
    expect(r.text).toContain('charged');
    expect(remote.charges).toBe(1);
  });

  it('if budgetGuard throws on overage: remote fetch is NEVER called, error propagates as-is', async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = createA2ATool({
      endpoint: 'http://a2a.local',
      agentName: 'billing',
      fetchImpl,
      budgetGuard: () => {
        throw new Error('budget/quota exceeded');
      },
    });
    await expect(t.execute!({ task: 'charge' }, { toolCallId: 'bg-over' } as any)).rejects.toThrow(/budget\/quota exceeded/);
    expect(fetchCalled).toBe(false);
  });

  it('if budgetGuard passes (does not throw): remote call proceeds normally', async () => {
    const { remote, fetchImpl } = remoteServer();
    let guardCalled = false;
    const t = createA2ATool({
      endpoint: 'http://a2a.local',
      agentName: 'billing',
      fetchImpl,
      budgetGuard: async (ctx) => {
        guardCalled = true;
        expect(ctx.agentName).toBe('billing');
        expect(ctx.task).toBe('charge');
      },
    });
    const r = await t.execute!({ task: 'charge' }, { toolCallId: 'bg-ok' } as any);
    expect(guardCalled).toBe(true);
    expect(r.text).toContain('charged');
    expect(remote.charges).toBe(1);
  });

  // K3/timeout — error aligned with @gnldev/durable's StepTimeoutError contract (name/detail shape).
  it('timeout error is thrown in StepTimeoutError shape (name/detail)', async () => {
    const fetchImpl = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl, timeoutMs: 20 });
    try {
      await t.execute!({ task: 'charge' }, { toolCallId: 'to1' } as any);
      expect.unreachable('expected a timeout error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(StepTimeoutError);
      expect(e.name).toBe('StepTimeoutError');
      expect(e.detail).toMatchObject({ label: 'a2a:billing', timeoutMs: 20 });
    }
  });

  // runId collision fix — options.idempotencyKey (injected by @gnldev/durable's durableTool) is
  // parent-run-scoped and globally unique; it must be preferred over the raw toolCallId, which is
  // only unique WITHIN a single run and can collide across DIFFERENT runs (e.g. providers that use
  // short ids like 'call_1').
  it('two different parents with the SAME toolCallId but DIFFERENT idempotencyKey → two DIFFERENT remote runIds (no collision)', async () => {
    const seenRunIds: string[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      seenRunIds.push(JSON.parse(String(init.body)).runId);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });

    await t.execute!({ task: 'charge' }, { toolCallId: 'call_1', idempotencyKey: 'parentA:call_1' } as any);
    await t.execute!({ task: 'charge' }, { toolCallId: 'call_1', idempotencyKey: 'parentB:call_1' } as any); // SAME toolCallId, DIFFERENT parent

    expect(seenRunIds).toEqual(['a2a:parentA:call_1', 'a2a:parentB:call_1']);
    expect(seenRunIds[0]).not.toBe(seenRunIds[1]);
  });

  it('same parent + same idempotencyKey called again → SAME remote runId (determinism/idempotency preserved)', async () => {
    const seenRunIds: string[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      seenRunIds.push(JSON.parse(String(init.body)).runId);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });

    await t.execute!({ task: 'charge' }, { toolCallId: 'call_1', idempotencyKey: 'parentA:call_1' } as any);
    await t.execute!({ task: 'charge' }, { toolCallId: 'call_1', idempotencyKey: 'parentA:call_1' } as any); // same parent, replay

    expect(seenRunIds).toEqual(['a2a:parentA:call_1', 'a2a:parentA:call_1']);
  });

  it('no idempotencyKey (bare AI SDK loop, no durableTool) → falls back to `a2a:<toolCallId>` (backward compatible)', async () => {
    const seenRunIds: string[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      seenRunIds.push(JSON.parse(String(init.body)).runId);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const t = createA2ATool({ endpoint: 'http://a2a.local', agentName: 'billing', fetchImpl });

    await t.execute!({ task: 'charge' }, { toolCallId: 'raw1' } as any); // no idempotencyKey

    expect(seenRunIds).toEqual(['a2a:raw1']);
  });
});
