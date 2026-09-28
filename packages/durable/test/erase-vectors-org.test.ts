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
    await eraseSubject({ journal: toJournal(storage.runs), vectors: storage.vectors! }, 'bob', { orgId: 'acme' });
    const ids = await left();
    expect(ids.filter((id) => id.includes('globex'))).toEqual(['org:globex:DOC-globex-bob']);
    expect(ids.some((id) => id.includes('DOC-acme-bob'))).toBe(false);
  });

  it('sibling: another person in the same organization keeps their document', async () => {
    const { storage, left } = await world();
    await eraseSubject({ journal: toJournal(storage.runs), vectors: storage.vectors! }, 'bob', { orgId: 'acme' });
    expect(await left()).toContain('org:acme:DOC-acme-cem');
  });

  it('sibling: the organization-less bob keeps his document when acme\'s bob is erased', async () => {
    const { storage, left } = await world();
    await eraseSubject({ journal: toJournal(storage.runs), vectors: storage.vectors! }, 'bob', { orgId: 'acme' });
    expect(await left()).toContain('DOC-root-bob');
  });

  it('sibling: an organization-scoped vector store handed in is not scoped twice (its own bob goes)', async () => {
    const { storage, left } = await world();
    await eraseSubject({ journal: toJournal(storage.runs), vectors: withOrgStorage(storage, 'acme').vectors! }, 'bob', { orgId: 'acme' });
    const ids = await left();
    expect(ids.some((id) => id.includes('DOC-acme-bob'))).toBe(false);
    expect(ids).toContain('org:globex:DOC-globex-bob');
  });
});
