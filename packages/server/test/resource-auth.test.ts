// D4-FGA (EE-2) opt-in hook: RestApiOptions.resourceAuth, consulted AFTER the existing coarse gate.
// This file tests the HTTP layer directly (a plain function stand-in for opts.resourceAuth) — an EE
// user wires this to createEnterpriseAuth(...).checkResource (see @gnl/auth-ee's fga.test.ts for the
// license-gated createFga/checkResource behavior itself).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createRestApi, type ResourceAuthResource, type ResourceAuthAction } from '../src/index.js';

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

describe('@gnl/server resourceAuth opt-in hook (D4-FGA)', () => {
  it('resourceAuth denies an agent run → 403 with code "resource_denied"', async () => {
    const api = mkApi(() => false);
    const res = await api.request('/agents/a/run', {
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
    const res = await api.request('/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-2', prompt: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('resource_denied');
  });

  it('resourceAuth allows → request proceeds to 200 (round-trip), and receives the correct resource/action', async () => {
    const calls: Array<{ resource: ResourceAuthResource; action: ResourceAuthAction }> = [];
    const api = mkApi((_p, resource, action) => {
      calls.push({ resource, action });
      return true;
    });
    const res = await api.request('/agents/a/run', {
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
    await openApi.request('/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ra-cancel-1', prompt: 'hi' }),
    });
    const gatedApi = createRestApi({ journal, agents: { a: { model: mkModel() } } }, { resourceAuth: () => false });
    const res = await gatedApi.request('/runs/ra-cancel-1/cancel', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('resource_denied');
  });

  it('an UNKNOWN run still 404s (resourceAuth is never reached — the existence check runs first)', async () => {
    const api = mkApi(() => false);
    const res = await api.request('/runs/does-not-exist/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('if resourceAuth is NOT given, behavior is preserved EXACTLY AS IS (no regression)', async () => {
    const api = mkApi(); // no resourceAuth
    const res = await api.request('/agents/a/run', {
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
