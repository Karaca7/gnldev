// A read either returns the body it promises or throws GnlHttpError — never the error body cast.
import { describe, it, expect } from 'vitest';
import { GnlClient, GnlHttpError } from '../src/index.js';

const answering = (status: number, body: unknown) => (async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('GnlClient reads', () => {
  for (const [name, call] of [
    ['listAgents', (c: GnlClient) => c.listAgents()],
    ['listRuns', (c: GnlClient) => c.listRuns()],
    ['getRun', (c: GnlClient) => c.getRun('r1')],
  ] as const) {
    it(`${name} throws on 401 and 404 instead of returning the error body`, async () => {
      for (const status of [401, 404]) {
        const c = new GnlClient({ baseUrl: 'http://x', fetch: answering(status, { error: 'nope' }) });
        await expect(call(c)).rejects.toBeInstanceOf(GnlHttpError);
      }
      const ok = new GnlClient({ baseUrl: 'http://x', fetch: answering(200, []) });
      expect(await call(ok)).toEqual([]);
    });
  }
});
