// EVERY route, driven with an application credential that names no end user.
//
// The rule: a `client` credential acts FOR one end user — that is what separates it from an operator
// credential, and the only reason it is trusted to assert a subject at all — so it must name one.
// Silence is refused, not treated as "unchecked".
//
// WHY A ROUTE WALK RATHER THAN A LIST OF CASES. The first version of the subject rules was applied to
// the routes that happened to be under the author's cursor: the read path got an ownership check and
// the write paths did not, so cancelling and resuming another end user's run both answered 200. A
// per-route test suite has the same blind spot as the code it tests — it covers what someone thought
// of. This walks `routeTable`, so a route added later is either enforced or fails here, and the only
// way past it is writing down a reason.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

/**
 * Routes with NO end-user dimension, and why naming one is meaningless there rather than merely
 * unimplemented. Anything absent from this table must refuse a subject-less client request.
 */
const NO_SUBJECT: Record<string, string> = {
  'GET /health': 'liveness; serves no data at all',
  'GET /ready': 'readiness; serves no data at all',
  'GET /agents': 'the agent catalogue is configuration, not one user\'s data',
  'GET /agents/registry': 'approval state of the deployment\'s agents; already admin-gated',
  'POST /agents/registry/:name/approve': 'deployment governance; refused to clients by the write whitelist',
  'POST /agents/registry/:name/block': 'deployment governance; refused to clients by the write whitelist',
  'GET /openapi.json': 'the schema of the API itself',
  'GET /workflows': 'the workflow catalogue is configuration',
  // 'GET /workflows/runs' USED to sit here as "org-level bookkeeping, not per-end-user". That stopped
  // being true the moment a workflow run started carrying an owner: the registry lists runs a named
  // subject started, so the row belongs to somebody. Removed rather than reworded — the walk drives
  // it now, and it answers 400 like every other inventory endpoint.
  'POST /workflows/:name/run': 'a workflow can be an org-level job with no subject at all — an '
    + 'application credential starting a nightly reconciliation names nobody, and that shape is '
    + 'deliberate (registry.ts writes NO owner when none is declared). What it MUST not do is reach '
    + 'a run that belongs to someone else: `ownershipDenied` covers the re-entry/resume path, and '
    + 'strict binding makes a bound caller unable to name a subject other than itself.',
  'GET /usage': 'spend is metered per ORGANIZATION — a client cannot name a subject for it, and is '
    + 'refused outright rather than exempted (403, asserted separately below)',
};

const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
    warnings: [],
  }),
};

function makeApi() {
  const threads = new Map<string, string>();
  const memory = {
    loadContext: async (t: string, o?: { resourceId?: string }) => { if (o?.resourceId) threads.set(t, o.resourceId); return { messages: [] }; },
    append: async () => {},
    getMessages: async () => [],
    getThreadResource: async (t: string) => threads.get(t),
    listThreads: async (o: { resourceId: string }) => [...threads].filter(([, r]) => r === o.resourceId).map(([id, r]) => ({ id, resourceId: r })),
    listAllThreads: async () => [...threads].map(([id, r]) => ({ id, resourceId: r })),
  };
  return createRestApi(
    {
      storage: new InMemoryStorage(),
      memoryFactory: () => memory,
      agents: { a: { model } },
      workflows: { w: { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) } },
    } as never,
    { auth: roleAuth({ client: { token: 'C', orgId: 'acme' }, admin: { token: 'A', orgId: 'acme' } }) } as never,
  );
}

/** A concrete URL for a parameterised path, seeded so the route reaches its own logic. */
const concrete = (path: string) => path.replace(':name', 'a').replace(':id', 'r-seed');

async function drive(api: any, route: { method: string; path: string }, token: string, body?: object) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method: route.method, headers };
  if (!['GET', 'HEAD'].includes(route.method)) {
    init.headers = { ...headers, 'content-type': 'application/json' };
    init.body = JSON.stringify({ runId: 'r-seed', prompt: 'x', input: {}, ...body });
  }
  const res: Response = await api(new Request(`http://x${concrete(route.path)}`, init));
  return res.status;
}

/** Seeds one run owned by `u-ayse`, so the routes under test have something real to refuse access to. */
async function seeded() {
  const api = makeApi();
  await api(new Request('http://x/agents/a/run', {
    method: 'POST',
    headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'r-seed', prompt: 'x', threadId: 't-seed', resourceId: 'u-ayse' }),
  }));
  return api;
}

describe('a client credential must name the end user it acts for', () => {
  it('every route either enforces it or is listed as having no subject', async () => {
    const api = await seeded();
    const table = api.routeTable as { method: string; path: string }[];
    expect(table.length, 'the inventory is empty — this suite would pass vacuously').toBeGreaterThan(0);

    const unenforced: string[] = [];
    for (const route of table) {
      const key = `${route.method} ${route.path}`;
      if (key in NO_SUBJECT) continue;
      const status = await drive(api, route, 'C');
      // 400 = the subject rule; 403 = refused earlier (the write whitelist), which is stricter and
      // therefore also acceptable. Anything else means the route served a client that named nobody.
      if (status !== 400 && status !== 403) unenforced.push(`${key} → ${status}`);
    }
    expect(unenforced,
      'a route served a client credential that named no end user. Either enforce it (clientSubjectDenied) '
      + 'or add it to NO_SUBJECT with a reason — an unexamined route is exactly how the write paths '
      + 'shipped open the first time.').toEqual([]);
  }, 30_000);

  it('and no exemption names a route that no longer exists', async () => {
    const api = await seeded();
    const inventory = new Set((api.routeTable as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(NO_SUBJECT).filter((k) => !inventory.has(k)), 'a stale exemption outlived its route').toEqual([]);
  });

  it('naming one lets the SAME requests through — the rule is not just a wall', async () => {
    // The other half. Without this, deleting every handler body would satisfy the walk above.
    const api = await seeded();
    const ok = async (p: string) => (await api(new Request(`http://x${p}`, { headers: { authorization: 'Bearer C' } }))).status;
    expect(await ok('/runs?resourceId=u-ayse')).toBe(200);
    expect(await ok('/runs/r-seed?resourceId=u-ayse')).toBe(200);
    expect(await ok('/threads?resourceId=u-ayse')).toBe(200);
    expect(await ok('/threads/t-seed/messages?resourceId=u-ayse')).toBe(200);
  });

  it('an OPERATOR credential is untouched — it names nobody by design', async () => {
    // The asymmetry is the rule. An admin works across its organization's data; applying the same
    // requirement to it would be the mistake the first version made by treating "absent" identically
    // for every caller.
    const api = await seeded();
    const ok = async (p: string) => (await api(new Request(`http://x${p}`, { headers: { authorization: 'Bearer A' } }))).status;
    expect(await ok('/runs')).toBe(200);
    expect(await ok('/runs/r-seed')).toBe(200);
    expect(await ok('/threads')).toBe(200);
    expect(await ok('/usage')).toBe(200);
  });

  it('usage is refused to a client outright, not merely unnamed', async () => {
    // 403, not 400: there is no resourceId that would make organization-level spend answerable to an
    // application. A 400 would invite a caller to guess at a value that cannot exist.
    const api = await seeded();
    const res = await api(new Request('http://x/usage', { headers: { authorization: 'Bearer C' } }));
    expect(res.status).toBe(403);
  });
});

describe('no read route may go back to being unnamed', () => {
  // The twin of @gnldev/studio's guard of the same name. This package's read surface is smaller but the
  // failure is identical: a route behind the coarse `allow(req, 'read')` carries no permission, so an
  // RBAC provider cannot tell it apart from any other read — every grant that reads anything reads it.
  // Named routes cost the free tier nothing: the gate reduces `X:read` to `action: 'read'`, which is
  // exactly what these routes already passed.
  it('every read gate in the source names a permission', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').split('\n');
    const unnamed = src
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("allow(c.req.raw, 'read')"))
      .map(({ n }) => {
        for (let i = n - 1; i >= Math.max(0, n - 30); i--) {
          const m = src[i]?.match(/app\.(?:get|post|put|patch|delete)\('([^']*)'/);
          if (m) return m[1]!;
        }
        return `line ${n}`;
      });
    expect(unnamed,
      'a read route is behind the coarse gate, so no permission can distinguish it. Name it with '
      + 'allowP(req, "<group>:read") — see @gnldev/studio PERMISSION_CATALOG for the groups.').toEqual([]);
  });
});
