// What this package hands a host: a request in, a response out — not a Hono instance.
// See @gnldev/studio/src/handler.ts for the reasoning; the shape is deliberately identical, and
// structurally compatible, without either package depending on the other.
import type { Hono } from 'hono';

export type FetchHandler = ((request: Request, ...rest: unknown[]) => Promise<Response>) & {
  fetch: (request: Request, ...rest: unknown[]) => Promise<Response>;
};

export function toFetchHandler(app: Hono): FetchHandler {
  const call = (request: Request, ...rest: unknown[]) => (app.fetch as any)(request, ...rest) as Promise<Response>;
  return Object.assign(call, { fetch: call });
}
