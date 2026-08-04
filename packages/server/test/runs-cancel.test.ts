// P0.3 (AUDIT-R2): GET /runs pagination+filters (backward-compat with no params, status
// filter, invalid status → 400) and POST /runs/:id/cancel (aborts the composed AbortSignal reaching
// doStream, org-scoped visibility → 404 across orgs, write-permission gate).
import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

/** A model that always calls `stall` — combined with a require-approval guard below, this produces a
 *  'suspended' run summary (same pattern as server.test.ts's 8.9 suite / sse.test.ts's agentMock). */
function mkSuspendModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'stall', input: JSON.stringify({}) }],
      finishReason: 'tool-calls',
      usage,
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

/** doStream returns a stream that NEVER enqueues/closes anything — captures the abortSignal it was
 *  called with (options.abortSignal, per the AI SDK's model.doStream(options) contract) so the test
 *  can assert POST /runs/:id/cancel actually reaches it. */
function mkNeverEndingStreamModel(captured: { signal?: AbortSignal }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async (options: any) => {
      captured.signal = options.abortSignal;
      return { stream: new ReadableStream({ start() { /* never enqueue, never close */ } }) };
    },
  };
}

const run = (api: any, runId: string, headers: Record<string, string> = {}) =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ runId, prompt: 'hi' }),
  });

describe('@gnldev/server GET /runs (P0.3 pagination + filters)', () => {
  it('no params → EXACTLY the legacy array response (backward compat)', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } });
    await run(api, 'r1');
    await run(api, 'r2');
    const res = await call(api, '/runs');
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: any) => r.runId).sort()).toEqual(['r1', 'r2']);
  });

  it('?status=suspended returns only suspended runs, paged shape {items,nextCursor}', async () => {
    const api = createRestApi({
      journal: new InMemoryJournal(),
      agents: {
        a: { model: mkModel('ok') },
        stall: {
          model: mkSuspendModel(),
          tools: { stall: tool({ description: 'stall', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) },
          guard: () => ({ action: 'require-approval' as const }),
        },
      },
    });
    await run(api, 'done-1');
    await call(api, '/agents/stall/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'susp-1', prompt: 'hi' }),
    });
    const res = await call(api, '/runs?status=suspended');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(body.items.map((r: any) => r.runId)).toEqual(['susp-1']);
    expect(body.items.every((r: any) => r.status === 'suspended')).toBe(true);

    const completed = await (await call(api, '/runs?status=completed')).json();
    expect(completed.items.map((r: any) => r.runId)).toEqual(['done-1']);
  });

  it('?limit clamps to [1,1000]; ?cursor round-trips a page', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } });
    for (let i = 0; i < 3; i++) await run(api, `r${i}`);
    const p1 = await (await call(api, '/runs?limit=2')).json();
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await (await call(api, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect([...p1.items, ...p2.items].map((r: any) => r.runId).sort()).toEqual(['r0', 'r1', 'r2']);
  });

  it('invalid ?status= → 400', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } });
    const res = await call(api, '/runs?status=bogus');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid status/);
  });
});

describe('@gnldev/server POST /runs/:id/cancel (P0.3)', () => {
  it('aborts the composed AbortSignal reaching an in-flight stream generation on this instance', async () => {
    const captured: { signal?: AbortSignal } = {};
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { chat: { model: mkNeverEndingStreamModel(captured) } } });
    const streamRes = await call(api, '/agents/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'never-1', prompt: 'hi' }),
    });
    expect(streamRes.status).toBe(200); // the streaming Response is returned immediately (never-ending body)
    // Hono's streamSSE fires its callback fire-and-forget (NOT awaited before returning the Response) —
    // the mock's doStream() therefore runs a few microtask hops AFTER `await api.request(...)` resolves,
    // not necessarily before it. Poll (no arbitrary sleep) until the mock has captured its abortSignal.
    await vi.waitFor(() => { if (!captured.signal) throw new Error('doStream not yet invoked'); });
    expect(captured.signal!.aborted).toBe(false);

    const cancelRes = await call(api, '/runs/never-1/cancel', { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(1);
    expect(captured.signal!.aborted).toBe(true); // the SAME signal doStream received is now aborted

    // idempotent: cancelling an already-cancelled/unregistered run never errors (200, cancelled may be 0).
    const again = await call(api, '/runs/never-1/cancel', { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('unknown run id / a run belonging to a different organization → 404 (no existence leak)', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { org: {} },
    );
    await run(api, 'r-acme', { 'x-gnl-org': 'acme' });

    const unknown = await call(api, '/runs/does-not-exist/cancel', { method: 'POST' });
    expect(unknown.status).toBe(404);

    // globex cannot see/cancel acme's run — same 404 shape, no existence leak.
    const crossOrg = await call(api, '/runs/r-acme/cancel', { method: 'POST', headers: { 'x-gnl-org': 'globex' } });
    expect(crossOrg.status).toBe(404);

    // acme itself CAN target its own (already-completed, no in-flight controller) run — 200, cancelled:0.
    const ownScope = await call(api, '/runs/r-acme/cancel', { method: 'POST', headers: { 'x-gnl-org': 'acme' } });
    expect(ownScope.status).toBe(200);
    const body = await ownScope.json();
    expect(body).toMatchObject({ ok: true, cancelled: 0 });
  });

  it('a read-only identity is denied (write-permission gate)', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }) },
    );
    const noAuth = await call(api, '/runs/r1/cancel', { method: 'POST' });
    expect(noAuth.status).toBe(403);
    const viewer = await call(api, '/runs/r1/cancel', { method: 'POST', headers: { authorization: 'Bearer viw' } });
    expect(viewer.status).toBe(403);
  });
});
