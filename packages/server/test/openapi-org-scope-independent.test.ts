// The schema route publishes agent names, and a name is the one fact the agent gate withholds.
//
// `agentGate` answers the SAME 404 for "no such agent" and "not yours", deliberately, so a non-owning
// organization cannot learn an agent EXISTS. `/agents` filters through `agentVisibleToOrg`. The
// schema route served the config's whole `names` array — computed once at construction, before any
// caller is known — so the fact the gate hides was published next door.
//
// The assertions are on the SERIALIZED DOCUMENT, not on a list the route happens to return: a name
// reaches the caller through `paths['/agents/{n}/run']`, its operationId, its summary and its tags, so
// a filter applied to one of those and not the others still leaks. The strongest probe here is the
// cross-check against `/agents`: the two surfaces must agree for every caller, which stays true if a
// fifth place starts naming agents.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};

/** Two org-owned agents and one global one, plus a workflow. */
const AGENTS = {
  'acme-only': { model, orgs: ['acme'] },
  'globex-only': { model, orgs: ['globex'] },
  shared: { model },
};
const workflows = { 'report-wf': { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) } };

function mkApi(opts: object = {}) {
  return createRestApi(
    { journal: new InMemoryJournal(), agents: AGENTS, workflows } as never,
    { org: {}, ...opts } as never,
  );
}

const schema = (api: any, headers: Record<string, string> = {}) => call(api, '/openapi.json', { headers });
const agentsOf = async (api: any, headers: Record<string, string> = {}) =>
  (await (await call(api, '/agents', { headers })).json()).map((a: any) => a.name).sort();
/** Every agent name the document mentions ANYWHERE, not just in one list. */
const namesInDoc = (doc: unknown, all: string[]) => all.filter((n) => JSON.stringify(doc).includes(n)).sort();

afterEach(() => { vi.restoreAllMocks(); });

describe('GET /openapi.json for an organization-scoped caller', () => {
  it('does not mention another organization\'s agent anywhere in the document', async () => {
    const res = await schema(mkApi(), { 'x-gnl-org': 'acme' });
    expect(res.status).toBe(200);
    const doc = await res.json();

    expect(JSON.stringify(doc), 'the schema published the name the agent gate exists to withhold')
      .not.toContain('globex-only');
    expect(doc.paths['/agents/globex-only/run'], 'a path was published for an agent this caller cannot run').toBeUndefined();
    expect(doc.paths['/agents/acme-only/run'], 'the caller lost its OWN agent').toBeTruthy();
    expect(doc.paths['/agents/shared/run'], 'a global agent stopped being published').toBeTruthy();
  });

  it('shows each organization its own agents and the global ones', async () => {
    const api = mkApi();
    const forAcme = namesInDoc(await (await schema(api, { 'x-gnl-org': 'acme' })).json(), Object.keys(AGENTS));
    const forGlobex = namesInDoc(await (await schema(api, { 'x-gnl-org': 'globex' })).json(), Object.keys(AGENTS));

    expect(forAcme).toEqual(['acme-only', 'shared']);
    expect(forGlobex).toEqual(['globex-only', 'shared']);
  });

  // The cross-check. `/agents` was already correct; the schema route was the copy that drifted. If a
  // future surface starts naming agents, this is the assertion that notices.
  it.each([
    ['an organization-scoped caller', { 'x-gnl-org': 'acme' }],
    ['a different organization', { 'x-gnl-org': 'globex' }],
    ['the shared, org-less scope', {}],
  ])('agrees with GET /agents for %s', async (_label, headers) => {
    const api = mkApi();
    const doc = await (await schema(api, headers)).json();

    expect(namesInDoc(doc, Object.keys(AGENTS)), 'the schema and the agent list disagree about what this caller can see')
      .toEqual(await agentsOf(api, headers));
  });

  // The route is now per-request and calls `scope(c)`, so it can answer where it previously could not.
  it('rejects an organization mismatch instead of serving a schema', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: AGENTS, workflows } as never,
      { org: {}, auth: roleAuth({ admin: { token: 'adm', orgId: 'acme' } }) } as never,
    );

    const res = await schema(api, { authorization: 'Bearer adm', 'x-gnl-org': 'globex' });
    expect(res.status, 'a bound identity was served another organization\'s schema').toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('globex-only');
  });

  it('serves a bound identity its own organization', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: AGENTS, workflows } as never,
      { org: {}, auth: roleAuth({ admin: { token: 'adm', orgId: 'acme' } }) } as never,
    );

    const doc = await (await schema(api, { authorization: 'Bearer adm' })).json();
    expect(namesInDoc(doc, Object.keys(AGENTS))).toEqual(['acme-only', 'shared']);
  });

  it('still refuses an unauthenticated caller when auth is on', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: AGENTS } as never,
      { org: {}, auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }) } as never,
    );

    expect((await schema(api)).status, 'the read gate stopped running before the org filter').toBe(401);
  });
});

describe('GET /openapi.json for a caller with no organization', () => {
  // Backward compatibility, and the configuration almost every deployment is in.
  it('serves every agent when no `org` option is configured', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: AGENTS, workflows } as never);
    const doc = await (await schema(api)).json();

    expect(namesInDoc(doc, Object.keys(AGENTS)), 'a single-tenant deployment lost agents from its schema')
      .toEqual(['acme-only', 'globex-only', 'shared']);
  });

  it('serves every agent to the org-less shared scope even when `org` IS configured', async () => {
    const doc = await (await schema(mkApi())).json();
    expect(namesInDoc(doc, Object.keys(AGENTS))).toEqual(['acme-only', 'globex-only', 'shared']);
  });

  it('serves every agent when auth is off entirely', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: AGENTS } as never, { org: {} } as never);
    const doc = await (await schema(api, { 'x-gnl-org': 'acme' })).json();
    // No auth provider means no identity, but the header still scopes — the filter must follow the
    // resolved org, not the presence of a principal.
    expect(namesInDoc(doc, Object.keys(AGENTS))).toEqual(['acme-only', 'shared']);
  });
});

describe('workflows in the schema', () => {
  // The claim being relied on is that workflows have no org dimension in the config. The check that
  // matters is not the type but the BEHAVIOUR of the surface next door: `GET /workflows` does not
  // filter either, so an unfiltered schema is consistent. If workflows ever gain an org dimension,
  // both this and `/workflows` have to change together — and this test says so.
  it('are listed in full for every caller, matching GET /workflows', async () => {
    const api = mkApi();
    for (const headers of [{}, { 'x-gnl-org': 'acme' }, { 'x-gnl-org': 'globex' }]) {
      const doc = await (await schema(api, headers)).json();
      expect(doc.paths['/workflows/report-wf/run'], 'a workflow disappeared for an org-scoped caller').toBeTruthy();

      const listed = (await (await call(api, '/workflows', { headers })).json()).map((w: any) => w.name);
      expect(listed, 'GET /workflows started filtering — the schema route must filter too').toEqual(['report-wf']);
    }
  });

  it('the agent filter does not accidentally remove them', async () => {
    const doc = await (await schema(mkApi(), { 'x-gnl-org': 'acme' })).json();
    expect(JSON.stringify(doc)).toContain('report-wf');
  });
});

describe('what the schema route must keep doing', () => {
  it('still produces a usable document, not just a filtered name list', async () => {
    const doc = await (await schema(mkApi(), { 'x-gnl-org': 'acme' })).json();

    expect(doc.openapi, 'the document lost its version marker').toBeTruthy();
    expect(doc.info?.title).toBeTruthy();
    expect(Object.keys(doc.paths).length, 'the document has no paths at all').toBeGreaterThan(1);
  });

  it('honours a custom title', async () => {
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: AGENTS } as never,
      { org: {}, title: 'My API' } as never,
    );
    expect((await (await schema(api, { 'x-gnl-org': 'acme' })).json()).info.title).toBe('My API');
  });

  it('answers per request, so two organizations do not share one cached document', async () => {
    const api = mkApi();
    const first = await (await schema(api, { 'x-gnl-org': 'acme' })).json();
    const second = await (await schema(api, { 'x-gnl-org': 'globex' })).json();

    expect(JSON.stringify(first), 'the second caller was served the first caller\'s document').not.toContain('globex-only');
    expect(JSON.stringify(second)).not.toContain('acme-only');
  });
});
