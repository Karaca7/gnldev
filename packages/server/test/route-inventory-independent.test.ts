// The route inventory is only worth having if it is COMPLETE and ACCURATE.
//
// Its whole purpose is that a conformance suite reads it instead of a hand-maintained list, so the two
// failure modes are asymmetric. A phantom entry costs a confusing test. A MISSING entry is a route the
// conformance suite will never test — which is exactly the shape of every isolation defect this repo
// has shipped, and the reason the inventory exists.
//
// So both directions are checked here:
//   * every entry is driven against the real handler and must actually route;
//   * every route registered in the source appears in the inventory.
//
// And the properties a suite depends on: that the list does not change with configuration (or the
// suite has a blind spot for whatever the fixture did not enable), that `ALL` entries are identified
// for what they are, and that reading the inventory exposes nothing but method and path.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { routeInventory } from '../src/handler.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};
const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };

const base = () => ({ journal: new InMemoryJournal(), agents: { a: { model } } });
const mk = (cfg?: object, opts?: object) => createRestApi({ ...base(), ...cfg } as never, opts as never);
const sig = (h: { routeTable: readonly { method: string; path: string }[] }) => h.routeTable.map((r) => `${r.method} ${r.path}`);

/** A concrete URL for a pattern: `/agents/:name/run` → `/agents/X/run`. */
const concrete = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, 'X').replace(/\/\*$/, '/probe').replace(/\*/g, 'probe');
const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rj) => setTimeout(() => rj(new Error('TIMEOUT')), ms))]);

describe('the inventory describes what the handler actually serves', () => {
  // Driven, not asserted against a literal. A snapshot of 18 strings would pass while every one of
  // them pointed at nothing.
  it('every entry routes — none falls through to the unrouted 404', async () => {
    const api = mk();
    // What "unrouted" looks like on this handler, measured rather than assumed: a route that matched
    // and CHOSE to answer 404 is a routed entry, and the two must not be conflated.
    const miss = await api(new Request('http://x/definitely-not-a-route-zzz'));
    const missBody = await miss.text();
    expect(miss.status, 'the unrouted probe did not 404 — the discriminator is broken').toBe(404);

    const unrouted: string[] = [];
    for (const r of api.routeTable.filter((x) => x.method !== 'ALL')) {
      const init: RequestInit = { method: r.method };
      if (!['GET', 'HEAD'].includes(r.method)) {
        init.headers = { 'content-type': 'application/json' };
        init.body = '{}';
      }
      let res: Response;
      try { res = await race(api(new Request(`http://x${concrete(r.path)}`, init)), 4000); }
      catch (e) { unrouted.push(`${r.method} ${r.path} (${(e as Error).message})`); continue; }
      if (res.status !== miss.status) continue; // a different status means it routed
      let body: string;
      try { body = await race(res.text(), 2000); } catch { continue; } // an open stream is routed
      if (body === missBody) unrouted.push(`${r.method} ${r.path}`);
    }

    expect(api.routeTable.length, 'the inventory is empty — this test proves nothing').toBeGreaterThan(0);
    expect(unrouted, 'the inventory lists routes the handler does not serve').toEqual([]);
  });

  // The direction that matters more: a route the inventory omits is one the conformance suite will
  // never see. Read off the source rather than a list, so adding a route without registering it in the
  // inventory is impossible to do quietly.
  it('every route registered in the source appears in the inventory', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const declared = [...new Set([...src.matchAll(/\bapp\.(get|post|put|delete|patch|all|use)\(\s*'([^']+)'/g)]
      .map((m) => `${m[1] === 'use' || m[1] === 'all' ? 'ALL' : m[1]!.toUpperCase()} ${m[2]}`))];
    const inventory = sig(mk());

    expect(declared.length, 'no route registrations were found — the scan is broken, not the inventory').toBeGreaterThan(10);
    expect(declared.filter((d) => !inventory.includes(d)), 'a registered route is missing from the inventory').toEqual([]);
  });

  it('and lists nothing twice, in a stable order', () => {
    const routeTable = mk().routeTable;
    const inventory = sig(mk());
    expect(new Set(inventory).size, 'the inventory contains duplicates').toBe(inventory.length);

    // Sorted by PATH then METHOD — not by the rendered `"METHOD path"` string, which orders
    // differently and is the easy thing to assert by mistake.
    const expected = [...routeTable].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    expect(routeTable.map((r) => `${r.method} ${r.path}`),
      'the inventory is not sorted, so a snapshot churns when a route moves in the file')
      .toEqual(expected.map((r) => `${r.method} ${r.path}`));

    // Two entries sharing a path must be adjacent and method-ordered.
    const paths = routeTable.map((r) => r.path);
    expect(paths, 'entries for the same path are not grouped together').toEqual([...paths].sort());
  });
});

describe('the inventory does not depend on configuration', () => {
  // If it did, a suite built from one fixture would silently skip whatever that fixture did not
  // enable — the blind spot the inventory exists to remove.
  it.each([
    ['no agents', { agents: {} }, undefined],
    ['three agents', { agents: { a: { model }, b: { model }, c: { model } } }, undefined],
    ['workflows registered', { workflows: { w: wf } }, undefined],
    ['requireAgentApproval', {}, { requireAgentApproval: true }],
    ['org configured', {}, { org: {} }],
    ['auth on', {}, { auth: { read: () => true, write: () => true } }],
    ['limits set', {}, { limits: { maxToolCalls: 1 } }],
    ['a custom title', {}, { title: 'X' }],
  ])('%s serves the same route set', (_label, cfg, opts) => {
    expect(sig(mk(cfg, opts)), 'the route set changed with configuration').toEqual(sig(mk()));
  });

  it('is 18 routes for this package, and says so in one place', () => {
    // A count, deliberately: it is what makes "a route was added" visible in review. If it changes,
    // read the diff above it — the set is asserted, this is the tripwire.
    expect(mk().routeTable).toHaveLength(20);
  });
});

describe('what a conformance suite must know before using it', () => {
  // `ALL` entries are Hono's record of `app.use()`, i.e. MIDDLEWARE, not routes. Driving one means
  // sending a request to the literal path `/*`. A suite that iterates the inventory has to filter
  // them, and the trap is that they are CONFIG-DEPENDENT: this package registers none in any
  // configuration, so a suite written here never learns the filter is needed — and @gnldev/studio
  // grows one the moment `org` or `auth` is configured.
  it('this package contributes no ALL entries in any configuration', () => {
    for (const [, cfg, opts] of [
      ['plain', {}, undefined], ['org', {}, { org: {} }],
      ['auth', {}, { auth: { read: () => true, write: () => true } }],
    ] as const) {
      expect(mk(cfg as object, opts as object).routeTable.filter((r) => r.method === 'ALL'),
        'an ALL entry appeared — a suite driving the inventory would request the literal path').toEqual([]);
    }
  });

  it('every entry has an uppercase method and a path that starts with a slash', () => {
    for (const r of mk().routeTable) {
      expect(r.method, `${r.method} is not uppercase`).toBe(r.method.toUpperCase());
      expect(r.path.startsWith('/'), `${r.path} is not rooted`).toBe(true);
    }
  });

  it('exposes method and path and nothing else — no handler, no closure', () => {
    const api = mk();
    for (const r of api.routeTable) expect(Object.keys(r).sort()).toEqual(['method', 'path']);
    expect(Object.keys(api).sort(), 'the handler grew a property that is not part of its contract')
      .toEqual(['fetch', 'routeTable']);
    // The Hono instance itself must not be reachable from the handler.
    expect(JSON.stringify(api.routeTable), 'a handler reference is serialised into the inventory').not.toMatch(/function|=>/);
  });

  // The dedup key must include the METHOD. This package happens to register no path with two methods,
  // so removing the method from the key is INDISTINGUISHABLE here — measured, that mutation survives
  // every other test in this file. @gnldev/studio has 11 such paths and catches it, but a property of
  // the inventory should not be tested only where the fixture happens to expose it. `routeInventory`
  // is exported, so it can be asked directly.
  it('keeps two methods on one path as two entries', () => {
    const probe = new Hono();
    probe.get('/thing/:id', (c) => c.text('g'));
    probe.delete('/thing/:id', (c) => c.text('d'));
    probe.post('/thing/:id', (c) => c.text('p'));

    expect(routeInventory(probe).map((r) => `${r.method} ${r.path}`),
      'the dedup key ignores the method, so a path collapses to whichever verb was registered first')
      .toEqual(['DELETE /thing/:id', 'GET /thing/:id', 'POST /thing/:id']);
  });

  // ...and the deduplication it IS for: Hono records one entry per handler, so middleware in front of
  // a route repeats it.
  it('collapses the repeated entries Hono records for one route behind middleware', () => {
    const probe = new Hono();
    probe.use('/guarded', async (_c, next) => next());
    probe.use('/guarded', async (_c, next) => next());
    probe.get('/guarded', (c) => c.text('x'));

    expect(routeInventory(probe).filter((r) => r.method === 'GET'), 'a route behind middleware is listed more than once')
      .toEqual([{ method: 'GET', path: '/guarded' }]);
  });

  it('is the same list whether read from the handler or from routeInventory directly', () => {
    // `routeInventory` is exported, so a host can call it on its own app. The two must not drift.
    expect(typeof routeInventory).toBe('function');
    expect(sig(mk())).toEqual(sig({ routeTable: mk().routeTable }));
  });
});

/**
 * The freeze is DEEP — array and entries both.
 *
 * This block used to record the opposite as a known boundary: `Object.freeze` on the array stopped
 * `push`/`splice` while each `RouteInfo` stayed mutable, and since `handler.routeTable` hands the SAME
 * array to every caller, one consumer writing `handler.routeTable[0].path = 'x'` corrupted the inventory
 * for every later reader — with a test suite, where a stray in-place edit is exactly what happens, as
 * the intended consumer. `Object.freeze(entry)` inside the map loop closed it, so these are inverted
 * rather than deleted: the boundary was written down, and then it moved.
 *
 * The milder trap in the same place stands and is documented in the JSDoc: a frozen array makes the
 * natural `handler.routeTable.sort(...)` throw, because `sort` mutates in place. Copy first.
 */
describe('what freezing the inventory does and does not protect', () => {
  it('the array cannot be resized', () => {
    expect(() => (mk().routeTable as { push: (x: unknown) => void }).push({ method: 'GET', path: '/x' })).toThrow(TypeError);
    expect(Object.isFrozen(mk().routeTable)).toBe(true);
  });

  it('and an individual entry cannot be rewritten either', () => {
    const api = mk();
    const original = api.routeTable[0]!.path;

    expect(() => ((api.routeTable[0] as { path: string }).path = 'HACKED'), 'an entry accepted an in-place write').toThrow(TypeError);
    expect(api.routeTable[0]!.path, 'the inventory was corrupted for every later reader').toBe(original);
    expect(api.routeTable.every((r) => Object.isFrozen(r)), 'some entry escaped the freeze').toBe(true);
  });

  it('and sorting it in place throws, because the array is frozen', () => {
    expect(() => (mk().routeTable as { sort: (f: () => number) => unknown }).sort(() => 0)).toThrow(TypeError);
    expect(() => [...mk().routeTable].sort(), 'a copy cannot be sorted either').not.toThrow();
  });
});
