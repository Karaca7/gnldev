// Calling a handler in a test, the way a host calls it in production.
//
// The factories used to return a Hono app, whose `.request(path, init)` helper every test leaned on.
// They return a fetch handler now, so a test builds the Request itself — which is also what an
// Express bridge or a Workers runtime does, meaning the tests exercise the real entry point rather
// than a testing convenience that no host has.
//
// Deliberately NOT exported from the package: a test helper in the public API is a promise nobody
// asked for.
export type AnyHandler = (request: Request, ...rest: unknown[]) => Promise<Response>;

/** `call(api, '/runs')` — the host is `http://x` unless the path already carries one. */
export function call(handler: AnyHandler, path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `http://x${path}`;
  return handler(new Request(url, init));
}
