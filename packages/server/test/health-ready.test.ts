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
import { describe, it, expect, vi } from 'vitest';
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

/**
 * A working journal that COUNTS the reads /ready makes. `delayMs` keeps a read open long enough that a
 * Burst is genuinely concurrent — without it the first read settles before the twentieth request arrives
 * And the cache, not the coalescing, would be what the burst test measures.
 */
function countingJournal(delayMs = 0) {
  const inner = new InMemoryStorage().runs as any;
  const counter = { gets: 0 };
  const journal = new Proxy(inner, {
    get(t, p, r) {
      if (p === 'get') {
        return async (k: string) => {
          counter.gets++;
          if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
          return inner.get(k);
        };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { journal, counter };
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

  it('collapses a burst of probes into one read, and still answers every one of them', async () => {
    // /ready is unauthenticated, so anyone who can reach the port sets the rate. Against a real database
    // Each request would be a real query — and when storage hangs, a parked connection for 2s each.
    // 200ms, not 20ms: the read's duration IS the coalescing window, and the assertion below allows
    // only one slip past it. At 20ms a 20ms hiccup between the first probe reaching the journal and
    // the last one doing so opens a third window and turns this red with the coalescing working
    // perfectly. 200ms is ten times the plausible spread and still ten times under readyBudgetMs
    // (2000), so the probe still answers `ready` and nothing about the assertion changes.
    //
    // Measured, so nobody reads this as a fix for a failure that was seen: the 20ms form did not
    // flake — twelve runs under 64 busy processes at load ~55 were green. This widens a margin; it
    // does not close a reproduced gap.
    const { journal, counter } = countingJournal(200);
    const api = createRestApi({ journal, agents: {} } as any);

    const responses = await Promise.all(Array.from({ length: 20 }, () => hit(api, '/ready')));

    expect(counter.gets).toBeLessThanOrEqual(2);
    // Cheaper must not mean vaguer: all 20 callers get the full, correct answer.
    expect(responses).toHaveLength(20);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect((await res.json() as any).status).toBe('ready');
    }
  });

  it('reuses a settled answer for a second, then probes again', async () => {
    // The window is read off Date.now, so fake timers can move it without the test waiting in real life.
    vi.useFakeTimers();
    try {
      const { journal, counter } = countingJournal();
      const api = createRestApi({ journal, agents: {} } as any);

      expect((await hit(api, '/ready')).status).toBe(200);
      expect((await hit(api, '/ready')).status).toBe(200);
      expect(counter.gets, 'the second request inside the window should be served from cache').toBe(1);

      vi.advanceTimersByTime(1_100);
      // Past the window the answer is stale — storage may have died since — so it is measured again.
      expect((await hit(api, '/ready')).status).toBe(200);
      expect(counter.gets).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once for an outage, not once per probe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = createRestApi({ journal: throwingJournal(), agents: {} } as any);
      for (let i = 0; i < 25; i++) expect((await hit(api, '/ready')).status).toBe(503);

      const readiness = warn.mock.calls.filter((c) => String(c[0]).includes('readiness probe failed'));
      // Otherwise an unauthenticated caller writes the operator's log for them, and the first useful line
      // Scrolls away under its own repetitions.
      expect(readiness).toHaveLength(1);
      expect(String(readiness[0][0])).toContain('repeats suppressed for 30s');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps readiness state per API instance — two apps must not answer for each other', async () => {
    // Module-level state would make the second app's answer depend on the first app's journal.
    const a = countingJournal();
    const b = countingJournal();
    const apiA = createRestApi({ journal: a.journal, agents: {} } as any);
    const apiB = createRestApi({ journal: b.journal, agents: {} } as any);

    expect((await hit(apiA, '/ready')).status).toBe(200);
    expect((await hit(apiA, '/ready')).status).toBe(200);
    expect(a.counter.gets).toBe(1);
    expect(b.counter.gets, 'A being ready says nothing about B storage').toBe(0);

    expect((await hit(apiB, '/ready')).status).toBe(200);
    expect(b.counter.gets).toBe(1);
    expect(a.counter.gets).toBe(1);
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
