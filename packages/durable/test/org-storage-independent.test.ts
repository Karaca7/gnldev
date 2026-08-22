// `withOrgStorage` — both sides of the lens, on every port.
//
// A wrapper that refuses everyone passes an isolation test perfectly, so every port is asked two
// questions, not one:
//
//   CEMENTED?  can acme still reach what acme wrote — by the id acme was given back?
//   OWNER IN?  does acme's answer differ from globex's, so the control is not vacuous?
//
// The half that fails silently is strip-on-read. Prefixing on the way in and forgetting to strip on
// the way out produces no leak and no error: the owner is simply handed an identifier that does not
// work, and finds out later — or never.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, orgStorageScopeOf } from '../src/index.js';

const mkMsg = (threadId: string, seq: number, text: string) =>
  ({ threadId, seq, role: 'user', text, ts: seq, message: { role: 'user', content: text } });

/** A fresh base with two organizations over it. */
function twoOrgs() {
  const base = new InMemoryStorage();
  return { base, acme: withOrgStorage(base, 'acme'), globex: withOrgStorage(base, 'globex') };
}

describe('the owner can get back in — every port', () => {
  it('runs: acme reads its own run and globex cannot see it', async () => {
    const { acme, globex } = twoOrgs();
    await acme.runs.put('r-1', { secret: 'ACME' });

    expect(await acme.runs.get('r-1'), 'the owner cannot read what it just wrote').toEqual({ secret: 'ACME' });
    expect(await globex.runs.get('r-1'), 'another organization read it').toBeUndefined();
  });

  it('runs: listKeys hands back keys the owner can actually use', async () => {
    const { acme } = twoOrgs();
    await acme.runs.put('r-1:model:0', { a: 1 });

    const keys = await acme.runs.listKeys('r-1');
    expect(keys, 'the owner was handed prefixed keys it cannot pass back in').toEqual(['r-1:model:0']);
    expect(await acme.runs.get(keys[0]!), 'the returned key does not round-trip').toEqual({ a: 1 });
  });

  it('meta / cache / work: the owner round-trips and the stranger sees nothing', async () => {
    const { acme, globex } = twoOrgs();
    await acme.meta.set('k', 'ACME');
    await acme.cache!.set('ck', { v: 'ACME' }, { ttlMs: 60_000 });
    await acme.work!.append('ns', { v: 'ACME' });

    expect(await acme.meta.get('k')).toBe('ACME');
    expect(await globex.meta.get('k'), 'meta leaked').toBeUndefined();
    expect(await acme.cache!.get('ck')).toEqual({ v: 'ACME' });
    expect(await globex.cache!.get('ck'), 'cache leaked').toBeUndefined();
    expect((await acme.work!.list('ns')).items, 'the owner lost its own work log').toHaveLength(1);
    expect((await globex.work!.list('ns')).items, 'work leaked').toHaveLength(0);
  });

  it('memory: acme reads its own thread by the id it supplied', async () => {
    const { acme, globex } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });

    expect((await acme.memory!.getThread('t-1'))?.id, 'the owner cannot read its own thread').toBe('t-1');
    expect(await globex.memory!.getThread('t-1'), 'another organization read the thread').toBeUndefined();
  });

  // The id `getThread` returns must be the id the caller can pass back in. This is the CONTROL for the
  // failing case below: it proves the wrapper knows how to strip, so the gap there is an omission
  // rather than a design.
  it('memory: the thread id that comes out is the id that goes back in', async () => {
    const { acme } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });

    const rec = await acme.memory!.getThread('t-1');
    expect(await acme.memory!.getThread(rec!.id), 'the id it returned does not round-trip').toBeTruthy();
  });

  it('vectors: acme searches its own documents and never another organization\'s', async () => {
    const { acme, globex } = twoOrgs();
    await acme.vectors!.upsert([{ id: 'a1', text: 'ACME-DOC', embedding: [1, 0, 0] }]);
    await globex.vectors!.upsert([{ id: 'g1', text: 'GLOBEX-DOC', embedding: [1, 0, 0] }]);

    const mine = await acme.vectors!.query([1, 0, 0], 10);
    expect(mine.map((m) => m.text), 'the owner lost its own document, or saw a stranger\'s').toEqual(['ACME-DOC']);
    expect((await globex.vectors!.query([1, 0, 0], 10)).map((m) => m.text)).toEqual(['GLOBEX-DOC']);
  });
});

describe('the guards fail closed', () => {
  it.each(['', 'a:b', 'org:x'])('%s is refused rather than silently shared', (bad) => {
    expect(() => withOrgStorage(new InMemoryStorage(), bad),
      `'${bad}' produced a scope instead of throwing — every organization would share it`).toThrow();
  });

  it('a scoped storage cannot be scoped again', () => {
    const once = withOrgStorage(new InMemoryStorage(), 'acme');
    expect(() => withOrgStorage(once, 'globex'), 'double-scoping produced org:acme:org:globex:').toThrow();
  });

  it('reports its own scope', () => {
    expect(orgStorageScopeOf(withOrgStorage(new InMemoryStorage(), 'acme'))).toBe('acme');
    expect(orgStorageScopeOf(new InMemoryStorage()), 'an unscoped storage claimed a scope').toBeUndefined();
  });
});

/**
 * FINDING — `getMessages` hands the owner a `threadId` that does not work.
 *
 * `MessageRecord` carries a `threadId`, and the wrapper prefixes it going in but does not strip it
 * coming out. So a caller that passed `'t-1'` is handed `'org:acme:t-1'`, and feeding that back — the
 * obvious thing to do with an id you were just given — resolves to `org:acme:org:acme:t-1`, which is
 * nobody's thread. Measured:
 *
 *   acme.memory.getMessages('t-1')          -> items[0].threadId === 'org:acme:t-1'
 *   acme.memory.getMessages(that threadId)  -> 0 items, no error
 *
 * No leak, no exception, no data. It is the cemented failure in the exact form the wrapper's own
 * comment warns about: "prefixes on the way in also strips on the way out".
 *
 * `getThread` DOES strip its `id` (asserted above), so this is an omission rather than a decision —
 * and `recall` returns the same `MessageRecord` shape from the same store, so it is the same gap on a
 * second method. The fix is the `stripThread` helper that already exists, applied to the rows.
 */
describe('FINDING: message records carry an unusable threadId', () => {
  it('getMessages returns the id the caller supplied, not the internal one', async () => {
    const { acme } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });
    await acme.memory!.appendMessages('t-1', [mkMsg('t-1', 1, 'hello')]);

    const page = await acme.memory!.getMessages('t-1');
    expect(page.items, 'the owner cannot read its own messages at all').toHaveLength(1);
    expect(page.items[0]!.threadId,
      'the record names the internal, prefixed thread id; the caller never used that id and cannot use it')
      .toBe('t-1');
  });

  it('and that id round-trips, so the owner can ask again with what it was given', async () => {
    const { acme } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });
    await acme.memory!.appendMessages('t-1', [mkMsg('t-1', 1, 'hello')]);

    const first = await acme.memory!.getMessages('t-1');
    const again = await acme.memory!.getMessages(first.items[0]!.threadId);
    expect(again.items,
      'feeding back the returned threadId found nothing — silently, which is how this stays hidden')
      .toHaveLength(1);
  });
});

/**
 * A message row carries its own `threadId` in the BODY, so `appendMessages` has two ids that can
 * disagree: the one the caller named and the one the row claims.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE. They pin that the caller's argument wins — but the guarantee
 * comes from the ADAPTERS, not from the wrapper. `InMemoryStorage.appendMessages` stores
 * `{ ...r, threadId }` and `SqliteStorage.appendMessages` binds the argument to the `thread_id`
 * column without reading the row's field at all. So the row's body id is discarded one layer down,
 * and it was before the wrapper existed.
 *
 * That makes the wrapper's write-side `inMsg` unobservable: removing it, and rewriting it to derive
 * from `r.threadId` instead of the argument, both leave every test in this file green — because
 * nothing downstream can see the difference. The read-side strip is the half that was load-bearing
 * (removing it fails 2).
 *
 * Kept anyway, because what they pin is the adapter invariant the wrapper RELIES on: the day an
 * adapter starts trusting the row's own `threadId`, these fail and `inMsg` stops being redundant.
 */
describe('a message row whose threadId disagrees with the caller', () => {
  it('is stored under the thread the caller named, not the one the row claims', async () => {
    const { base, acme } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });
    // The row claims a DIFFERENT thread — the shape a buggy or hostile caller produces.
    await acme.memory!.appendMessages('t-1', [mkMsg('someone-elses-thread', 1, 'hello')]);

    const persisted = await base.memory!.getMessages('org:acme:t-1');
    expect(persisted.items, 'the message did not land in the thread the caller named').toHaveLength(1);
    expect(persisted.items[0]!.threadId,
      'the persisted row kept the id it claimed rather than the one it was filed under — at rest, the '
      + 'row says it belongs to a thread it is not in')
      .toBe('org:acme:t-1');
  });

  it('and a row claiming another organization\'s thread is filed under the caller\'s own', async () => {
    const { base, acme, globex } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });
    await globex.memory!.upsertThread({ id: 't-1', createdAt: 1, updatedAt: 1 });
    await acme.memory!.appendMessages('t-1', [mkMsg('org:globex:t-1', 1, 'ACME-SECRET')]);

    expect((await globex.memory!.getMessages('t-1')).items,
      "a row claiming another organization's thread reached that organization").toHaveLength(0);
    const persisted = await base.memory!.getMessages('org:acme:t-1');
    expect(persisted.items[0]!.threadId, 'the persisted row still names another organization\'s thread')
      .toBe('org:acme:t-1');
  });
});

/**
 * FINDING — resource-scoped `recall` crosses the organization boundary.
 *
 * `MemoryStore.recall` takes `opts.scope: 'resource'`, and on that path the adapter IGNORES `threadId`
 * entirely: it scans every thread in the store whose `resourceId` matches (in-memory-storage.ts, the
 * `opts.scope === 'resource'` branch). The wrapper prefixes the `threadId` argument — which that path
 * never reads — and forwards `opts` UNCHANGED, so `resourceId` is not part of the organization key
 * space at all. `upsertThread` prefixes `id` and `parentThreadId`; it does not prefix `resourceId`.
 *
 * Two organizations whose threads share a resource id therefore recall each other's messages. Measured:
 *
 *   acme.recall('t-1', q, { scope: 'resource', resourceId: 'u-shared' })
 *     -> ['ACME-SECRET', 'GLOBEX-SECRET']
 *
 * And the second half is worse than the first. The wrapper maps every returned row through
 * `outMsg(r, threadId)`, which REWRITES the row's `threadId` to the caller's argument — so the leaked
 * row comes back stamped `t-1`, indistinguishable from one of acme's own. The fix for the cemented-id
 * problem is what disguises the leak: nothing in the result identifies it as foreign.
 *
 * `listThreads({ resourceId })` does NOT have this problem, because `outThread` drops rows whose `id`
 * lacks the prefix — it filters, where `recall` only maps. That difference is the whole defect: the
 * scoped `recall` needs to strip from each row's OWN `threadId` and drop the ones that do not match,
 * rather than stamping the caller's id onto whatever came back.
 */
describe('FINDING: resource-scoped recall crosses organizations', () => {
  const embedded = (threadId: string, text: string) =>
    ({ threadId, seq: 1, role: 'user', text, ts: 1, message: {}, embedding: [1, 0, 0] });

  async function twoTenantsSharingAResource() {
    const { base, acme, globex } = twoOrgs();
    await acme.memory!.upsertThread({ id: 't-1', resourceId: 'u-shared', createdAt: 1, updatedAt: 1 });
    await acme.memory!.appendMessages('t-1', [embedded('t-1', 'ACME-SECRET')]);
    await globex.memory!.upsertThread({ id: 't-2', resourceId: 'u-shared', createdAt: 1, updatedAt: 1 });
    await globex.memory!.appendMessages('t-2', [embedded('t-2', 'GLOBEX-SECRET')]);
    return { base, acme, globex };
  }

  // The control: thread-scoped recall is correct, so the fixture and the embeddings are sound and the
  // failure below is about the resource path specifically.
  it('thread-scoped recall stays inside the organization', async () => {
    const { acme } = await twoTenantsSharingAResource();
    const hits = await acme.memory!.recall('t-1', [1, 0, 0], { topK: 10 });

    expect(hits.map((m) => m.text), 'the fixture cannot even recall the owner\'s own message').toEqual(['ACME-SECRET']);
    expect(hits[0]!.threadId, 'the thread-scope path returns an unusable id').toBe('t-1');
  });

  it('resource-scoped recall must not return another organization\'s messages', async () => {
    const { acme } = await twoTenantsSharingAResource();
    const hits = await acme.memory!.recall('t-1', [1, 0, 0], { scope: 'resource', resourceId: 'u-shared', topK: 10 });

    expect(hits.map((m) => m.text),
      "a resource id is not organization-scoped, so two tenants sharing one recall each other's messages")
      .toEqual(['ACME-SECRET']);
  });

  it('and must not stamp a foreign row with the caller\'s own thread id', async () => {
    const { acme } = await twoTenantsSharingAResource();
    const hits = await acme.memory!.recall('t-1', [1, 0, 0], { scope: 'resource', resourceId: 'u-shared', topK: 10 });
    const foreign = hits.filter((m) => String(m.text).includes('GLOBEX'));

    expect(foreign.map((m) => m.threadId),
      'a leaked row came back labelled with the caller\'s own thread — the id fix disguises it as the '
      + "caller's own message, so nothing in the result marks it foreign")
      .toEqual([]);
  });
});

/**
 * REGRESSION GUARDS — two failures that a leak test cannot see, both introduced while fixing something
 * else, and both caught by a runtime probe rather than by any test that existed.
 *
 * (a) Rebuilding `scopedRuns` as an object literal kept only the methods `RunJournal` DECLARES, so
 *     every optional capability vanished. `incrBy` is the atomic counter organization usage is built
 *     on: without it the runtime falls back to get-then-put, loses increments under concurrency,
 *     under-counts usage, and a budget silently over-runs. An isolation feature would have broken
 *     budget enforcement, with no leak and no error.
 *
 * (b) Fixing (a) by delegating to `withOrg` broke the OWNER's access instead: `withOrg`'s reader half
 *     answers the older ARRAY contract, while `RunJournal.listRuns` must return a `Page`. The scoped
 *     value stopped being a valid `RunJournal`, `toJournal()` around it produced `undefined`, and an
 *     organization's `GET /runs` showed it none of its own runs. Cemented, by a fix for a leak.
 *
 * Both are shape questions, so they are asserted as shape — cheaply, and on every capability at once.
 */
describe('scoping a storage preserves what the store can do', () => {
  // Every optional capability the base advertises must survive. Driven off the BASE's own surface, so
  // a capability added to `InMemoryStorage` later is covered without touching this list.
  const OPTIONAL = ['incrBy', 'getCounters', 'applyBatch', 'getMany', 'putIfMatch', 'deletePrefix',
    'now', 'listStaleRuns', 'listKeys', 'readRun', 'readRunStats'] as const;

  it('keeps every optional run-journal capability the base has', () => {
    const base = new InMemoryStorage();
    const scoped = withOrgStorage(base, 'acme');
    type Anything = Record<string, unknown>;

    const lost = OPTIONAL.filter((m) =>
      typeof (base.runs as unknown as Anything)[m] === 'function'
      && typeof (scoped.runs as unknown as Anything)[m] !== 'function');

    expect(lost,
      'scoping dropped a capability. `incrBy` in particular is the atomic counter usage is built on — '
      + 'losing it makes budget enforcement under-count silently').toEqual([]);
  });

  it('and the atomic counter actually works through the wrapper', async () => {
    const { acme, globex } = twoOrgs();
    await Promise.all([1, 1, 1, 1, 1].map(() => acme.runs.incrBy!('c', { n: 1 })));

    expect((await acme.runs.getCounters!('c'))?.n, 'increments were lost — a get-then-put fallback is in play').toBe(5);
    expect(await globex.runs.getCounters!('c'), 'counters leaked across organizations').toBeUndefined();
  });

  it('listRuns answers the Page contract, not the older array shape', async () => {
    const { acme } = twoOrgs();
    await acme.runs.put('r-1:outcome', { status: 'completed', at: 1 });
    const page = await acme.runs.listRuns!();

    expect(Array.isArray(page),
      'listRuns returned an ARRAY — the scoped value is not a valid RunJournal, and everything that '
      + 'wraps it produces undefined, so the owner sees none of its own runs').toBe(false);
    expect(Array.isArray(page.items), 'the Page has no items array').toBe(true);
    expect(page.items.map((r) => r.runId), 'the owner cannot see its own run').toEqual(['r-1']);
  });

  /**
   * `countRunsByStatus` is absent from the scoped store and that is INHERITED-DELIBERATE, not a new
   * regression: `organization.ts` says it is not bridged on purpose, and @gnldev/studio feature-detects
   * it on the RAW reader for exactly that reason. Asserted so the deliberate omission stays visible —
   * if it ever starts being bridged, the studio fallback around it becomes dead code.
   */
  it('does not bridge countRunsByStatus, matching the journal wrapper', () => {
    const base = new InMemoryStorage();
    expect(typeof (base.runs as unknown as Record<string, unknown>).countRunsByStatus,
      'the base lost it, so this assertion no longer means anything').toBe('function');
    expect(typeof (withOrgStorage(base, 'acme').runs as unknown as Record<string, unknown>).countRunsByStatus,
      'countRunsByStatus is now bridged — studio\'s raw-reader fallback is dead code').toBe('undefined');
  });
});

/**
 * WHOLE-STORE OPERATIONS must not be reachable from an organization's view of the storage.
 *
 * `init`, `close` and `compact` are documented as not forwarded — they act on the whole engine, and one
 * organization calling `close()` on what it believes is its own storage would take the process down for
 * every other tenant.
 *
 * `adoptIntoOrg` is the one that is NOT documented, and it is the most dangerous of the four. It is
 * absent today only because the wrapper builds an explicit object rather than spreading the source, so
 * a later `...storage` would hand every tenant a deployment-wide migration:
 *
 *   withOrgStorage(storage, 'acme').adoptIntoOrg('globex')
 *
 * would rewrite acme's already-prefixed keys to `org:acme:org:globex:` — the nesting the id guards
 * exist to prevent, reached without ever passing an invalid id, because the second scope is applied by
 * a method rather than by the constructor. Asserted by NAME so the absence stops being incidental.
 */
describe('a scoped storage does not expose whole-store operations', () => {
  it.each(['adoptIntoOrg', 'init', 'close', 'compact'])('%s is not reachable from an organization', (method) => {
    const base = new InMemoryStorage() as unknown as Record<string, unknown>;
    const scoped = withOrgStorage(new InMemoryStorage(), 'acme') as unknown as Record<string, unknown>;

    // `init`/`close`/`compact` are OPTIONAL on Storage and InMemoryStorage implements none of them, so
    // only `adoptIntoOrg` can carry a meaningful precondition here — asserted separately below.
    void base;
    expect(typeof scoped[method],
      `${method} is reachable from an organization-scoped storage. For adoptIntoOrg that means a tenant `
      + 'can migrate the whole deployment into a second prefix (org:acme:org:globex:); for close/init it '
      + 'means one tenant acting on every tenant\'s engine.')
      .toBe('undefined');
  });

  it('and the base storage really does offer adoptIntoOrg, so the absence above means something', () => {
    expect(typeof (new InMemoryStorage() as unknown as Record<string, unknown>).adoptIntoOrg,
      'the base has no adoptIntoOrg either — the whole block is vacuous').toBe('function');
  });

  it('so a scoped storage cannot be re-adopted into a second organization', async () => {
    const base = new InMemoryStorage();
    await base.runs.put('r-1:model:0', { x: 1 });
    await base.runs.put('__org__:acme', { id: 'acme' });   // adoption refuses an unregistered organization
    const acme = withOrgStorage(base, 'acme') as unknown as { adoptIntoOrg?: (o: string) => Promise<unknown> };

    expect(acme.adoptIntoOrg, 'the scoped storage offers a migration entry point').toBeUndefined();
    // …and the root still can, which is what the operator actually needs.
    await base.adoptIntoOrg!('acme');
    expect((await base.runs.listKeys!('')).filter((k) => /^org:[^:]+:org:/.test(k)),
      'a nested prefix appeared').toEqual([]);
  });
});
