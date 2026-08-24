// Auth ↔ org consistency: the organization is derived from IDENTITY, not from a spoofable header.
// A cred bound to identity (Cred.orgId) → scoped to its own organization even without a header; a
// request for a different organization → 403; an unbound (global) admin can work in whatever organization it wants via the header.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

function mkApi(journal: InMemoryJournal) {
  return createRestApi(
    { journal, agents: { a: { model: mkModel('ok') } } },
    {
      // `superAdmin`, not a bare admin: with the `org` option configured, an identity bound to no
      // organization is fail-closed, and the cross-org (platform) scope is an EXPLICIT grant that is
      // never inferred from a missing orgId — see @gnldev/auth scope.ts. The persona these tests
      // exercise is the operator, so it says so. (`mkApiNoOrg` below has no `org` option and keeps a
      // plain unbound admin: nothing to isolate from, so nothing to declare.)
      auth: roleAuth({ superAdmin: { token: 'adm' }, viewer: { token: 'viw', orgId: 'acme' } }),
      org: {},
    },
  );
}

describe('@gnldev/server auth↔org', () => {
  it('a viewer bound to identity is scoped to ITS OWN organization even without a header', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' });
    const api = mkApi(journal);

    const runs = await (await call(api, '/runs', { headers: { authorization: 'Bearer viw' } })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']); // globex is NOT VISIBLE
  });

  it('bound identity requesting a different organization → 403; requesting its own organization is free', async () => {
    const api = mkApi(new InMemoryJournal());
    const res = await call(api, '/runs', {
      headers: { authorization: 'Bearer viw', 'x-gnl-org': 'globex' },
    });
    expect(res.status).toBe(403);

    const own = await call(api, '/runs', {
      headers: { authorization: 'Bearer viw', 'x-gnl-org': 'acme' },
    });
    expect(own.status).toBe(200);
  });

  it('unbound (global) admin works in whatever organization it wants via the header (operator scenario)', async () => {
    const api = mkApi(new InMemoryJournal());
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer adm', 'x-gnl-org': 'globex' },
      body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    const runs = await (await call(api, '/runs', {
      headers: { authorization: 'Bearer adm', 'x-gnl-org': 'globex' },
    })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r1']);
  });

  it('B2: an auth provider that binds NO principal ({read,write}) + org option → the x-gnl-org header cannot drive the org (403, fail-closed)', async () => {
    // legacy {read,write} auth authenticates by predicate but yields NO principal → there is no identity
    // to bind an org to. With opts.org set, letting x-gnl-org pick the tenant would be unbound cross-tenant.
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { auth: { read: () => true, write: () => true }, org: {} },
    );
    const res = await call(api, '/runs', { headers: { 'x-gnl-org': 'globex' } });
    expect(res.status).toBe(403);
    // sanity: WITHOUT opts.org the same principal-less auth still works (single-scope, no isolation claim)
    const noOrg = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: { model: mkModel('ok') } } },
      { auth: { read: () => true, write: () => true } },
    );
    expect((await call(noOrg, '/runs')).status).toBe(200);
  });

  it('F2: even without the org OPTION, Cred.orgId isolation is still enforced (via identity)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' });
    // NOTE: there is NO org option.
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw', orgId: 'acme' } }) },
    );

    // The bound viewer sees only acme (previously the entire root journal would leak).
    const bound = await (await call(api, '/runs', { headers: { authorization: 'Bearer viw' } })).json();
    expect(bound.map((r: any) => r.runId)).toEqual(['r-acme']);

    // A bound viewer requesting a different organization gets 403.
    expect((await call(api, '/runs', { headers: { authorization: 'Bearer viw', 'x-gnl-org': 'globex' } })).status).toBe(403);

    // An unbound admin sees the root view (all prefixed keys) — the existing operator behavior.
    const adm = await (await call(api, '/runs', { headers: { authorization: 'Bearer adm' } })).json();
    expect(adm.map((r: any) => r.runId).sort()).toEqual(['org:acme:r-acme', 'org:globex:r-globex']);
  });
});
