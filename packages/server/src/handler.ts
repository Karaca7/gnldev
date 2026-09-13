// What this package hands a host: a request in, a response out — not a Hono instance.
// See @gnldev/studio/src/handler.ts for the reasoning; the shape is deliberately identical, and
// structurally compatible, without either package depending on the other.
import type { Hono } from 'hono';

/** One mounted route, as `{ method, path }` — see `FetchHandler.routeTable`. */
export interface RouteInfo {
  /** Uppercase HTTP method, or `ALL` for a method-agnostic mount. */
  method: string;
  /** The registered path pattern, parameters included (`/agents/:name/run`). */
  path: string;
}

/**
 * NAMED `routeTable`, not `routes`, and that is not a style choice.
 *
 * `routes` is Hono's OWN property: `app.route(path, app)` does `app.routes.map((r) => r.handler)`.
 * A fetch handler is not a Hono instance and `.route()` was never the supported way to mount one —
 * `.mount()` is — but with a `routes` array present the wrong call SUCCEEDS at boot and then throws
 * `r.handler is not a function` on every request. Measured against Hono 4.12:
 *
 *   routes present  ->  boot OK, every request 500
 *   routes absent   ->  boot throws "Cannot read properties of undefined (reading 'map')"
 *
 * The second is the better failure: unsupported usage should fail where it is written, not on the
 * first request in production. Colliding with the framework's own name turned a loud boot error into
 * a quiet one, which is a worse outcome than the introspection is worth.
 */
export type FetchHandler = ((request: Request, ...rest: unknown[]) => Promise<Response>) & {
  fetch: (request: Request, ...rest: unknown[]) => Promise<Response>;
  /**
   * Every route this handler serves, deduplicated and sorted. Introspection only — the Hono instance
   * itself stays hidden, and so do the handler functions.
   *
   * Exists so a test can ask the handler what it exposes instead of maintaining a second list by hand.
   * Every isolation defect this package has shipped had the same shape: a rule applied to the routes
   * someone was looking at rather than to all of them — the scoped-memory check reached 6 of 9 routes,
   * the workflow-store refusal 2 of 3, and the third was found by someone re-reading the file. A list
   * written by hand is a list that goes stale the next time a route is added, which is precisely when
   * the gap appears. Reading it off the router means a new route shows up in the conformance suite
   * without anyone remembering to add it.
   */
  routeTable: readonly RouteInfo[];
}

export function toFetchHandler(app: Hono): FetchHandler {
  const call = (request: Request, ...rest: unknown[]) => (app.fetch as any)(request, ...rest) as Promise<Response>;
  return Object.assign(call, { fetch: call, routeTable: routeInventory(app) });
}

/**
 * Reads Hono's route table into a stable, deduplicated inventory.
 *
 * Hono registers one entry per handler, so a path with middleware in front of it appears several
 * times; the conformance suite wants each `method + path` once. Sorted so a snapshot of the inventory
 * does not churn when a route is moved within the file.
 *
 * `ALL` ENTRIES ARE USUALLY MIDDLEWARE. `app.use('*', …)` lands in the same table as a route, recorded
 * as `ALL /*`, and nothing in the entry distinguishes it from a genuine `app.all('/path')` — the only
 * observable difference is the handler's arity, which is a coincidence of how it happens to be
 * written, not a contract. So they are kept, and a caller that DRIVES these entries has to skip them
 * or it will request the literal path `/*`.
 *
 * The reason that warning is here rather than in a note: whether they appear at all depends on
 * configuration. `@gnldev/server` emits none in any configuration, and `@gnldev/studio` emits none
 * either until `org` or `auth` is set, at which point one appears. A suite written against a fixture
 * that has neither turned on never learns the filter is needed, and breaks the first time someone runs
 * it with auth on. An empty `ALL` list proves nothing about the next fixture.
 *
 * Each entry is frozen, not just the array. The same array is handed to every caller, so a single
 * consumer writing `routes[0].path = …` in place would corrupt the inventory for every later reader —
 * and the intended consumer is a test suite, which is exactly where that happens. One consequence:
 * `routeTable.sort(…)` throws (it sorts in place); copy first — `[...routeTable].sort(…)`.
 */
export function routeInventory(app: Hono): readonly RouteInfo[] {
  const seen = new Map<string, RouteInfo>();
  for (const r of app.routes ?? []) {
    const method = String(r.method).toUpperCase();
    const key = `${method} ${r.path}`;
    if (!seen.has(key)) seen.set(key, Object.freeze({ method, path: r.path }));
  }
  return Object.freeze([...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path))));
}
