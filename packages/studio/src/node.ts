// Binding the handler to a Node server — Express, Fastify, Nest, or bare `node:http`.
//
// A thin facade, on purpose. Writing the bridge by hand is about ten lines and it works, right up
// until it doesn't: measured on a real server, a hand-written bridge that omits `res.flushHeaders()`
// serves SSE with the head withheld until the first chunk. A quiet event stream then hangs the
// client forever, and NOTHING throws — the live screen simply never opens. That is the worst shape a
// defect can take, and it is why this is a function rather than a snippet in a README: a snippet
// lives in somebody else's repository and loses a line to a tidy-up; an import is either there or
// it is not.
//
// `@hono/node-server` already solves this correctly and this package already depends on it, so the
// bridge is theirs. If this file ever grows its own request/response translation, the reason for it
// existing is gone — take it out instead.
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
 * built-in JSON parser — reads the stream to the end and hands the result to the framework, not to
 * us. What arrives here is a POST with no readable body, and the endpoint answers the only thing it
 * can: "runId is required". Measured on a real Express app: the identical request returns 200 with a
 * model answer without `express.json()`, and that 400 with it. The message accuses the caller of a
 * mistake the caller did not make, which is worse than failing.
 *
 * Detection is deliberately narrow — a body was ANNOUNCED (content-length or chunked) and the
 * readable side is ALREADY finished. A GET nobody read does not match; neither does a bodyless POST.
 */
function bodyAlreadyConsumed(req: IncomingMessage): boolean {
  if (!CARRIES_BODY.has(req.method ?? '')) return false;
  const announced = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  return announced && req.readableEnded;
}

/**
 * Turns a fetch handler into a Node request listener.
 *
 * @experimental Closes the SSE/flush class of bug inside the Node bridge, and answers plainly when a
 * body parser upstream has already drained the request. `compression` no longer buffers our streams
 * either — that one is fixed at the source, in the SSE response's `Cache-Control: no-transform`
 * (see `sse.ts`), so it holds on every host rather than only the ones that come through here.
 *
 * What it still does NOT do: audit the rest of your middleware chain, and touch path prefixes — a
 * host that mounts under a sub-path has already stripped it from `req.url` (Express) or has not
 * (Koa, Fastify, node:http), and only the host knows which.
 *
 * ```ts
 * const studio = createStudioApp({ reader: journal });
 *
 * express().use('/studio', toNodeHandler(studio));          // Express — before express.json()
 * await fastify.register(middie); fastify.use('/studio', toNodeHandler(studio));   // Fastify
 * koa.use(c2k(mw));                                         // Koa — koa-connect, before the parser
 * createServer(toNodeHandler(studio));                      // node:http
 * ```
 *
 * Bind at the MIDDLEWARE layer, never as a route, and put it ahead of the body parser. Measured:
 * `fastify.all('/studio/*', …)` runs AFTER Fastify's built-in JSON parser has drained the stream —
 * every GET passes, a POST with a body answers 400. Through `@fastify/middie` the same handler runs
 * before parsing and works, with the host's own routes keeping their parsed bodies.
 * ```
 */
export function toNodeHandler(handler: FetchHandler) {
  const listener = getRequestListener(handler.fetch as any);
  return (req: IncomingMessage, res: ServerResponse) => {
    // Say what actually happened, instead of letting the endpoint guess.
    //
    // Deliberately NOT re-serialising `req.body` back into a stream. It would make the common case
    // work and quietly change the bytes — key order, unicode escaping, and nothing at all for
    // multipart or a raw payload — so a misordered chain would keep running until the day it
    // matters. Ordering is also the answer the ecosystem settled on: better-auth's Node handler
    // documents the same constraint, mount before the parser, for the same reason.
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
