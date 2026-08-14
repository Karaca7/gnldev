// Binding the REST API to a Node server — Express, Fastify, Koa, Nest, or bare `node:http`.
//
// The twin of packages/studio/src/node.ts, and deliberately a copy rather than an import. A backend
// That wants agents and no dashboard had to install @gnldev/studio just to reach this function,
// Which drags @gnldev/studio-ui — a React app — into a service that will never render a page. That
// Is backwards, and one subpath is a smaller price than that dependency.
//
// The alternative, importing it from the sibling package, was tried and is worse than it looks: a
// Cross-package runtime import resolves through the sibling's BUILT output, so a stale dist turns
// The call into `undefined` with no error until something downstream fails on empty input. Measured
// In this repo the same afternoon, in @gnldev/agui, where it emptied an SSE stream and every test in
// The package failed on `JSON.parse('')`. This file follows the convention sse.ts already set here.
//
// KEEP IN SYNC with packages/studio/src/node.ts. If they drift, the two packages answer the same
// Misconfiguration differently, which is worse than either answer.
//
// Kept on a subpath so the root export stays runtime-neutral: importing the package must not drag
// Node's types into a Workers or Deno build.
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchHandler } from './handler.js';

const CARRIES_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True when the request announced a body and something already drained it.
 *
 * A body parser mounted ahead of this handler — `express.json()`, `koa-bodyparser`, Fastify's
 * Built-in JSON parser — reads the stream to the end and hands the result to the framework, not to
 * Us. What arrives here is a POST with no readable body, and the endpoint answers the only thing it
 * Can: "runId is required". Measured on a real Express app: the identical request returns 200 with a
 * Model answer without `express.json()`, and that 400 with it. The message accuses the caller of a
 * Mistake the caller did not make, which is worse than failing.
 *
 * Detection is deliberately narrow — a body was ANNOUNCED (content-length or chunked) and the
 * Readable side is ALREADY finished. A GET nobody read does not match; neither does a bodyless POST.
 */
function bodyAlreadyConsumed(req: IncomingMessage): boolean {
  if (!CARRIES_BODY.has(req.method ?? '')) return false;
  const announced = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  return announced && req.readableEnded;
}

/**
 * Turns a fetch handler into a Node request listener.
 *
 * @experimental Closes the SSE/flush class of bug inside the Node bridge — a hand-written bridge
 * That omits `res.flushHeaders()` withholds the head until the first chunk, so a quiet event stream
 * Hangs the client forever and nothing throws. It also answers plainly when a body parser upstream
 * Has already drained the request, instead of letting the endpoint blame the caller.
 *
 * What it does NOT do: audit the rest of your middleware chain, or touch path prefixes — a host that
 * Mounts under a sub-path has already stripped it from `req.url` (Express) or has not (Koa, Fastify,
 * Node:http), and only the host knows which.
 *
 * ```ts
 * Const api = createRestApi(config);
 *
 * Express().use('/api', toNodeHandler(api));                // Express — before express.json()
 * Await fastify.register(middie); fastify.use('/api', toNodeHandler(api));   // Fastify
 * Koa.use(c2k((rq, rs, _next) => toNodeHandler(api)(rq, rs)));   // Koa — three params, see below
 * CreateServer(toNodeHandler(api));                         // node:http
 * ```
 *
 * On Koa, the middleware must declare THREE parameters even though it never calls the third:
 * `koa-connect` switches on `fn.length` and, below three, assumes the middleware does not terminate
 * The response — it calls `next()` immediately and Koa writes its own 404 over what was already
 * Sent. Measured: `ERR_HTTP_HEADERS_SENT` and a 404 on every route, from a two-parameter version of
 * The same working code.
 *
 * Bind at the MIDDLEWARE layer, never as a route, and put it ahead of the body parser. Measured:
 * `fastify.all('/api/*', …)` runs AFTER Fastify's built-in JSON parser has drained the stream —
 * Every GET passes, a POST with a body answers 400. Through `@fastify/middie` the same handler runs
 * Before parsing and works, with the host's own routes keeping their parsed bodies.
 */
export function toNodeHandler(handler: FetchHandler) {
  const listener = getRequestListener(handler.fetch as any);
  return (req: IncomingMessage, res: ServerResponse) => {
    // Deliberately NOT re-serialising `req.body` back into a stream. It would make the common case
    // Work and quietly change the bytes — key order, unicode escaping, and nothing at all for
    // Multipart or a raw payload — so a misordered chain would keep running until the day it
    // Matters. Ordering is also the answer the ecosystem settled on: better-auth's Node handler
    // Documents the same constraint, mount before the parser, for the same reason.
    if (bodyAlreadyConsumed(req)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'request body was already consumed by a body parser mounted ahead of this handler '
          + '(express.json, koa-bodyparser, Fastify\'s built-in JSON parser). Mount the GNL handler '
          + 'BEFORE the parser — the parser still serves your own routes after it.',
        code: 'body_consumed_upstream',
      }));
      return;
    }
    return listener(req, res);
  };
}
