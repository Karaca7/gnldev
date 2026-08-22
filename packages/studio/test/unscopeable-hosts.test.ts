// `memory` is not the only host object that cannot be given an organization boundary.
//
// Studio takes several objects straight from the host — `vectors`, `cache`, `queue`, and optionally
// `workflowStore` — each owning its own storage. Three of them are handed an `{ orgId }` argument, but
// that is ADVISORY: nothing obliges a host to read it, and `cache.stats()` / `queue.listJobs()` are
// handed nothing at all. `memory` got a boot warning and a hard refusal; its four siblings got the
// argument and were still served.
//
// Measured from an acme-bound admin against hosts that ignore the argument — which is every host that
// has not been told the argument exists:
//
//   POST /knowledge/search      -> 200 [{"text":"globex private doc"}]
//   POST /cache/invalidate {}   -> 200 {"removed":9}          every organization's cache, one call
//   POST /jobs/globex-job/retry -> 200
//   GET  /workflows             -> 200, another org's definition INCLUDING its prompt template
//   DELETE /workflows/secret    -> 200, and the other org's definition is gone
//
// A host that HAS made its object org-aware says so by setting `orgScoped: true` on it — an explicit
// claim, in the host's own code. Refusing by default is the only side that fails safe: a wrong refusal
// costs a config line, a wrong service lets one tenant read another's data.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

afterEach(() => vi.restoreAllMocks());

const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
const H = { authorization: 'Bearer acme-adm', 'content-type': 'application/json' };
const as = (app: unknown, path: string, init: RequestInit = {}) =>
  call(app as never, path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

/** Hosts that ignore the `orgId` they are handed — the default state of any host not told about it. */
const blindHosts = () => ({
  vectors: { search: async () => [{ text: 'globex private doc' }] },
  cache: { stats: async () => ({ size: 9 }), invalidate: async () => 9 },
  queue: { listJobs: async () => [{ id: 'globex-job' }], retry: async () => 'new-job' },
});

const wfStore = (defs: Map<string, unknown>) => ({
  list: async () => [...defs.values()],
  get: async (n: string) => defs.get(n),
  set: async (d: { name: string }) => { defs.set(d.name, d); },
  delete: async (n: string) => { defs.delete(n); },
});

describe('host objects with no organization boundary', () => {
  it.each([
    ['POST', '/knowledge/search', JSON.stringify({ query: 'secret' })],
    ['GET', '/jobs', undefined],
    ['POST', '/jobs/globex-job/retry', undefined],
    ['GET', '/cache/stats', undefined],
    ['POST', '/cache/invalidate', JSON.stringify({})],
  ])('refuses %s %s to an organization-scoped identity', async (method, path, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, ...blindHosts() } as never);

    const res = await as(app, path, { method, ...(body ? { body } : {}) });
    expect(res.status, `${method} ${path} served another tenant's data`).toBe(403);
    expect((await res.json()).error).toMatch(/no organization boundary/);
  });

  it('serves them when the host declares the object IS organization-aware', async () => {
    // The escape hatch has to exist, or a correctly-built host is punished for someone else's problem.
    // It is an explicit claim rather than an inference, because nothing here can verify it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hosts = blindHosts();
    const app = createStudioApi({
      reader: new InMemoryJournal(), auth: boundAdmin, org: {},
      ...hosts, vectors: { ...hosts.vectors, orgScoped: true },
    } as never);

    const res = await as(app, '/knowledge/search', { method: 'POST', body: JSON.stringify({ query: 'x' }) });
    expect(res.status, 'a host that scopes its own store was refused anyway').toBe(200);
  });

  it('leaves a single-organization deployment alone', async () => {
    // No org anywhere: there is nothing to isolate from, and refusing would break every such deployment.
    const app = createStudioApi({ reader: new InMemoryJournal(), ...blindHosts() } as never);
    const res = await call(app as never, '/knowledge/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(200);
  });

  it('says it at boot, where a host can act on it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStudioApi({ reader: new InMemoryJournal(), org: {}, ...blindHosts() } as never);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    for (const what of ['vectors', 'cache', 'queue']) {
      expect(said, `nothing was said about \`${what}\` — a deployment could ship this unaware`).toContain(what);
    }
  });

  it('says it when a caller is refused, for the config boot cannot predict', async () => {
    // `roleAuth({ admin: { token, orgId } })` binds an organization to the identity — documented as
    // first-class, no `org` option needed — and reports `multiOrganization: false`, because that flag
    // means "the paid multi-org product". So the boot check saw a single-org deployment while six
    // endpoints started refusing. Measured: warnings printed at boot, ZERO.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, ...blindHosts() } as never);
    expect(warn.mock.calls.length, 'this config cannot be predicted at boot — the test premise is wrong').toBe(0);

    const res = await as(app, '/knowledge/search', { method: 'POST', body: JSON.stringify({ query: 'x' }) });
    expect(res.status).toBe(403);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n'), 'the refusal was silent').toContain('vectors');
  });

  it('says nothing at boot for a licensed deployment that refuses nothing', async () => {
    // The opposite error: an EE licensee running single-tenant got three warnings claiming its
    // endpoints "are refused", while nothing was refused. The capability flag means the product is
    // licensed, not that identities carry an organization.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const eeProvider = {
      authenticate: () => null,
      authorize: () => ({ allow: true }),
      capabilities: () => ({ multiOrganization: true }),
    };
    createStudioApi({ reader: new InMemoryJournal(), auth: eeProvider, ...blindHosts() } as never);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    for (const what of ['vectors', 'cache', 'queue']) {
      expect(said, `warned about \`${what}\` on a deployment where nothing is refused`).not.toContain(`\`${what}\``);
    }
  });
});

describe('a host-supplied workflow store', () => {
  it('does not hand another organization its workflow definitions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = new Map<string, unknown>([['secret', { name: 'secret', steps: [{ id: 's1', prompt: 'GLOBEX-TEMPLATE' }] }]]);
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, workflowStore: wfStore(defs) } as never);

    const listed = await (await as(app, '/workflows')).json() as { name: string }[];
    expect(listed.map((w) => w.name), 'another org\'s workflow definition was listed').not.toContain('secret');

    const del = await as(app, '/workflows/secret', { method: 'DELETE' });
    expect(del.status, 'another org\'s workflow could be deleted').toBe(403);
    expect([...defs.keys()], 'another org\'s workflow was actually removed').toEqual(['secret']);
  });

  it.each([
    ['POST', '/workflows/secret/run', JSON.stringify({ input: {}, dryRun: true })],
    ['POST', '/workflows/secret/run-stream', JSON.stringify({ input: {} })],
    ['POST', '/workflows/secret/runs/r1/fork', JSON.stringify({ upto: 1 })],
  ])('does not let %s %s reach it either', async (method, path, body) => {
    // The refusal was added to list/def/CRUD and missed the three routes that RUN a managed workflow.
    // Measured before this: `GET /workflows/secret/def` answered 403 while `POST /workflows/secret/run`
    // answered 200 and returned the other tenant's prompt template verbatim in the dry-run output —
    // and without `dryRun` it executed that workflow against the real engine.
    //
    // Gating the sites I happened to be looking at is how the hole stayed open, so the store is no
    // longer reachable without a request: every route-level read goes through `wfStoreFor(c)`.
    // Asserted on whether the STORE WAS READ, not on the status code. The code is a poor witness here:
    // a compile stub that does not match the real shape makes an ungated route answer 400 rather than
    // 200, so a status assertion passes for the wrong reason. Whether `get`/`list` was called answers
    // the actual question — did another tenant's data leave the store — for all three routes.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = new Map<string, unknown>([['secret', {
      name: 'secret', steps: [{ id: 's1', kind: 'agent', agent: 'a', prompt: 'GLOBEX-PRIVATE-TEMPLATE' }],
    }]]);
    const touched: string[] = [];
    const store = wfStore(defs);
    const watched = {
      list: async () => { touched.push('list'); return store.list(); },
      get: async (n: string) => { touched.push(`get:${n}`); return store.get(n); },
      set: store.set, delete: store.delete,
    };
    const app = createStudioApi({
      reader: new InMemoryJournal(), auth: boundAdmin, org: {},
      workflowStore: watched,
      compileWorkflow: () => ({ run: async () => ({ output: 'x', steps: [] }) }),
      gnl: { run: async () => ({ text: 'x' }) },
    } as never);

    const res = await as(app, path, { method, body });
    expect(touched, `${method} ${path} read another tenant's workflow store`).toEqual([]);
    expect(await res.text(), 'another tenant\'s prompt template came back in the response')
      .not.toContain('GLOBEX-PRIVATE-TEMPLATE');
  });

  it('still lists CODE workflows, which do not come from a tenant\'s data', async () => {
    // Refusing the whole route would take the code list away over an unrelated option.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createStudioApi({
      reader: new InMemoryJournal(), auth: boundAdmin, org: {},
      workflowStore: wfStore(new Map()),
      workflows: { listWorkflows: async () => [{ name: 'in-code', steps: [] }] },
    } as never);

    const listed = await (await as(app, '/workflows')).json() as { name: string }[];
    expect(listed.map((w) => w.name)).toContain('in-code');
  });

  it('leaves the journal-derived store alone — that one IS scoped', async () => {
    // Built from the ALS-aware reader, so everything it writes lands under `org:<id>:`. Measured: an
    // acme-bound admin sees an empty list, gets 404 for the name, and globex's key is untouched by a
    // delete. Refusing it would break the working configuration to punish the broken one.
    const journal = new InMemoryJournal();
    await journal.put('org:globex:__studio_wf__secret', { name: 'secret', steps: [] });
    const app = createStudioApi({ reader: journal, auth: boundAdmin, org: {} } as never);

    expect((await as(app, '/workflows')).status).toBe(200);
    expect((await as(app, '/workflows/secret/def')).status).toBe(404);
    expect(await journal.get('org:globex:__studio_wf__secret'), 'the other org\'s definition was touched').toBeTruthy();
  });
});
