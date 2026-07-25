// STRICT multi-org model on @gnldev/server (PAID: gated on the EE `multiOrganization` capability).
//   • EE ON  → org-bound is scoped; EXPLICIT platform-admin is the operator; org-less WITHOUT a grant is
//              FAIL-CLOSED (403 — previously the all-seeing operator).
//   • EE OFF → legacy operator behavior EXACTLY (proved by the existing auth-org suite).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { type AuthProvider, type Principal } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

function licensedAuth(map: Record<string, Principal>): AuthProvider {
  return {
    authenticate: (c) => {
      const h = c.req.header('authorization');
      const tok = h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('token');
      return (tok && map[tok]) || null;
    },
    authorize: (p, _c, ctx) => {
      if (!p) return { allow: false, status: 401, reason: 'unauthenticated' };
      if (ctx.action === 'write') return p.roles.includes('admin') || p.roles.includes('platform-admin') ? { allow: true } : { allow: false, status: 403 };
      return { allow: true };
    },
    capabilities: () => ({ multiOrganization: true }),
  };
}

const PRINCIPALS: Record<string, Principal> = {
  'a-adm': { id: 'a-adm', roles: ['admin'], orgId: 'acme' },
  'plat': { id: 'plat', roles: ['admin', 'platform-admin'] },
  'lost': { id: 'lost', roles: ['admin'] },
};

function mkApi(journal: InMemoryJournal, withOrgOpt = true) {
  return createRestApi(
    { journal, agents: { a: { model: mkModel('ok') } } },
    { auth: licensedAuth(PRINCIPALS), ...(withOrgOpt ? { org: {} } : {}) },
  );
}

const H = (t: string) => ({ authorization: `Bearer ${t}` });

describe('@gnldev/server strict multi-org (EE ON)', () => {
  it('(1) an org-bound identity is scoped to its own org; another org header → 403', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' });
    const api = mkApi(journal);

    const runs = await (await api.request('/runs', { headers: H('a-adm') })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']);
    expect((await api.request('/runs', { headers: { ...H('a-adm'), 'x-gnl-org': 'globex' } })).status).toBe(403);
  });

  it('(2) an EXPLICIT platform-admin acts as operator (works in any org via header, sees root)', async () => {
    const journal = new InMemoryJournal();
    const res = await api_run(mkApi(journal), 'plat', 'globex');
    expect(res.status).toBe(200);
    const runs = await (await mkApi(journal).request('/runs', { headers: { ...H('plat'), 'x-gnl-org': 'globex' } })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r1']);
  });

  it('(3) FAIL-CLOSED: an org-less identity WITHOUT a platform grant → 403 (was the operator)', async () => {
    const journal = new InMemoryJournal();
    const api = mkApi(journal);
    expect((await api.request('/runs', { headers: H('lost') })).status).toBe(403);
    expect((await api_run(api, 'lost')).status).toBe(403);
  });

  it('(3b) FAIL-CLOSED holds even WITHOUT the org option (isolation is identity-driven)', async () => {
    const api = mkApi(new InMemoryJournal(), /* withOrgOpt */ false);
    expect((await api.request('/runs', { headers: H('lost') })).status).toBe(403);
    // a platform-admin, org-less + no org option → shared/root scope (200)
    expect((await api.request('/runs', { headers: H('plat') })).status).toBe(200);
  });
});

async function api_run(api: ReturnType<typeof mkApi>, tok: string, org?: string) {
  return api.request('/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...H(tok), ...(org ? { 'x-gnl-org': org } : {}) },
    body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
  });
}
