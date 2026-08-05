// The REST API bound to a Node server, and the reason this subpath exists at all.
//
// The bridge used to live only in @gnldev/studio/node, so a service that wanted agents and no
// dashboard installed the Studio package — and @gnldev/studio-ui with it, a React app, into a
// process that will never render a page. This file is the other half of that fix: proof that
// @gnldev/server/node answers on its own, and that it answers the SAME way as its twin.
//
// The twin is a copy, not an import, and that was measured too: a cross-package runtime import
// resolves through the sibling's BUILT output, so a stale dist silently turns the call into
// `undefined`. Copies drift, which is what the shared-behaviour assertion below is for — if the two
// packages ever answer the same misconfiguration differently, this goes red.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { toNodeHandler } from '../src/node.js';
import { toNodeHandler as studioToNodeHandler } from '../../studio/src/node.js';
import { createStudioApi } from '../../studio/src/server.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function serve(onRequest: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(onRequest);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function api() {
  return toNodeHandler(createRestApi({ journal: new InMemoryJournal(), agents: {} }));
}

/** Drains the request first — precisely what express.json() and koa-bodyparser do to us. */
function behindABodyParser(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let drained = '';
    req.on('data', (c) => { drained += String(c); });
    req.on('end', () => {
      (req as unknown as { body: unknown }).body = JSON.parse(drained || '{}');
      handler(req, res);
    });
  };
}

describe('@gnldev/server/node — binding to a Node server', () => {
  it('serves a route over a real socket, with no Studio package in sight', async () => {
    const base = await serve(api());
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a missing route is 404, not a hang', async () => {
    const base = await serve(api());
    expect((await fetch(`${base}/yok-boyle`)).status).toBe(404);
  });

  it('mounted under a prefix the host stripped', async () => {
    const handler = api();
    const base = await serve((req, res) => {
      req.url = req.url!.slice('/api'.length) || '/';
      handler(req, res);
    });
    expect((await fetch(`${base}/api/agents`)).status).toBe(200);
  });

  it('says so when a body parser upstream already drank the body', async () => {
    const base = await serve(behindABodyParser(api()));
    const res = await fetch(`${base}/agents/depo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'selam' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json() as { code?: string }).code).toBe('body_consumed_upstream');
  });

  it('does not mistake a bodyless POST for a consumed one', async () => {
    const base = await serve(api());
    const res = await fetch(`${base}/agents/depo/run`, { method: 'POST' });
    expect((await res.json() as { code?: string }).code).not.toBe('body_consumed_upstream');
  });

  it('answers the same as its twin in @gnldev/studio', async () => {
    // The two bridges are copies. This is the assertion that notices when one of them is edited and
    // the other is not — a caller behind a body parser must not get one story from the REST API and
    // a different story from Studio.
    const studioBase = await serve(behindABodyParser(studioToNodeHandler(createStudioApi({ reader: new InMemoryJournal() }))));
    const apiBase = await serve(behindABodyParser(api()));
    const body = JSON.stringify({ runId: 'r1', prompt: 'selam' });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body } as const;

    const [fromStudio, fromApi] = await Promise.all([
      fetch(`${studioBase}/agents/depo/run`, init),
      fetch(`${apiBase}/agents/depo/run`, init),
    ]);
    expect(fromApi.status).toBe(fromStudio.status);
    expect(await fromApi.json()).toEqual(await fromStudio.json());
  });
});
