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
