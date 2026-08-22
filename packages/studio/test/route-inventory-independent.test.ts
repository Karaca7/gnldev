// The same conformance questions as @gnldev/server's copy, plus the two this package has and that
// one does not: it exposes TWO factories, and one of them mounts the other.
//
// `createStudioApp` does `app.route('/api', studioApiApp(opts))`. `.route()` UNPACKS a sub-app's
// individual routes, so the inventory sees through it; `app.mount()` — which is how a HOST is told to
// attach this handler — does not, and collapses to a single wildcard. That difference decides whether
// a conformance suite reading the inventory can see the API surface at all, so it is asserted rather
// than assumed.
//
// The `ALL` question is answered here too, because this is the package where it actually bites: an
// `app.use('*')` middleware is recorded by Hono in the same table as a route, and it appears only in
// some configurations.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, createStudioApp } from '../src/server.js';
import { routeInventory } from '../src/handler.js';

type Handler = { routeTable: readonly { method: string; path: string }[] } & ((r: Request) => Promise<Response>);

const api = (opts: object = {}) => createStudioApi({ reader: new InMemoryJournal(), ...opts } as never) as unknown as Handler;
const app = (opts: object = {}) => createStudioApp({ reader: new InMemoryJournal(), ...opts } as never) as unknown as Handler;
const sig = (h: Handler) => h.routeTable.map((r) => `${r.method} ${r.path}`);

/**
 * A wildcard that serves files is only distinguishable from an unrouted path when the file EXISTS —
 * `/assets/probe` and a path with no route both fall through to Hono's default 404. Measured:
 * `/assets/probe` -> 404 "404 Not Found", `/assets/<a real built asset>` -> 200. So the driver
 * substitutes a real filename. This is a property a conformance suite has to handle too, not a defect
 * in the inventory.
 */
const uiAssets = join(import.meta.dirname, '..', '..', 'studio-ui', 'dist', 'assets');
const realAsset = existsSync(uiAssets) ? readdirSync(uiAssets)[0] : undefined;
const OVERRIDES: Record<string, string | undefined> = { '/assets/*': realAsset ? `/assets/${realAsset}` : undefined };

const concrete = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, 'X').replace(/\/\*$/, '/probe').replace(/\*/g, 'probe');
const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rj) => setTimeout(() => rj(new Error('TIMEOUT')), ms))]);

/** Entries that do not route. Streams and non-404 answers both count as routed. */
async function unroutedEntries(h: Handler): Promise<string[]> {
  const miss = await h(new Request('http://x/definitely-not-a-route-zzz'));
  const missBody = await miss.text();
  const out: string[] = [];
  for (const r of h.routeTable.filter((x) => x.method !== 'ALL')) {
    if (r.path in OVERRIDES && OVERRIDES[r.path] === undefined) continue; // no built UI to probe with
    const url = OVERRIDES[r.path] ?? concrete(r.path);
    const init: RequestInit = { method: r.method };
    if (!['GET', 'HEAD'].includes(r.method)) {
      init.headers = { 'content-type': 'application/json' };
      init.body = '{}';
    }
    let res: Response;
    try { res = await race(h(new Request(`http://x${url}`, init)), 4000); }
    catch (e) { out.push(`${r.method} ${r.path} (${(e as Error).message})`); continue; }
    if (res.status !== miss.status) continue;
    let body: string;
    try { body = await race(res.text(), 2000); } catch { continue; }
    if (body === missBody) out.push(`${r.method} ${r.path}`);
  }
  return out;
}

describe('the inventory describes what the handler actually serves', () => {
  it('createStudioApi: every entry routes', async () => {
    const h = api();
    expect(h.routeTable.length, 'the inventory is empty — this test proves nothing').toBeGreaterThan(50);
    expect(await unroutedEntries(h), 'the inventory lists routes the handler does not serve').toEqual([]);
  }, 60_000);

  it('createStudioApp: every entry routes', async () => {
    const h = app();
    expect(await unroutedEntries(h), 'the inventory lists routes the handler does not serve').toEqual([]);
  }, 60_000);

  // The direction that matters: a missing entry is a route the conformance suite never tests. Both
  // factories are registered in one file, so the union of their inventories must cover it.
  it('every route registered in the source appears in one of the two inventories', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const declared = [...new Set([...src.matchAll(/\bapp\.(get|post|put|delete|patch|all)\(\s*'([^']+)'/g)]
      .map((m) => `${m[1] === 'all' ? 'ALL' : m[1]!.toUpperCase()} ${m[2]}`))];

    // `createStudioApp` re-hosts the API under `/api`, so an API route counts either way.
    const covered = new Set([...sig(api()), ...sig(app()).map((s) => s.replace(' /api/', ' /'))]);

    expect(declared.length, 'no route registrations were found — the scan is broken').toBeGreaterThan(50);
    expect(declared.filter((d) => !covered.has(d)), 'a registered route is in neither inventory').toEqual([]);
  });

  it('lists nothing twice, sorted by path then method', () => {
    const routeTable = api().routeTable;
    expect(new Set(sig(api())).size).toBe(routeTable.length);
    const expected = [...routeTable].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    expect(routeTable.map((r) => `${r.method} ${r.path}`)).toEqual(expected.map((r) => `${r.method} ${r.path}`));
  });
});

describe('a sub-app mounted with .route()', () => {
  // If this stopped unpacking, the API surface would vanish from `createStudioApp`'s inventory and a
  // conformance suite reading it would silently test five UI routes and nothing else.
  it('is fully visible: every createStudioApi route reappears under /api', () => {
    const inner = sig(api());
    const outer = sig(app());
    const missing = inner.filter((s) => {
      const [m, p] = s.split(' ');
      return !outer.includes(`${m} /api${p}`);
    });

    expect(inner.length).toBeGreaterThan(50);
    expect(missing, '.route() stopped unpacking — the whole API surface is invisible to the inventory').toEqual([]);
  });

  // The wildcard, driven directly, so the override above cannot hide a broken static route.
  it('serves a real built asset through its wildcard', async () => {
    if (!realAsset) { expect(existsSync(uiAssets), 'no built UI to test against').toBe(false); return; }
    const res = await app()(new Request(`http://x/assets/${realAsset}`));

    expect(res.status, 'the assets wildcard is registered but serves nothing').toBe(200);
    const miss = await app()(new Request('http://x/assets/definitely-not-a-file.js'));
    expect(miss.status, 'a missing asset should still 404 rather than serve something else').toBe(404);
  });

  it('and the outer handler adds only its own UI routes on top', () => {
    const extra = sig(app()).filter((s) => !s.includes(' /api/'));
    expect(extra.every((s) => s.startsWith('GET ')), 'a non-GET UI route appeared').toBe(true);
    expect(sig(app())).toHaveLength(sig(api()).length + extra.length);
  });
});

/**
 * KNOWN LIMIT — `app.mount()` does not unpack, and `mount()` is how a host is told to attach this.
 *
 * The handler's OWN `routes` is complete, because it is read off this package's app before any host
 * sees it. But a Hono host that does `host.mount('/studio', handler)` and then reads `host.routeTable`
 * gets exactly one entry — `ALL /studio/*` — with all 87 routes hidden underneath. A host building a
 * conformance suite from its own route table therefore learns nothing about what it just mounted; it
 * has to read `handler.routeTable` instead.
 *
 * Measured against Hono directly, so the contrast between the two mounting verbs is on the record.
 */
describe('what a host sees after mounting the handler', () => {
  it('mount() collapses the whole surface into one wildcard', () => {
    const host = new Hono();
    host.mount('/studio', api() as unknown as (r: Request) => Promise<Response>);

    const hostRoutes = routeInventory(host);
    expect(hostRoutes.map((r) => `${r.method} ${r.path}`),
      'mount() started unpacking — this limit can be removed from the JSDoc').toEqual(['ALL /studio/*']);
  });

  it('while route() unpacks, which is why the API sub-app is visible', () => {
    const inner = new Hono();
    inner.get('/x', (c) => c.text('x'));
    inner.post('/y', (c) => c.text('y'));
    const host = new Hono();
    host.route('/studio', inner);

    expect(routeInventory(host).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /studio/x', 'POST /studio/y']);
  });

  it('but the handler still reports its own surface in full', () => {
    const h = api();
    const host = new Hono();
    host.mount('/studio', h as unknown as (r: Request) => Promise<Response>);

    expect(h.routeTable.length, 'mounting mutated the handler\'s own inventory').toBeGreaterThan(50);
  });
});

describe('ALL entries are middleware, not routes', () => {
  // Hono records `app.use()` in the same table as a route. Confirmed against a bare app so the claim
  // does not rest on reading this package's source.
  it('Hono records app.use() as an ALL entry', () => {
    const t = new Hono();
    t.use('*', async (_c, next) => next());
    t.get('/x', (c) => c.text('x'));

    expect(routeInventory(t).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /x', 'ALL /*']
      .sort((a, b) => a.split(' ')[1]!.localeCompare(b.split(' ')[1]!)));
  });

  // And the trap: they are CONFIG-DEPENDENT here. A suite whose fixture configures neither `org` nor
  // `auth` never sees one, so it never learns it has to filter — and then breaks on a deployment that
  // does. Driving `ALL /*` means requesting the literal path `/*`.
  it('appear in this package only once `org` or `auth` is configured', () => {
    const allOf = (h: Handler) => h.routeTable.filter((r) => r.method === 'ALL').map((r) => r.path);
    const authProvider = {
      authenticate: () => ({ roles: ['admin'] }),
      authorize: () => ({ allow: true }),
      capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
    };

    expect(allOf(api()), 'the baseline fixture already has one — the trap below is not reproducible').toEqual([]);
    expect(allOf(api({ org: {} })), '`org` no longer registers middleware').toEqual(['/*']);
    expect(allOf(api({ auth: authProvider })), '`auth` no longer registers middleware').toEqual(['/*']);
    expect(allOf(api({ org: {}, auth: authProvider })), 'two middlewares were not deduplicated to one entry').toEqual(['/*']);
  });

  // The real route set must NOT move with configuration, or a suite built from one fixture has a
  // blind spot for everything the fixture left off.
  it.each([
    ['org', { org: {} }],
    ['resume', { resume: async () => ({}) }],
    ['queue and cache', { queue: { listJobs: () => [] }, cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }) } }],
    ['vectors', { vectors: { search: () => [] } }],
    ['workflowStore', { workflowStore: { list: () => [], get: () => undefined, set: () => {}, delete: () => {} } }],
    ['an agent runner', { gnl: { listAgents: () => [], run: async () => ({ text: 'x' }) } }],
  ])('%s does not change the non-middleware route set', (_label, opts) => {
    const real = (h: Handler) => sig(h).filter((s) => !s.startsWith('ALL '));
    expect(real(api(opts)), 'the route set changed with configuration').toEqual(real(api()));
  });
});

describe('what the inventory exposes', () => {
  it('method and path only — no handler, no Hono instance', () => {
    const h = api();
    for (const r of h.routeTable) expect(Object.keys(r).sort()).toEqual(['method', 'path']);
    expect(Object.keys(h).sort()).toEqual(['fetch', 'routeTable']);
    expect(JSON.stringify(h.routeTable)).not.toMatch(/function|=>/);
  });

  it('with uppercase methods and rooted paths', () => {
    for (const r of api().routeTable) {
      expect(r.method).toBe(r.method.toUpperCase());
      expect(r.path.startsWith('/'), `${r.path} is not rooted`).toBe(true);
    }
  });
});

/**
 * Same DEEP freeze as @gnldev/server's copy — array and entries both. This recorded the shallow
 * version as a known boundary until the entries were frozen; see the matching block in
 * packages/server/test/route-inventory-independent.test.ts for why it mattered here too (the array is
 * computed once and handed to every caller, so one in-place edit reached every later reader).
 */
describe('what freezing protects', () => {
  it('the array and the entries inside it', () => {
    const h = api();
    const original = h.routeTable[0]!.path;

    expect(Object.isFrozen(h.routeTable)).toBe(true);
    expect(h.routeTable.every((r) => Object.isFrozen(r)), 'some entry escaped the freeze').toBe(true);
    expect(() => ((h.routeTable[0] as { path: string }).path = 'HACKED'), 'an entry accepted an in-place write').toThrow(TypeError);
    expect(h.routeTable[0]!.path, 'the inventory was corrupted for every later reader').toBe(original);
  });
});
