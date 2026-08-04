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
import type { FetchHandler } from './handler.js';

/**
 * Turns a fetch handler into a Node request listener.
 *
 * @experimental Closes the SSE/flush class of bug inside the Node bridge. It does NOT make your own
 * middleware chain safe — `compression` and friends can still buffer a stream — and it does not
 * touch path prefixes: a host that mounts under a sub-path has already stripped it from `req.url`,
 * so do not add it back (an easy 404, and one that reads like the handler is broken).
 *
 * ```ts
 * const studio = createStudioApp({ reader: journal });
 *
 * express().use('/studio', toNodeHandler(studio));          // Express
 * fastify.all('/studio/*', (rq, rp) => toNodeHandler(studio)(rq.raw, rp.raw));
 * createServer(toNodeHandler(studio));                      // node:http
 * ```
 */
export function toNodeHandler(handler: FetchHandler) {
  return getRequestListener(handler.fetch as any);
}
