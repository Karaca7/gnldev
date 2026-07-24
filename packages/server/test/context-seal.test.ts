// P1.7 (AUDIT-R2): a body-supplied `context.__gnl_orgId`/`__gnl_resourceId` spoof must NEVER
// survive — @gnl/server seals the AUTHENTICATED identity (principal) into context via sealRequestContext
// BEFORE handing it to the registry, overwriting whatever the client tried to smuggle in.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY } from '@gnl/durable';
import { roleAuth } from '@gnl/auth';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) =>
  new ReadableStream({
    start(c) {
      for (const p of arr) c.enqueue(p);
      c.close();
    },
  });

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

// Dynamic `system` captures the resolved request context (as seen by the registry) — since `system` is
// persisted verbatim into the run's `:input` journal record, this doubles as an observation point:
// whatever precedence actually won is visible via a plain journal read after the call.
function mkApi(journal: InMemoryJournal) {
  return createRestApi(
    {
      journal,
      agents: {
        a: {
          model: mkModel('ok'),
          system: (ctx: any) => JSON.stringify({ org: ctx[GNL_ORG_ID_KEY], resourceId: ctx[GNL_RESOURCE_ID_KEY] }),
        },
      },
    },
    { auth: roleAuth({ admin: { user: 'alice', pass: 'pw', orgId: 'acme' } }) },
  );
}

const basicAuthHeader = 'Basic ' + Buffer.from('alice:pw').toString('base64');

describe('@gnl/server: request-context identity sealing (P1.7)', () => {
  it('POST /agents/:name/run: a spoofed body.context.__gnl_orgId/__gnl_resourceId is overwritten by the SERVER identity', async () => {
    const journal = new InMemoryJournal();
    const api = mkApi(journal);

    const res = await api.request('/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuthHeader },
      body: JSON.stringify({
        runId: 'spoof-run-1',
        prompt: 'hi',
        context: { [GNL_ORG_ID_KEY]: 'evil-org', [GNL_RESOURCE_ID_KEY]: 'evil-user' },
      }),
    });
    expect(res.status).toBe(200);

    // The run is scoped under org 'acme' (principal.orgId) → withOrg prefixes journal keys with `org:acme:`.
    const input = await journal.get<{ system?: string }>('org:acme:spoof-run-1:input');
    expect(input).toBeDefined();
    const seen = JSON.parse(input!.system!);
    expect(seen.org).toBe('acme'); // NOT 'evil-org'
    expect(seen.resourceId).toBe('alice'); // NOT 'evil-user'
  });

  it('POST /agents/:name/stream: same spoof is neutralized', async () => {
    const journal = new InMemoryJournal();
    const api = mkApi(journal);

    const res = await api.request('/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuthHeader },
      body: JSON.stringify({
        runId: 'spoof-run-2',
        prompt: 'hi',
        context: { [GNL_ORG_ID_KEY]: 'evil-org', [GNL_RESOURCE_ID_KEY]: 'evil-user' },
      }),
    });
    expect(res.status).toBe(200);
    // drain the SSE body so the stream actually completes and persists :input
    await res.text();

    const input = await journal.get<{ system?: string }>('org:acme:spoof-run-2:input');
    expect(input).toBeDefined();
    const seen = JSON.parse(input!.system!);
    expect(seen.org).toBe('acme');
    expect(seen.resourceId).toBe('alice');
  });

  it('a non-spoofed request (no context) still gets the server identity sealed in', async () => {
    const journal = new InMemoryJournal();
    const api = mkApi(journal);

    const res = await api.request('/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuthHeader },
      body: JSON.stringify({ runId: 'no-spoof-run', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);

    const input = await journal.get<{ system?: string }>('org:acme:no-spoof-run:input');
    const seen = JSON.parse(input!.system!);
    expect(seen.org).toBe('acme');
    expect(seen.resourceId).toBe('alice');
  });
});
