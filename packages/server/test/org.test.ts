// Per-request multi-organization: x-gnl-org header → journal + registry scoped to the org.
// The same runId is independent across different orgs; GET /runs is isolated per org; required → 400.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

function mkModel(text: string, counter?: { calls: number }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      if (counter) counter.calls++;
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

const run = (api: any, org?: string, runId = 'r1') =>
  api.request('/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(org ? { 'x-gnl-org': org } : {}) },
    body: JSON.stringify({ runId, prompt: 'hi' }),
  });

describe('@gnldev/server org', () => {
  it('the same runId is independent across two orgs; a within-org replay does not call the model', async () => {
    const counter = { calls: 0 };
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok', counter) } } },
      { org: {} },
    );
    expect((await run(api, 'acme')).status).toBe(200);
    expect((await run(api, 'globex')).status).toBe(200);
    expect(counter.calls).toBe(2); // two orgs = two independent runs

    expect((await run(api, 'acme')).status).toBe(200); // resume/replay
    expect(counter.calls).toBe(2); // the model was NOT called again (within-org exactly-once)
  });

  it('GET /runs is isolated per org; an org-less request sees the shared space', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { org: {} },
    );
    await run(api, 'acme', 'r-acme');
    await run(api, undefined, 'r-shared');

    const acmeRuns = await (await api.request('/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeRuns.map((r: any) => r.runId)).toEqual(['r-acme']); // an org only sees its own runs
    // Org-less view = raw journal (admin): its own runs + org runs appear PREFIXED
    const sharedIds = (await (await api.request('/runs')).json()).map((r: any) => r.runId);
    expect(sharedIds).toContain('r-shared');
    expect(sharedIds).toContain('org:acme:r-acme');
  });

  it('HARDENING: a multi-org deployment WARNS ONCE (not silently) when an org-less request falls to the shared scope', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: any) => { warns.push(String(m)); });
    try {
      const api = createRestApi(
        { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
        { org: {} }, // multi-org configured, required NOT set → org-less request lands in shared scope
      );
      await run(api, undefined, 'r1'); // org-less
      await run(api, undefined, 'r2'); // org-less again
      const sharedFootgunWarns = warns.filter((w) => w.includes('SHARED scope'));
      expect(sharedFootgunWarns.length).toBe(1); // fires ONCE, not per-request
      expect(sharedFootgunWarns[0]).toMatch(/org\.required = true/); // points the operator at the fix
    } finally {
      spy.mockRestore();
    }
  });

  it('HARDENING requireRegistration: an UNregistered org is rejected 403; registering it lets it run; a deleted (tombstone) org is rejected again', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { org: { requireRegistration: true } },
    );
    // Unregistered org → 403 (no __org__:acme record).
    expect((await run(api, 'acme')).status).toBe(403);

    // Register it the way studio's POST /organizations does (write the __org__:<id> record).
    await journal.put('__org__:acme', { id: 'acme', createdAt: 1 });
    expect((await run(api, 'acme', 'r-ok')).status).toBe(200); // now it runs

    // Delete it (studio writes a null tombstone) → its ghost requests are rejected again.
    await journal.put('__org__:acme', null);
    expect((await run(api, 'acme', 'r-ghost')).status).toBe(403);

    // A DIFFERENT, never-registered org is also rejected (no silent namespace fork).
    expect((await run(api, 'globex')).status).toBe(403);
  });

  it('requireRegistration OFF (default) → an unregistered org runs implicitly (backward compat unchanged)', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { org: {} }, // requireRegistration not set
    );
    expect((await run(api, 'never-registered')).status).toBe(200); // implicit org still works
  });

  it('required:true → an org-less request gets 400; an invalid org (:) → 400', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { org: { required: true } },
    );
    expect((await run(api)).status).toBe(400);
    expect((await run(api, 'a:b')).status).toBe(400);
    expect((await run(api, 'acme')).status).toBe(200);
  });

  it('the resolved org flows into the dynamic agent as requestContext.org', async () => {
    const seen: string[] = [];
    const api = createRestApi(
      {
        journal: new InMemoryJournal(),
        agents: {
          a: {
            model: mkModel('ok'),
            system: (ctx) => { seen.push(String(ctx.org)); return `Org: ${ctx.org}`; },
          },
        },
      },
      { org: {} },
    );
    await run(api, 'acme');
    expect(seen).toEqual(['acme']);
  });

  it('the org is resolved via the x-gnl-org header', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { org: {} },
    );
    const res = await api.request('/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
      body: JSON.stringify({ runId: 'r-org', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    const acmeRuns = await (await api.request('/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeRuns.map((r: any) => r.runId)).toEqual(['r-org']); // written to acme
  });
});
