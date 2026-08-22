// Evicting a per-organization registry must be invisible to everything except memory pressure.
//
// The claim being attacked: "an instance is a CACHE over the org-scoped journal, so a rebuilt instance
// reads the same keys and sees the same data." That is only true if NO per-organization state lives
// outside the journal. This file goes looking for such state, from the angles where losing it would be
// worse than the unbounded growth the cap was added to fix:
//
//   * a run that is IN FLIGHT when its organization is evicted — does it finish, and does it still
//     journal under its own prefix;
//   * cancellation, which is served from an in-process registry of AbortControllers and is the one
//     obvious candidate for state that dies with the instance;
//   * the journal VIEW: a rebuilt instance re-derives `withOrg(base, id)`, and double-scoping would
//     write `org:a:org:a:…`, which is corruption rather than loss;
//   * a `memoryFactory` that ignores its argument — the documented exception, which turns out to be
//     sharper than "loses its contents".
//
// Rebuilds are counted through `memoryFactory`, which `createGnl` calls exactly once per instance;
// `orgScopeOf` names the organization the rebuilt instance was scoped to.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal, orgScopeOf } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function mkModel(text = 'ok'): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

/** Never enqueues, never closes — captures the abortSignal so a cancel can be proven to reach it. */
function mkHangingStreamModel(captured: { signal?: AbortSignal }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async (options: any) => {
      captured.signal = options.abortSignal;
      return { stream: new ReadableStream({ start() { /* hangs */ } }) };
    },
  };
}

/** A conversation store built over whatever journal it is handed. */
function journalBackedMemory(j: any) {
  const key = (id: string) => `mem:${id}`;
  return {
    getMessages: async (id: string) => ((await j.get(key(id))) as unknown[]) ?? [],
    append: async (id: string, msgs: unknown[]) => {
      await j.put(key(id), [...(((await j.get(key(id))) as unknown[]) ?? []), ...msgs]);
    },
  };
}

/** Records one entry per instance built, naming the organization it was scoped to. */
function tracker() {
  const built: (string | undefined)[] = [];
  return {
    built,
    /** Rebuilds seen for `org` (the org-less default instance reports `undefined`). */
    countFor: (org: string) => built.filter((o) => o === org).length,
    factory: (j: any) => { built.push(orgScopeOf(j)); return journalBackedMemory(j); },
  };
}

function mkApi(t: ReturnType<typeof tracker>, maxInstances: number | undefined, model: any = mkModel()) {
  const journal = new InMemoryJournal();
  const api = createRestApi(
    { journal, memoryFactory: t.factory, agents: { a: { model } } } as never,
    { org: maxInstances === undefined ? {} : { maxInstances } } as never,
  );
  return { api, journal };
}

const runFor = (api: any, org: string, runId: string, body: object = {}) =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gnl-org': org },
    body: JSON.stringify({ runId, prompt: 'hi', ...body }),
  });

/** Touches `n` distinct organizations, which is how eviction is forced. */
async function churn(api: any, n: number, prefix = 'noise'): Promise<void> {
  for (let i = 0; i < n; i++) await runFor(api, `${prefix}-${i}`, `r-${prefix}-${i}`);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('an organization evicted from the registry cache', () => {
  it('is rebuilt on its next request, and the rebuild is what the cap is buying', async () => {
    const t = tracker();
    const { api } = mkApi(t, 2);

    await runFor(api, 'acme', 'r1');
    expect(t.countFor('acme'), 'the first request did not build an instance').toBe(1);

    await churn(api, 3); // cap 2, so acme falls off the end
    await runFor(api, 'acme', 'r2');

    expect(t.countFor('acme'), 'acme was not evicted, so this test proves nothing about eviction').toBe(2);
  });

  it('reads back everything the earlier instance wrote', async () => {
    const t = tracker();
    const { api } = mkApi(t, 2);

    await runFor(api, 'acme', 'run-before');
    await churn(api, 3);
    await runFor(api, 'acme', 'run-after');
    expect(t.countFor('acme'), 'no eviction happened').toBe(2);

    const runs = await (await call(api, '/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    const ids = runs.map((r: any) => r.runId);
    expect(ids, 'the run made before eviction is gone from the rebuilt instance').toContain('run-before');
    expect(ids).toContain('run-after');
  });

  // Corruption, not loss: `withOrg` refuses to scope an already-scoped journal, so a rebuild that
  // passed the SCOPED journal back in would either throw or write `org:acme:org:acme:…`.
  it('writes under the same journal prefix as before, not a nested one', async () => {
    const t = tracker();
    const { api, journal } = mkApi(t, 1);

    await runFor(api, 'acme', 'r1');
    await churn(api, 2);
    await runFor(api, 'acme', 'r2');

    const keys = await journal.listKeys('');
    expect(keys.some((k) => k.startsWith('org:acme:r2:')), 'the rebuilt instance did not write under its own org prefix').toBe(true);
    expect(keys.filter((k) => k.includes('org:acme:org:')), 'the rebuilt instance double-scoped its journal').toEqual([]);
  });

  it('does not disturb the org-less default instance', async () => {
    const t = tracker();
    const { api } = mkApi(t, 1);

    await churn(api, 5);
    const res = await call(api, '/agents/a/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'shared-1', prompt: 'hi' }),
    });

    expect(res.status, 'heavy eviction broke the shared scope').toBe(200);
    expect((await res.json()).text).toBe('ok');
    expect(t.countFor(undefined as never), 'the default instance was rebuilt — it is not in the cache and must never be evicted').toBe(1);
  });
});

describe('state that does NOT live in the journal', () => {
  // The candidate most likely to break: `POST /runs/:id/cancel` is served from an in-process map of
  // AbortControllers. If that map were per-instance, evicting an organization would silently make its
  // live runs uncancellable — a worse outcome than the leak the cap fixes.
  it('a run in flight can still be cancelled after its organization is evicted', async () => {
    const captured: { signal?: AbortSignal } = {};
    const t = tracker();
    const { api } = mkApi(t, 1, mkHangingStreamModel(captured));

    // Start a stream for acme and leave it hanging.
    const streaming = call(api, '/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
      body: JSON.stringify({ runId: 'live-1', prompt: 'hi' }),
    });
    await vi.waitFor(() => expect(captured.signal, 'the stream never reached the model').toBeTruthy());
    expect(captured.signal!.aborted).toBe(false);

    // Evict acme by serving another organization (cap 1).
    await call(api, '/runs', { headers: { 'x-gnl-org': 'other' } });

    const cancelled = await call(api, '/runs/live-1/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
    });

    expect(cancelled.status, 'cancel could not find the in-flight run of an evicted organization').toBe(200);
    await vi.waitFor(() => expect(captured.signal!.aborted,
      'the abort never reached the model — the controller died with the evicted instance').toBe(true));
    await streaming.catch(() => {});
  });

  // The other half: a cancel from a DIFFERENT organization must still not reach it. Eviction must not
  // widen the blast radius by collapsing the org-scoped cancel key.
  it('and a cancel from another organization still cannot reach it', async () => {
    const captured: { signal?: AbortSignal } = {};
    const t = tracker();
    const { api } = mkApi(t, 1, mkHangingStreamModel(captured));

    const streaming = call(api, '/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
      body: JSON.stringify({ runId: 'live-2', prompt: 'hi' }),
    });
    await vi.waitFor(() => expect(captured.signal).toBeTruthy());
    await call(api, '/runs', { headers: { 'x-gnl-org': 'other' } }); // evict acme

    await call(api, '/runs/live-2/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-org': 'globex' },
    });

    expect(captured.signal!.aborted, 'another organization cancelled an evicted org\'s run').toBe(false);
    await call(api, '/runs/live-2/cancel', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' } });
    await streaming.catch(() => {});
  });

  // A run holds its instance by reference, so eviction cannot pull it out from under an active
  // generation. Asserted because "the object is still referenced" is a JS fact, not a design decision,
  // and it is what makes the eviction safe rather than merely unnoticed.
  it('a run that started before eviction still completes and journals correctly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Gated ONLY for the run under test: the churn that forces the eviction goes through the same
    // agent, and gating every generation would deadlock the test rather than exercise it.
    const slow: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async (o: any) => {
        if (JSON.stringify(o.prompt).includes('HOLD-ME')) await gate;
        return { content: [{ type: 'text', text: 'late' }], finishReason: 'stop', usage, warnings: [] };
      },
      doStream: async () => { throw new Error('no stream'); },
    };
    const t = tracker();
    const { api, journal } = mkApi(t, 1, slow);

    const pending = runFor(api, 'acme', 'slow-1', { prompt: 'HOLD-ME' });
    await churn(api, 2, 'evictor'); // acme is evicted while its run is still awaiting the model
    release();

    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).text, 'the in-flight run did not survive its instance being evicted').toBe('late');
    expect((await journal.listKeys('')).some((k) => k.startsWith('org:acme:slow-1:')),
      'the in-flight run journaled outside its organization after eviction').toBe(true);
  });
});

describe('the LRU discipline itself', () => {
  it('keeps the organizations that are actually being used', async () => {
    const t = tracker();
    const { api } = mkApi(t, 2);

    await runFor(api, 'hot', 'r1');
    await runFor(api, 'cold', 'r2');
    await runFor(api, 'hot', 'r3');   // re-insert moves `hot` to the recent end
    await runFor(api, 'new', 'r4');   // evicts the least recently used, which must be `cold`

    expect(t.countFor('hot'), 'a repeatedly used organization was evicted anyway').toBe(1);
    await runFor(api, 'cold', 'r5');
    expect(t.countFor('cold'), 'the least recently used organization was not the one evicted').toBe(2);
  });

  it('holds exactly the cap, evicting only past it', async () => {
    const t = tracker();
    const { api } = mkApi(t, 3);

    for (const o of ['a', 'b', 'c']) await runFor(api, o, `r-${o}`);
    for (const o of ['a', 'b', 'c']) await runFor(api, o, `r2-${o}`);

    expect(t.built.filter((o) => o !== undefined), 'an organization was evicted while the cache was still under its cap')
      .toHaveLength(3);
  });

  // These three used to assert that a cap below 1 was CLAMPED and the request it was serving still
  // worked. It is now rejected at construction instead, which is a stronger guarantee than the one
  // they pinned — so they are inverted rather than relaxed. The measurement that prompted the change:
  // a negative cap did not merely mis-size the cache, it hung the request forever (`orgs.size > -5` is
  // permanently true and `orgs.delete(undefined)` never shrinks the map), and a silent clamp of `0`
  // would have rebuilt every organization's registry on every request without saying so.
  it.each([0, -5, Number.NaN, 1.5, Number.POSITIVE_INFINITY])('a cap of %s is refused at construction', (bad) => {
    expect(() => mkApi(tracker(), bad as number), 'an unusable cap was accepted').toThrow(/maxInstances.*positive integer/s);
  });

  // The concern the clamp tests were really about, kept alive at the smallest LEGAL cap: eviction must
  // never reach the instance the current request is about to use.
  it('a cap of 1 still serves the request that just built its instance', async () => {
    const t = tracker();
    const { api } = mkApi(t, 1);

    const res = await runFor(api, 'acme', 'r1');
    expect(res.status, 'the instance was evicted before the request that created it could use it').toBe(200);
    expect((await res.json()).text).toBe('ok');
  });

  it('bounds the cache no matter how many distinct organizations are seen', async () => {
    const t = tracker();
    const { api } = mkApi(t, 5);

    await churn(api, 40);
    const before = t.built.length;

    // The 5 most recent must be warm; anything older must have been dropped.
    for (let i = 35; i < 40; i++) await runFor(api, `noise-${i}`, `again-${i}`);
    expect(t.built.length, 'a recently used organization was rebuilt — the cache is not holding its cap').toBe(before);

    await runFor(api, 'noise-0', 'again-0');
    expect(t.built.length, 'the oldest organization was still cached after 40 distinct organizations — the cache is unbounded')
      .toBe(before + 1);
  });

  it('warns once, not per eviction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = tracker();
    const { api } = mkApi(t, 1);

    await churn(api, 6);

    const evictionWarnings = warn.mock.calls.flat().filter((m) => String(m).includes('organizations are active'));
    expect(evictionWarnings, 'the operator gets a warning per request once past the cap').toHaveLength(1);
    expect(String(evictionWarnings[0]), 'the warning does not name the option that raises the ceiling').toMatch(/maxInstances/);
  });

  it('does not warn when nothing is evicted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = tracker();
    const { api } = mkApi(t, 10);

    await churn(api, 4);

    expect(warn.mock.calls.flat().filter((m) => String(m).includes('organizations are active')),
      'a deployment under its cap was warned about eviction').toEqual([]);
  });

  it('defaults to a cap that does not evict a handful of organizations', async () => {
    const t = tracker();
    const { api } = mkApi(t, undefined); // no maxInstances given

    await churn(api, 8);
    for (let i = 0; i < 8; i++) await runFor(api, `noise-${i}`, `again-${i}`);

    expect(t.built.filter((o) => o !== undefined), 'the default cap is small enough to evict 8 organizations')
      .toHaveLength(8);
  });
});

describe('conversation memory across an eviction', () => {
  /** Captures the prompt each generation was given, so injected history can be observed. */
  function capturingModel(seen: string[]): any {
    return {
      specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async (o: any) => {
        seen.push(JSON.stringify(o.prompt));
        return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
      },
      doStream: async () => { throw new Error('no stream'); },
    };
  }

  // The reason eviction is claimed to be state-preserving: memory comes from `memoryFactory(scoped)`,
  // so a journal-backed store rebuilds onto the same keys and the conversation continues.
  it('is preserved when the factory uses the journal it is handed', async () => {
    const seen: string[] = [];
    const t = tracker();
    const { api } = mkApi(t, 1, capturingModel(seen));

    await runFor(api, 'acme', 'm1', { threadId: 'thread-x', prompt: 'REMEMBER-THIS' });
    await churn(api, 2);
    await runFor(api, 'acme', 'm2', { threadId: 'thread-x', prompt: 'and now?' });

    expect(t.countFor('acme'), 'acme was not evicted, so nothing was rebuilt').toBe(2);
    expect(seen.at(-1), 'the rebuilt store lost the thread — eviction is not state-preserving after all')
      .toContain('REMEMBER-THIS');
  });

  // The documented exception, and it is sharper than "loses its contents on eviction": the evicted
  // instance stays alive for as long as an in-flight run references it, so for a window there are TWO
  // live stores for one organization. That is a SPLIT, not a loss — one half of a conversation lands in
  // a store nothing will ever read again.
  it('is split, not merely lost, when the factory ignores its argument', async () => {
    const stores: Array<Map<string, unknown[]>> = [];
    const processLocal = () => {
      const threads = new Map<string, unknown[]>();
      stores.push(threads);
      return {
        getMessages: async (id: string) => threads.get(id) ?? [],
        append: async (id: string, msgs: unknown[]) => { threads.set(id, [...(threads.get(id) ?? []), ...msgs]); },
      };
    };
    const seen: string[] = [];
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, memoryFactory: processLocal, agents: { a: { model: capturingModel(seen) } } } as never,
      { org: { maxInstances: 1 } } as never,
    );

    await runFor(api, 'acme', 'm1', { threadId: 'thread-x', prompt: 'FIRST-TURN' });
    await churn(api, 2);
    await runFor(api, 'acme', 'm2', { threadId: 'thread-x', prompt: 'second turn' });

    expect(seen.at(-1), 'a process-local store somehow survived eviction — update this documented exception')
      .not.toContain('FIRST-TURN');
    const acmeStores = stores.filter((m) => JSON.stringify([...m.values()]).includes('FIRST-TURN'));
    expect(acmeStores, 'the first turn should still be sitting in the orphaned store, unreachable').toHaveLength(1);
    expect(stores.length, 'two separate stores were built for one organization').toBeGreaterThan(acmeStores.length);
  });
});
