// Org-scoped agents (opt-in): an org-bound caller only sees/runs GLOBAL agents (no `orgs`) + agents
// whose `orgs` include their org. An org-invisible agent returns the SAME 404 as an unknown agent
// (existence is not leaked). Operators (unbound) and auth-off callers see/run everything (backward-compat).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

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

// glob = global (no orgs), acme = orgs:['acme'], glbx = orgs:['globex']
const agents = () => ({
  glob: { model: mkModel('glob') },
  acme: { model: mkModel('acme'), orgs: ['acme'] },
  glbx: { model: mkModel('glbx'), orgs: ['globex'] },
});

// An acme-bound ADMIN (write-capable) exercises the run gate; an unbound admin is the operator.
const boundApi = () => createRestApi(
  { journal: new InMemoryJournal(), agents: agents() },
  { auth: roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } }), org: {} },
);
const opApi = () => createRestApi(
  { journal: new InMemoryJournal(), agents: agents() },
  { auth: roleAuth({ admin: { token: 'op' } }), org: {} },
);

const run = (api: any, name: string, token: string) =>
  api.request(`/agents/${name}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId: `r-${name}-${Math.random()}`, prompt: 'hi' }),
  });

const list = async (api: any, token: string) =>
  (await (await api.request('/agents', { headers: { authorization: `Bearer ${token}` } })).json())
    .map((a: any) => a.name).sort();

describe('@gnldev/server org-scoped agents', () => {
  it('1. acme-bound caller + orgs:[globex] agent → 404 (run) + ABSENT from list', async () => {
    const api = boundApi();
    expect((await run(api, 'glbx', 'acme-adm')).status).toBe(404);
    expect(await list(api, 'acme-adm')).not.toContain('glbx');
  });

  it('2. acme-bound caller + global agent → OK (runs) + present in list', async () => {
    const api = boundApi();
    expect((await run(api, 'glob', 'acme-adm')).status).toBe(200);
    expect(await list(api, 'acme-adm')).toContain('glob');
  });

  it('3. acme-bound caller + orgs:[acme] agent → OK; list = acme+glob (glbx excluded)', async () => {
    const api = boundApi();
    expect((await run(api, 'acme', 'acme-adm')).status).toBe(200);
    expect(await list(api, 'acme-adm')).toEqual(['acme', 'glob']);
  });

  it('4. operator (unbound admin) → every agent visible/runnable', async () => {
    const api = opApi();
    expect(await list(api, 'op')).toEqual(['acme', 'glbx', 'glob']);
    expect((await run(api, 'glbx', 'op')).status).toBe(200);
    expect((await run(api, 'acme', 'op')).status).toBe(200);
  });

  it('4b. org-invisible 404 uses the SAME "not registered" shape as an unknown agent (no existence leak)', async () => {
    const api = boundApi();
    const invisible = await run(api, 'glbx', 'acme-adm'); // exists but not for acme
    const unknown = await run(api, 'does-not-exist', 'acme-adm');
    expect(invisible.status).toBe(404);
    expect(unknown.status).toBe(404);
    // The invisible agent's body is byte-identical to what a genuinely-unknown agent of the SAME name
    // would produce → the response never signals that 'glbx' actually exists.
    expect(await invisible.json()).toEqual({ error: "agent 'glbx' not registered" });
    expect(await unknown.json()).toEqual({ error: "agent 'does-not-exist' not registered" });
  });

  it('5. auth OFF → all agents run + full list (backward-compat)', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: agents() }, { allowOpenAccess: true });
    const runOpen = (name: string) => api.request(`/agents/${name}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: `r-${name}`, prompt: 'hi' }),
    });
    expect((await runOpen('glbx')).status).toBe(200);
    expect((await runOpen('acme')).status).toBe(200);
    expect((await runOpen('glob')).status).toBe(200);
    const names = (await (await api.request('/agents')).json()).map((a: any) => a.name).sort();
    expect(names).toEqual(['acme', 'glbx', 'glob']);
  });
});
