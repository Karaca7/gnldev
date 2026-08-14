// What this package hands a host: a request in, a response out. Nothing else.
//
// It used to hand back a Hono instance, which the host mounted with its OWN Hono
// (`app.route('/studio', createStudioApp(...))`). That made two things true at once: the host had to
// Resolve its Hono version against ours — two majors mean two different classes with the same name,
// Merged by `.route()` — and a host running Express, Fastify or Nest had no supported way in at all.
//
// A fetch handler removes both. Hono stays underneath as an implementation detail we can change
// Without anyone noticing; Hono hosts mount it with `app.mount(path, handler)`, everyone else bridges
// It (see `@gnldev/studio/node`).
import type { Hono } from 'hono';

/**
 * A web-standard request handler.
 *
 * Callable, and also carries `fetch` — the shape `serve({ fetch })`, Workers and Deno all expect, so
 * The two most common ways to run it are the same object.
 *
 * MOUNT ORDER, on a Hono host. `app.mount()` registers one blanket wildcard per call, where the
 * `app.route()` it replaces unpacked a sub-app's individual routes. So a catch-all mount at `/`
 * Swallows everything registered after it: mount the specific paths FIRST. Getting it wrong returns
 * 404 from the buried handler, which reads as a broken package rather than a mount in the wrong
 * Order — measured, not theorised (`packages/cli/src/dev-server.ts` hit exactly this).
 */
export type FetchHandler = ((request: Request, ...rest: unknown[]) => Promise<Response>) & {
  fetch: (request: Request, ...rest: unknown[]) => Promise<Response>;
};

/**
 * Wraps a Hono app as the handler this package returns.
 *
 * Extra arguments are passed through untouched: a Workers runtime calls `fetch(request, env, ctx)`
 * And dropping them would strip the environment from a rig that has no other way to reach it.
 */
export function toFetchHandler(app: Hono): FetchHandler {
  const call = (request: Request, ...rest: unknown[]) => (app.fetch as any)(request, ...rest) as Promise<Response>;
  return Object.assign(call, { fetch: call });
}
