// P1.7 (AUDIT-R2): a body-supplied `context.__gnl_orgId`/`__gnl_resourceId` spoof must NEVER
// survive — @gnldev/server seals the AUTHENTICATED identity (principal) into context via sealRequestContext
// BEFORE handing it to the registry, overwriting whatever the client tried to smuggle in.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

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
          // `plainOrg` is the documented, client-readable name for the same fact — `@gnldev/server`'s
          // own docs tell dynamic agents to read `ctx.org`, so it is observed here alongside the
          // reserved key it mirrors.
          system: (ctx: any) => JSON.stringify({ org: ctx[GNL_ORG_ID_KEY], resourceId: ctx[GNL_RESOURCE_ID_KEY], plainOrg: ctx.org }),
        },
      },
    },
    { auth: roleAuth({ admin: { user: 'alice', pass: 'pw', orgId: 'acme' } }) },
  );
}

const basicAuthHeader = 'Basic ' + Buffer.from('alice:pw').toString('base64');

describe('@gnldev/server: request-context identity sealing (P1.7)', () => {
  it('POST /agents/:name/run: a spoofed body.context.__gnl_orgId/__gnl_resourceId is overwritten by the SERVER identity', async () => {
    const journal = new InMemoryJournal();
    const api = mkApi(journal);

    const res = await call(api, '/agents/a/run', {
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

    const res = await call(api, '/agents/a/stream', {
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

    const res = await call(api, '/agents/a/run', {
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

  it('the PLAIN `org` key does not survive when NO organization resolves', async () => {
    // The dangerous case, and the one the previous shape missed. When an organization DOES resolve the
    // server writes its own value over the body's, so the spoof loses by accident. When none resolves
    // — an identity with no `orgId`, on a deployment that never configured `org`, which is the default
    // — there was nothing to overwrite it and the body's `org` reached the agent verbatim.
    const journal = new InMemoryJournal();
    const api = createRestApi(
      {
        journal,
        agents: { a: { model: mkModel('ok'), system: (ctx: any) => JSON.stringify({ plainOrg: ctx.org ?? null }) } },
      },
      { auth: roleAuth({ admin: { user: 'alice', pass: 'pw' } }) }, // no orgId anywhere
    );

    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuthHeader },
      body: JSON.stringify({ runId: 'unscoped-spoof', prompt: 'hi', context: { org: 'victim' } }),
    });
    expect(res.status).toBe(200);

    const input = await journal.get<{ system?: string }>('unscoped-spoof:input');
    const seen = JSON.parse(input!.system!);
    expect(seen.plainOrg, 'the body invented an organization the server never resolved').toBeNull();
  });

  it('the PLAIN `org` key is sealed too — it is the one the docs tell agents to read', async () => {
    // The seal stripped the three `__gnl_*` keys and stopped there, while `@gnldev/server` publishes
    // and documents a plain `org` beside them. A body carrying `context: { org: 'victim' }` therefore
    // reached dynamic `system`/`model`/`tools` functions verbatim on every path where no organization
    // resolved — which is every request on a deployment that has not configured `org` at all.
    const journal = new InMemoryJournal();
    const api = mkApi(journal);

    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basicAuthHeader },
      body: JSON.stringify({ runId: 'plain-org-spoof', prompt: 'hi', context: { org: 'victim' } }),
    });
    expect(res.status).toBe(200);

    const input = await journal.get<{ system?: string }>('org:acme:plain-org-spoof:input');
    const seen = JSON.parse(input!.system!);
    expect(seen.plainOrg, 'the body\'s `org` reached the agent').toBe('acme');
  });
});
