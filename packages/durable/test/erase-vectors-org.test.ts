// Erasing a person IN AN ORGANIZATION erases that organization's documents of theirs, and nobody
// else's. Measured (E1): `eraseSubject` with the root vector store and `orgId: 'acme'` also deleted
// globex's `bob` document — the vector delete named the owner and no namespace, and `bob` in globex is
// somebody else. The runs half already keeps to the organization's partition (withOrg); the documents
// half now keeps to its namespace, the one withOrgStorage writes them under.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { withOrgStorage } from '../src/org-storage.js';
import { toJournal } from '../src/storage.js';
import { eraseSubject } from '../src/erase.js';
import { purgeResource } from '../src/retention.js';
import type { Storage, VectorStore } from '../src/storage.js';

/** The same storage, with another vector store in front of it: a third-party adapter. */
const withVectors = (storage: Storage, vectors: Pick<VectorStore, 'delete'>): Storage => Object.assign(Object.create(storage), { vectors });

async function world() {
  const storage = new InMemoryStorage();
  const put = (org: string | undefined, id: string, owner: string) =>
    (org ? withOrgStorage(storage, org).vectors! : storage.vectors!).upsert([{ id, text: id, embedding: [1, 0], owner }]);
  await put('acme', 'DOC-acme-bob', 'bob');
  await put('acme', 'DOC-acme-cem', 'cem');
  await put('globex', 'DOC-globex-bob', 'bob');
  await put(undefined, 'DOC-root-bob', 'bob');
  /** Every document id left in the store, whichever organization holds it. */
  const left = async () => (await storage.vectors!.query([1, 0], 100)).map((m) => m.id).sort();
  return { storage, left };
}

describe('eraseSubject with orgId erases documents in that organization only', () => {
  it('acme\'s bob goes; globex\'s bob stays (the claim)', async () => {
    const { storage, left } = await world();
    await eraseSubject(storage, 'bob', { orgId: 'acme' });
    const ids = await left();
    expect(ids.filter((id) => id.includes('globex'))).toEqual(['org:globex:DOC-globex-bob']);
    expect(ids.some((id) => id.includes('DOC-acme-bob'))).toBe(false);
  });

  it('sibling: another person in the same organization keeps their document', async () => {
    const { storage, left } = await world();
    await eraseSubject(storage, 'bob', { orgId: 'acme' });
    expect(await left()).toContain('org:acme:DOC-acme-cem');
  });

  it('sibling: the organization-less bob keeps his document when acme\'s bob is erased', async () => {
    const { storage, left } = await world();
    await eraseSubject(storage, 'bob', { orgId: 'acme' });
    expect(await left()).toContain('DOC-root-bob');
  });

  it('sibling: erasing acme\'s bob keeps shared documents', async () => {
    const { storage, left } = await world();
    await withOrgStorage(storage, 'acme').vectors!.upsert([{ id: 'DOC-acme-shared', text: 's', embedding: [1, 0], shared: true }]);
    await eraseSubject(storage, 'bob', { orgId: 'acme' });
    expect(await left()).toContain('org:acme:DOC-acme-shared');
  });

  it('sibling: an organization\'s view of the storage is refused, and nothing is deleted', async () => {
    const { storage, left } = await world();
    await expect(eraseSubject(withOrgStorage(storage, 'acme'), 'bob', { orgId: 'acme' })).rejects.toThrow(/root storage/);
    expect(await left()).toHaveLength(4);
  });
});

// E1b, the other direction. Erasing the ORGANIZATION-LESS bob named the owner and nothing else, so
// the delete also took acme's and globex's bob — two other people. Measured before the fix:
// `LEFT []`. The runs half already skips organization partitions (`outsideOrganizations`); the
// documents half now says the same thing to the store.
describe('eraseSubject without orgId erases documents outside every organization only', () => {
  it('the organization-less bob goes; acme\'s and globex\'s bob stay (the claim)', async () => {
    const { storage, left } = await world();
    await storage.vectors!.upsert([{ id: 'DOC-topic-bob', text: 't', embedding: [1, 0], owner: 'bob', namespace: 'topic' }]);
    await eraseSubject(storage, 'bob');
    expect(await left()).toEqual(['org:acme:DOC-acme-bob', 'org:acme:DOC-acme-cem', 'org:globex:DOC-globex-bob']);
  });

  it('sibling: shared documents, in or out of an organization, stay', async () => {
    const { storage, left } = await world();
    await storage.vectors!.upsert([{ id: 'DOC-root-shared', text: 's', embedding: [1, 0], shared: true }]);
    await withOrgStorage(storage, 'acme').vectors!.upsert([{ id: 'DOC-acme-shared', text: 's', embedding: [1, 0], shared: true }]);
    await eraseSubject(storage, 'bob');
    expect(await left()).toEqual(expect.arrayContaining(['DOC-root-shared', 'org:acme:DOC-acme-shared']));
  });

  it('sibling: purgeResource without outsideOrganizations keeps its old meaning — the owner everywhere', async () => {
    const { storage, left } = await world();
    await purgeResource(toJournal(storage.runs), 'bob', { vectors: storage.vectors! });
    expect(await left()).toEqual(['org:acme:DOC-acme-cem']);
  });

  it('a store that does not declare the flag is refused before anything is deleted, not trusted to understand it', async () => {
    const { storage, left } = await world();
    // A third-party adapter written before the flag: it reads `owner` and ignores the rest.
    const legacy: Pick<VectorStore, 'delete'> = { delete: (w) => storage.vectors!.delete!({ ...(w.owner !== undefined ? { owner: w.owner } : {}) }) };
    await expect(eraseSubject(withVectors(storage, legacy), 'bob')).rejects.toThrow(/outsideOrganizations/);
    expect(await left()).toHaveLength(4);
    // The same kind of adapter still serves an organization's erasure: that path carries a namespace.
    const nsAware: Pick<VectorStore, 'delete'> = { delete: (w) => storage.vectors!.delete!({ owner: w.owner!, namespace: w.namespace! }) };
    await eraseSubject(withVectors(storage, nsAware), 'bob', { orgId: 'acme' });
    expect(await left()).toEqual(['DOC-root-bob', 'org:acme:DOC-acme-cem', 'org:globex:DOC-globex-bob']);
  });
});
