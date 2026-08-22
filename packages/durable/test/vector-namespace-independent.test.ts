// The `VectorStore` namespace — and the failure mode a leak test cannot see.
//
// Scoping a vector search by filtering AFTER ranking leaks nothing and errors on nothing. It just
// returns fewer documents than the caller asked for, and how many fewer depends on how similar OTHER
// tenants' documents happen to be. Acme's search silently degrades as globex uploads data.
//
// So the control is not "acme sees no globex rows" — that passes trivially, and passes just as well
// when acme sees nothing at all. It is: ACME GETS THE SAME K DOCUMENTS, IN THE SAME ORDER, WHETHER OR
// NOT GLOBEX EXISTS. A rank-then-filter implementation cannot pass that; filter-then-rank can.
//
// The rival's documents are deliberately placed CLOSER to the query than the owner's, so a rank-first
// implementation loses the whole result set rather than a tail of it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/index.js';
import type { VectorStore } from '../src/storage.js';

/** Four owner documents at descending similarity to [1,0,0]; the rival sits strictly closer. */
const ACME = [
  { id: 'a1', text: 'acme-1', namespace: 'acme', embedding: [0.90, 0.44, 0] },
  { id: 'a2', text: 'acme-2', namespace: 'acme', embedding: [0.80, 0.60, 0] },
  { id: 'a3', text: 'acme-3', namespace: 'acme', embedding: [0.70, 0.71, 0] },
  { id: 'a4', text: 'acme-4', namespace: 'acme', embedding: [0.60, 0.80, 0] },
];
const GLOBEX = [
  { id: 'g1', text: 'globex-1', namespace: 'globex', embedding: [1, 0, 0] },
  { id: 'g2', text: 'globex-2', namespace: 'globex', embedding: [0.99, 0.14, 0] },
  { id: 'g3', text: 'globex-3', namespace: 'globex', embedding: [0.98, 0.20, 0] },
  { id: 'g4', text: 'globex-4', namespace: 'globex', embedding: [0.97, 0.24, 0] },
];
const Q = [1, 0, 0];

const vectorsOf = (): VectorStore => new InMemoryStorage().vectors!;

describe('a namespaced query is answered from that namespace only', () => {
  it('the owner gets the same results whether or not a rival exists', async () => {
    const alone = vectorsOf();
    await alone.upsert(ACME);
    const before = await alone.query(Q, 4, { namespace: 'acme' });

    const shared = vectorsOf();
    await shared.upsert([...ACME, ...GLOBEX]);
    const after = await shared.query(Q, 4, { namespace: 'acme' });

    expect(before.map((m) => m.id), 'the owner could not retrieve its own documents at all').toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(after.map((m) => m.id),
      "a rival's documents changed the owner's result set — the filter runs after ranking, so recall "
      + 'degrades as other tenants upload, with no leak and no error to show for it')
      .toEqual(before.map((m) => m.id));
  });

  it('and asking for K returns K, not what survived a global top-K', async () => {
    const store = vectorsOf();
    await store.upsert([...ACME, ...GLOBEX]);

    // Every globex document outranks every acme one, so a rank-then-filter implementation returns 0.
    expect((await store.query(Q, 4, { namespace: 'acme' })).length,
      'the owner asked for 4 and got fewer — its whole result set was spent on a rival it cannot see')
      .toBe(4);
  });

  it('scores are the owner\'s own, not positions in a shared ranking', async () => {
    const alone = vectorsOf();
    await alone.upsert(ACME);
    const shared = vectorsOf();
    await shared.upsert([...ACME, ...GLOBEX]);

    const a = await alone.query(Q, 4, { namespace: 'acme' });
    const b = await shared.query(Q, 4, { namespace: 'acme' });
    expect(b.map((m) => m.score), 'the rival moved the owner\'s scores').toEqual(a.map((m) => m.score));
  });

  it('a namespace that was never written returns nothing, rather than everything', async () => {
    const store = vectorsOf();
    await store.upsert([...ACME, ...GLOBEX]);

    expect(await store.query(Q, 10, { namespace: 'does-not-exist' }),
      'an unknown namespace fell through to an unrestricted search').toEqual([]);
  });
});

describe('the un-namespaced partition', () => {
  // `undefined` on WRITE is its own partition, not a wildcard: a store written before namespaces
  // existed keeps its documents there, and a caller asking for `x` must never be answered from it.
  it('is not visible to a namespaced query', async () => {
    const store = vectorsOf();
    await store.upsert([{ id: 'legacy', text: 'pre-namespace', embedding: [1, 0, 0] }, ...ACME]);

    const mine = await store.query(Q, 10, { namespace: 'acme' });
    expect(mine.map((m) => m.id), 'a legacy un-namespaced document answered a namespaced query')
      .not.toContain('legacy');
  });

  it('is reachable on its own terms', async () => {
    const store = vectorsOf();
    await store.upsert([{ id: 'legacy', text: 'pre-namespace', embedding: [1, 0, 0] }, ...ACME]);

    // `namespace: undefined` is indistinguishable from an omitted property in JS, so the un-namespaced
    // partition cannot be selected explicitly — it can only be reached by the unrestricted query below.
    // Recorded because it is the one asymmetry a caller cannot work around.
    const all = await store.query(Q, 10);
    expect(all.map((m) => m.id), 'the unrestricted query lost the legacy partition').toContain('legacy');
  });

  /**
   * THE ASYMMETRY, stated as a test rather than a comment: an OMITTED `namespace` on read means "no
   * restriction", so the default query searches every organization. That is the pre-existing behaviour
   * and the only backwards-compatible default, and it is safe only because the isolation lives in
   * `withOrgStorage`, which always supplies one.
   *
   * It is still the `else` shape every leak in this repo has sat in. It is asserted here so that the
   * day a call site reaches `storage.vectors` directly instead of the scoped wrapper, the behaviour it
   * gets is written down rather than assumed.
   */
  it('an omitted namespace searches everything — the unsafe default the wrapper exists to prevent', async () => {
    const store = vectorsOf();
    await store.upsert([...ACME, ...GLOBEX]);

    const namespaces = new Set((await store.query(Q, 10)).map((m) => m.namespace));
    expect(namespaces, 'the raw port stopped being unrestricted — the wrapper may now be redundant')
      .toEqual(new Set(['acme', 'globex']));
  });
});

describe('what comes back', () => {
  it('carries the namespace it was stored under', async () => {
    const store = vectorsOf();
    await store.upsert(ACME);
    expect((await store.query(Q, 1, { namespace: 'acme' }))[0]?.namespace).toBe('acme');
  });

  it('omits the namespace entirely for an un-namespaced document', async () => {
    const store = vectorsOf();
    await store.upsert([{ id: 'legacy', text: 'x', embedding: [1, 0, 0] }]);
    const [hit] = await store.query(Q, 1);

    expect('namespace' in (hit as object),
      'an un-namespaced document came back carrying `namespace: undefined`, which is a different shape '
      + 'from the one it was stored with').toBe(false);
  });

  it('an upsert of the same id replaces it rather than duplicating across namespaces', async () => {
    const store = vectorsOf();
    await store.upsert([{ id: 'a1', text: 'first', namespace: 'acme', embedding: [1, 0, 0] }]);
    await store.upsert([{ id: 'a1', text: 'second', namespace: 'acme', embedding: [1, 0, 0] }]);

    const hits = await store.query(Q, 10, { namespace: 'acme' });
    expect(hits, 'the same id exists twice in one namespace').toHaveLength(1);
    expect(hits[0]!.text).toBe('second');
  });
});
