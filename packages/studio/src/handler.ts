// What this package hands a host: a request in, a response out. Nothing else.
//
// It used to hand back a Hono instance, which the host mounted with its OWN Hono
// (`app.route('/studio', createStudioApp(...))`). That made two things true at once: the host had to
// resolve its Hono version against ours — two majors mean two different classes with the same name,
// merged by `.route()` — and a host running Express, Fastify or Nest had no supported way in at all.
//
// A fetch handler removes both. Hono stays underneath as an implementation detail we can change
// without anyone noticing; Hono hosts mount it with `app.mount(path, handler)`, everyone else bridges
// it (see `@gnldev/studio/node`).
import type { Hono } from 'hono';

/**
 * A web-standard request handler.
 *
 * Callable, and also carries `fetch` — the shape `serve({ fetch })`, Workers and Deno all expect, so
 * the two most common ways to run it are the same object.
 *
 * MOUNT ORDER, on a Hono host. `app.mount()` registers one blanket wildcard per call, where the
 * `app.route()` it replaces unpacked a sub-app's individual routes. So a catch-all mount at `/`
 * swallows everything registered after it: mount the specific paths FIRST. Getting it wrong returns
 * 404 from the buried handler, which reads as a broken package rather than a mount in the wrong
 * order — measured, not theorised (`packages/cli/src/dev-server.ts` hit exactly this).
 */
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
   * stays an implementation detail (see the note at the top of this file), and the handler functions
   * are not exposed either.
   *
   * The same reasoning as `@gnldev/server`'s copy, and it applies here harder: this package's
   * org-scope refusals reached 5 of 9 workflow routes and 2 of 3 `wfStoreRefusal` call sites, and the
   * misses were adjacent routes rather than hard cases. A conformance test that reads the route table
   * sees a new route the day it is added; a list maintained by hand sees it whenever someone
   * remembers.
   */
  routeTable: readonly RouteInfo[];
};

/** One mounted route, as `{ method, path }` — see `FetchHandler.routeTable`. */
export interface RouteInfo {
  /** Uppercase HTTP method, or `ALL` for a method-agnostic mount. */
  method: string;
  /** The registered path pattern, parameters included (`/threads/:id`). */
  path: string;
}

/**
 * Wraps a Hono app as the handler this package returns.
 *
 * Extra arguments are passed through untouched: a Workers runtime calls `fetch(request, env, ctx)`
 * and dropping them would strip the environment from a rig that has no other way to reach it.
 */
export function toFetchHandler(app: Hono): FetchHandler {
  const call = (request: Request, ...rest: unknown[]) => (app.fetch as any)(request, ...rest) as Promise<Response>;
  return Object.assign(call, { fetch: call, routeTable: routeInventory(app) });
}

/**
 * Reads Hono's route table into a stable, deduplicated inventory.
 *
 * Hono registers one entry per handler, so a path sitting behind middleware appears more than once;
 * the conformance suite wants each `method + path` once. Sorted so moving a route within the file does
 * not churn a snapshot of the inventory.
 *
 * `ALL` ENTRIES ARE USUALLY MIDDLEWARE. `app.use('*', …)` lands in the same table as a route, recorded
 * as `ALL /*`, and nothing in the entry separates it from a genuine `app.all('/path')` — only the
 * handler's arity differs, which is how it happens to be written rather than a contract. A caller that
 * DRIVES these entries must skip them or it requests the literal path `/*`.
 *
 * That warning is here rather than in a note because whether they appear depends on configuration:
 * this package's baseline emits none, and one appears as soon as `org` or `auth` is configured
 * (`@gnldev/server` emits none in any configuration at all). A suite written against a fixture with
 * neither enabled never learns the filter is needed, and breaks the first time it runs with auth on.
 *
 * WHAT A HOST SEES IS NOT THIS. `app.route('/api', sub)` unpacks the sub-app, so those routes reappear
 * here prefixed. `app.mount(path, handler)` does not: a host that mounts this handler and then reads
 * its OWN route table gets a single `ALL <path>/*` with all 87 routes hidden underneath. Since
 * `mount()` is the documented way in (see the note at the top of this file), a host cannot build a
 * conformance suite from its own table — it has to read `handler.routeTable`, which is complete because it
 * is computed before any host sees it.
 *
 * Each entry is frozen, not just the array: the same array goes to every caller, so one consumer
 * editing an entry in place would corrupt the inventory for every later reader. `routes.sort(…)`
 * therefore throws; copy first — `[...routeTable].sort(…)`.
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
