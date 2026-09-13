// What breaks when the handler is bound to a Node server — the class of defect that only appears
// once a framework owns the socket.
//
// The rest of this suite calls the handler directly (`call(api, '/runs')`), which is the right shape
// for testing endpoints and structurally cannot see any of this: the traps below all live between
// the socket and the handler. Every one of them was found by hand, on a live server bound to a real
// framework, and every one of them is silent — nothing throws, a status code just quietly means
// something other than what it says.
//
// Deliberately no Express/Fastify/Koa dependency. Their quirks are theirs; what has to hold here is
// OUR bridge's behaviour, and `node:http` reproduces every case — including a body parser, which is
// simulated by draining the request before the handler sees it, exactly as `express.json()` does.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { toNodeHandler } from '../src/node.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Boots a real listener on an ephemeral port and returns its base URL. */
async function serve(onRequest: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(onRequest);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function studio() {
  return toNodeHandler(createStudioApi({ reader: new InMemoryJournal() }));
}

describe('toNodeHandler — binding to a Node server', () => {
  it('serves a route over a real socket', async () => {
    const base = await serve(studio());
    const res = await fetch(`${base}/runs`);
    expect(res.status).toBe(200);
  });

  it('a missing route is 404, not a hang', async () => {
    const base = await serve(studio());
    expect((await fetch(`${base}/yok-boyle`)).status).toBe(404);
  });

  it('mounted under a prefix the host stripped', async () => {
    // Express strips the mount prefix before calling us; Koa, Fastify and bare node:http do not.
    // Carrying the wrong half of that rule across hosts is a self-inflicted 404 — and it reads like
    // the package is broken rather than like the mount is wrong.
    const handler = studio();
    const base = await serve((req, res) => {
      req.url = req.url!.slice('/studio'.length) || '/';
      handler(req, res);
    });
    expect((await fetch(`${base}/studio/runs`)).status).toBe(200);
  });

  it('SSE answers with headers that survive a compressing middleware', async () => {
    // `Cache-Control: no-cache` (Hono's default) says nothing about re-encoding, so `compression()`
    // buffers the stream and delivers it in one piece at the end: measured on a real Express app,
    // 13 progressive chunks became 1, first byte moving from 750ms to the end of the run. Status 200
    // the whole time, no error anywhere, and no live screen. `no-transform` is what stops it.
    const base = await serve(studio());
    const ac = new AbortController();
    try {
      const res = await fetch(`${base}/events`, { signal: ac.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-transform');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
    } finally {
      ac.abort();
    }
  });

  it('a POST with a body still works when nothing ate it', async () => {
    const base = await serve(studio());
    const res = await fetch(`${base}/agents/depo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'selam' }),
    });
    // No playground wired in this fixture, so 501 — the point is that the request REACHED the
    // endpoint on its own merits rather than being turned away by the bridge.
    expect([400, 501]).toContain(res.status);
    expect((await res.json() as { code?: string }).code).not.toBe('body_consumed_upstream');
  });

  it('says so when a body parser upstream already drank the body', async () => {
    // What `express.json()` / `koa-bodyparser` / Fastify's built-in parser do: read the stream to the
    // end and hand the result to the framework. What arrives here is a POST with no readable body,
    // and the endpoint answers the only thing it can — "runId is required" — accusing the caller of
    // a mistake the caller did not make. Measured: the identical request returns 200 with a model
    // answer without the parser, and that 400 with it.
    const handler = studio();
    const base = await serve((req, res) => {
      let drained = '';
      req.on('data', (c) => { drained += String(c); });
      req.on('end', () => {
        (req as unknown as { body: unknown }).body = JSON.parse(drained || '{}');
        handler(req, res);
      });
    });
    const res = await fetch(`${base}/agents/depo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'selam' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { code?: string; error?: string };
    expect(body.code).toBe('body_consumed_upstream');
    expect(body.error).toMatch(/BEFORE the parser/);
  });

  it('does not mistake a bodyless POST for a consumed one', async () => {
    const base = await serve(studio());
    const res = await fetch(`${base}/agents/depo/run`, { method: 'POST' });
    expect((await res.json() as { code?: string }).code).not.toBe('body_consumed_upstream');
  });

  it('does not mistake a GET for a consumed one', async () => {
    const base = await serve(studio());
    expect((await fetch(`${base}/runs`)).status).toBe(200);
  });
});

// The one string here that no enumerable map guards: node.ts prints the literal because depending on
// @gnldev/server at runtime for one constant is not worth a package edge. This pin is the substitute
// for that edge — if the server renames the code (and its docs page moves with the map), this
// reddens instead of Studio quietly printing a code that no longer has a page.
import { EDGE_ERROR_CODES } from '../../server/src/edge-errors';

describe('the body_consumed_upstream literal', () => {
  it('matches the enumerable edge code it deliberately does not import at runtime', () => {
    expect(EDGE_ERROR_CODES.bodyConsumedUpstream).toBe('body_consumed_upstream');
  });
});
