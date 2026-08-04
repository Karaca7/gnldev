// Org-scoped agents in @gnldev/studio playground: an org-bound caller only lists/runs GLOBAL agents
// (no `orgs`) + agents whose `orgs` include their org; an org-invisible agent returns the SAME 404
// as an unknown agent (no existence leak). Operators + auth-off callers see/run everything (backward-compat).
// (Test lives in the durable package because ai/createGnl live here; studio uses createStudioRunner.)
import { describe, it, expect } from 'vitest';
import { createStudioApi } from '../../studio/src/server.js';
import { createStudioRunner } from '../../studio/src/runner.js';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';
import { roleAuth } from '../../studio/src/auth.js';
import { call } from './call.js';

const model = () => createMockModel(async () => finalTextResult('ok'));

// glob = global (no orgs), acme = orgs:['acme'], glbx = orgs:['globex']
const config = () => ({
  journal: new InMemoryJournal(),
  agents: {
    glob: { model: model(), maxSteps: 4 },
    acme: { model: model(), maxSteps: 4, orgs: ['acme'] },
    glbx: { model: model(), maxSteps: 4, orgs: ['globex'] },
  },
});

function api(auth?: ReturnType<typeof roleAuth>) {
  const cfg = config();
  const gnl = createStudioRunner(createGnl(cfg), cfg);
  return createStudioApi({ reader: cfg.journal, gnl, ...(auth ? { auth } : { allowOpenAccess: true }) });
}

const boundAdmin = () => roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
const operator = () => roleAuth({ admin: { token: 'op' } });

const run = (app: any, name: string, token?: string) =>
  call(app, `/agents/${name}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ runId: `r-${name}-${Math.random()}`, prompt: 'hi' }),
  });

const list = async (app: any, token?: string) =>
  (await (await call(app, '/agents', { headers: token ? { authorization: `Bearer ${token}` } : {} })).json())
    .map((a: any) => a.name).sort();

describe('@gnldev/studio org-scoped agents', () => {
  it('1. acme-bound caller + orgs:[globex] agent → 404 (run) + ABSENT from list', async () => {
    const app = api(boundAdmin());
    expect((await run(app, 'glbx', 'acme-adm')).status).toBe(404);
    expect(await list(app, 'acme-adm')).not.toContain('glbx');
  });

  it('2. acme-bound caller + global agent → OK + present in list', async () => {
    const app = api(boundAdmin());
    expect((await run(app, 'glob', 'acme-adm')).status).toBe(200);
    expect(await list(app, 'acme-adm')).toContain('glob');
  });

  it('3. acme-bound caller + orgs:[acme] agent → OK; list = acme+glob (glbx excluded)', async () => {
    const app = api(boundAdmin());
    expect((await run(app, 'acme', 'acme-adm')).status).toBe(200);
    expect(await list(app, 'acme-adm')).toEqual(['acme', 'glob']);
  });

  it('4. operator (unbound admin) → every agent visible/runnable', async () => {
    const app = api(operator());
    expect(await list(app, 'op')).toEqual(['acme', 'glbx', 'glob']);
    expect((await run(app, 'glbx', 'op')).status).toBe(200);
    expect((await run(app, 'acme', 'op')).status).toBe(200);
  });

  it('4b. an org-invisible code agent returns a leak-free 404 ("not registered") — never a permission hint', async () => {
    const app = api(boundAdmin());
    const invisible = await run(app, 'glbx', 'acme-adm'); // real code agent, hidden from acme
    expect(invisible.status).toBe(404);
    // The body uses the plain "not registered" phrasing — it does NOT reveal that 'glbx' exists but is
    // org-restricted (no 403 / "forbidden" / "belongs to another org" signal).
    expect(await invisible.json()).toEqual({ error: "agent 'glbx' not registered" });
  });

  it('5. auth OFF → all agents run + full list (backward-compat)', async () => {
    const app = api(); // allowOpenAccess, no auth
    expect((await run(app, 'glbx')).status).toBe(200);
    expect((await run(app, 'acme')).status).toBe(200);
    expect((await run(app, 'glob')).status).toBe(200);
    expect(await list(app)).toEqual(['acme', 'glbx', 'glob']);
  });

  it('agent meta carries `orgs` for org-scoped agents (UI chip); global agents omit it', async () => {
    const app = api(operator());
    const metas = await (await call(app, '/agents', { headers: { authorization: 'Bearer op' } })).json();
    const byName = Object.fromEntries(metas.map((m: any) => [m.name, m]));
    expect(byName.acme.orgs).toEqual(['acme']);
    expect(byName.glbx.orgs).toEqual(['globex']);
    expect(byName.glob.orgs).toBeUndefined();
  });
});
