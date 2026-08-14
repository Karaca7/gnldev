// There was no health endpoint at all, which every deployment target asks for first.
//
// The two properties that matter here are easy to get wrong in opposite directions:
//
//   - Behind auth, a health check is useless: orchestrators probe before they have a credential, and
//     usually will never have one. So these must be reachable with no token even when the rest of the
//     API is locked down.
//   - Being world-readable, they must say almost nothing. A Postgres failure message carries the host,
//     database and user; returning it here would publish the connection topology to anyone who can
//     reach the port.
//
// And liveness must not depend on storage. If a dead database made /health fail, an orchestrator would
// kill and restart a perfectly good process — which reconnects nobody's database and drops whatever
// in-flight work the process still had.
import { describe, it, expect } from 'vitest';
import { createRestApi } from '../src/index.js';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';

const hit = (api: any, path: string, headers?: Record<string, string>) =>
  api.fetch(new Request(`http://x${path}`, headers ? { headers } : undefined));

/** A journal whose reads never resolve — the shape of an unreachable database, which hangs. */
function hangingJournal() {
  const inner = new InMemoryStorage().runs as any;
  return new Proxy(inner, {
    get(t, p, r) {
      if (p === 'get') return () => new Promise(() => { /* never settles */ });
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function throwingJournal() {
  const inner = new InMemoryStorage().runs as any;
  return new Proxy(inner, {
    get(t, p, r) {
      // The message deliberately looks like a real pg failure, credentials and all.
      if (p === 'get') return async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:5432 user=gnl_prod password=hunter2'); };
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

describe('liveness and readiness', () => {
  it('answers both without a credential, on an API that otherwise requires one', async () => {
    const api = createRestApi(
      { journal: new InMemoryStorage().runs, agents: {} } as any,
      { auth: roleAuth({ admin: { token: 'secret-admin-token' } }) },
    );

    // The guarded surface really is closed…
    expect((await hit(api, '/agents')).status).toBe(401);
    // …and the probes are still answerable.
    expect((await hit(api, '/health')).status).toBe(200);
    expect((await hit(api, '/ready')).status).toBe(200);
  });

  it('reports ready when storage answers', async () => {
    const api = createRestApi({ journal: new InMemoryStorage().runs, agents: {} } as any);
    const body = await (await hit(api, '/ready')).json() as any;
    expect(body.status).toBe('ready');
  });

  it('reports 503 when storage is unreachable — and leaks nothing about it', async () => {
    const api = createRestApi({ journal: throwingJournal(), agents: {} } as any);
    const res = await hit(api, '/ready');
    const text = await res.text();

    expect(res.status).toBe(503);
    // The endpoint is world-readable; the connection string must not travel through it.
    expect(text).not.toContain('5432');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).toContain('unreachable');
  });

  it('answers 503 rather than hanging when storage hangs', async () => {
    const api = createRestApi({ journal: hangingJournal(), agents: {} } as any);
    const started = Date.now();
    const res = await hit(api, '/ready');
    // An unreachable database usually hangs rather than refusing. A probe that never answers is read
    // As a timeout by some orchestrators and as success by others; answer either way.
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('stays alive when storage is dead — liveness must not depend on it', async () => {
    const api = createRestApi({ journal: throwingJournal(), agents: {} } as any);
    const res = await hit(api, '/health');
    // Restarting this process would not reconnect the database; it would only discard its in-flight work.
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe('ok');
  });

  it('says nothing about what the deployment contains', async () => {
    const api = createRestApi({
      journal: new InMemoryStorage().runs,
      agents: { 'billing-reconciler': { model: {} as any } },
    } as any);
    for (const path of ['/health', '/ready']) {
      const text = await (await hit(api, path)).text();
      expect(text, `${path} named an agent`).not.toContain('billing-reconciler');
    }
  });
});
