// D4-FGA (EE-2) opt-in hook: RestApiOptions.resourceAuth, consulted AFTER the existing coarse gate.
// This file tests the HTTP layer directly (a plain function stand-in for opts.resourceAuth) — an EE
// user wires this to createEnterpriseAuth(...).checkResource. The license-gated createFga /
// checkResource behaviour itself is tested with the commercial package, not here.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi, type ResourceAuthResource, type ResourceAuthAction } from '../src/index.js';
import { call } from './call.js';

function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

function mkApi(resourceAuth?: (p: any, r: ResourceAuthResource, a: ResourceAuthAction) => Promise<boolean> | boolean) {
  const journal = new InMemoryJournal();
  return createRestApi(
    { journal, agents: { a: { model: mkModel() } }, workflows: {} },
    resourceAuth ? { resourceAuth } : {},
  );
}

describe('@gnldev/server resourceAuth opt-in hook (D4-FGA)', () => {
  it('resourceAuth denies an agent run → 403 with code "resource_denied"', async () => {
    const api = mkApi(() => false);
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-1', prompt: 'hi' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('resource_denied');
  });

  it('resourceAuth denies an agent stream → 403 with code "resource_denied"', async () => {
    const api = mkApi(() => false);
    const res = await call(api, '/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-2', prompt: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('resource_denied');
  });

  // The endpoint that needed the gate most was the one that did not have it. /resume carries
  // `approvals` in its body, so a caller denied /run could resume a run somebody else started and
  // approve the exact tool call the human gate had stopped — turning a denial into an execution.
  it('resourceAuth denies a resume → 403, and the approval it carried is not applied', async () => {
    const api = mkApi(() => false);
    const res = await call(api, '/agents/a/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-resume', approvals: { 'call-1': true } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('resource_denied');
  });

  it('every run-shaped endpoint consults resourceAuth — none is left open', async () => {
    const seen: string[] = [];
    const api = mkApi((_p, r) => { seen.push(r.type + ':' + r.id); return false; });
    for (const [path, body] of [
      ['/agents/a/run', { runId: 'x1', prompt: 'hi' }],
      ['/agents/a/stream', { runId: 'x2', prompt: 'hi' }],
      ['/agents/a/resume', { runId: 'x3', approvals: {} }],
    ] as const) {
      const res = await call(api, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(403);
    }
    expect(seen).toEqual(['agent:a', 'agent:a', 'agent:a']);
  });

  it('resourceAuth allows → request proceeds to 200 (round-trip), and receives the correct resource/action', async () => {
    const calls: Array<{ resource: ResourceAuthResource; action: ResourceAuthAction }> = [];
    const api = mkApi((_p, resource, action) => {
      calls.push({ resource, action });
      return true;
    });
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-3', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ resource: { type: 'agent', id: 'a' }, action: 'run' }]);
  });

  it('run-cancel: resourceAuth denies → 403 resource_denied (runs AFTER the existing 404 existence check)', async () => {
    const journal = new InMemoryJournal();
    const openApi = createRestApi({ journal, agents: { a: { model: mkModel() } } });
    // create a real run first so the cancel endpoint's existence check passes
    await call(openApi, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-cancel-1', prompt: 'hi' }),
    });
    const gatedApi = createRestApi({ journal, agents: { a: { model: mkModel() } } }, { resourceAuth: () => false });
    const res = await call(gatedApi, '/runs/ra-cancel-1/cancel', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('resource_denied');
  });

  it('an UNKNOWN run still 404s (resourceAuth is never reached — the existence check runs first)', async () => {
    const api = mkApi(() => false);
    const res = await call(api, '/runs/does-not-exist/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('if resourceAuth is NOT given, behavior is preserved EXACTLY AS IS (no regression)', async () => {
    const api = mkApi(); // no resourceAuth
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-4', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.text).toBe('ok');
  });
});
