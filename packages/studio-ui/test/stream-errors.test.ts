// @vitest-environment node
// Bug-investigation fix #3: streamAgent/runWorkflowStream's fetch() is now wrapped in try/catch — a
// network exception no longer leaks out as a raw promise rejection, it's reported through the uniform
// on({type:'error'}) contract. A cancellation (AbortController) stays silent (same behavior as before).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamAgent, runWorkflowStream, type StreamEvent, type WfStreamEvent } from '../src/api';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('streamAgent — fetch network exception (bug investigation #3)', () => {
  it('when fetch throws, does not reject the promise; reports it via on({type:"error"})', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection dropped'); }));
    const events: StreamEvent[] = [];
    await expect(streamAgent('agent1', { runId: 'r1' }, (ev) => events.push(ev))).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'error', data: { error: 'connection dropped' } }]);
  });

  it('stays silent when cancelled via AbortController (on() is not called)', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    const events: StreamEvent[] = [];
    await streamAgent('agent1', { runId: 'r1' }, (ev) => events.push(ev), ac.signal);
    expect(events).toEqual([]);
  });
});

describe('runWorkflowStream — fetch network exception (bug investigation #3)', () => {
  it('when fetch throws, does not reject the promise; reports it via on({type:"error"})', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS error'); }));
    const events: WfStreamEvent[] = [];
    await expect(runWorkflowStream('wf1', {}, 'run-1', (ev) => events.push(ev))).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'error', data: { error: 'DNS error' } }]);
  });

  it('stays silent when cancelled via AbortController (on() is not called)', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    const events: WfStreamEvent[] = [];
    await runWorkflowStream('wf1', {}, 'run-1', (ev) => events.push(ev), ac.signal);
    expect(events).toEqual([]);
  });
});

// API-07: streamAgent/runWorkflowStream's `!res.ok` branch used to build the error event straight
// from `${res.status} ${res.statusText}` and never read the server's {error} JSON body — a
// Playground user hitting e.g. the org-write guard only ever saw "403 Forbidden" instead of the
// real reason. Both SSE helpers now go through the same body-reading logic http() already used
// (errorMessageFromResponse / parseErrorResponse in src/api.ts).
describe('streamAgent — surfaces the server error body on !res.ok (API-07)', () => {
  it('403 { error: "…org context…" } → the error event carries the SERVER text, not "403 Forbidden"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      body: null,
      json: async () => ({ error: "writes are not supported in an org context (v1 read-only audit) — use @gnldev/server's org option for writes" }),
      clone() { return this; },
    })));
    const events: StreamEvent[] = [];
    await streamAgent('demo', { runId: 'r1', prompt: 'hi' }, (ev) => events.push(ev));
    expect(events).toEqual([
      { type: 'error', data: { error: "writes are not supported in an org context (v1 read-only audit) — use @gnldev/server's org option for writes" } },
    ]);
  });

  it('non-JSON/empty body → falls back to the generic "<status> <statusText>" message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: null,
      json: async () => { throw new Error('not JSON'); },
      clone() { return this; },
    })));
    const events: StreamEvent[] = [];
    await streamAgent('demo', { runId: 'r1', prompt: 'hi' }, (ev) => events.push(ev));
    expect(events).toEqual([{ type: 'error', data: { error: '500 Internal Server Error' } }]);
  });
});

describe('runWorkflowStream — surfaces the server error body on !res.ok (API-07)', () => {
  it('404 { error: "agent \'x\' not registered" } → the error event carries the SERVER text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: null,
      json: async () => ({ error: "agent 'x' not registered" }),
      clone() { return this; },
    })));
    const events: WfStreamEvent[] = [];
    await runWorkflowStream('wf1', {}, 'run-1', (ev) => events.push(ev));
    expect(events).toEqual([{ type: 'error', data: { error: "agent 'x' not registered" } }]);
  });
});
