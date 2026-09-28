// E2: an organization-scoped work store handed to an erasure. Owned jobs and events live in the ROOT
// work log (their owner, organization included, is in their id), so an organization's view of the work
// store holds none of them, and its `deleteIdPrefix` could not be scoped anyway: the port deletes by id
// prefix in EVERY namespace. Forwarding it would erase other organizations' records; ignoring it would
// report an erasure that did nothing. It is refused — naming the remedy, as `emit` and `enqueue` do for
// the same handed-in store.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, toJournal, eraseSubject } from '../src/index.js';
import { enqueue, jobEraser } from '../../queue/src/index.js';
import { emit, eventEraser } from '../../events/src/index.js';

const REMEDY = /root storage/;

async function world() {
  const storage = new InMemoryStorage();
  await enqueue(storage.work!, 'j', { note: 'JOB-ayse-acme' }, { resourceId: 'ayse', orgId: 'acme' });
  await emit(storage.work!, 't', { note: 'EVT-ayse-acme' }, { resourceId: 'ayse', orgId: 'acme' });
  return { storage, acme: withOrgStorage(storage, 'acme') };
}

describe('an organization-scoped work store is refused by every erasure, with the remedy', () => {
  it('eraseSubject', async () => {
    const { storage, acme } = await world();
    await expect(eraseSubject({ journal: toJournal(storage.runs), work: acme.work! }, 'ayse', { orgId: 'acme' })).rejects.toThrow(REMEDY);
  });

  it('jobEraser', async () => {
    const { acme } = await world();
    await expect(jobEraser(acme).erase({ resourceId: 'ayse', orgId: 'acme' })).rejects.toThrow(REMEDY);
  });

  it('eventEraser', async () => {
    const { acme } = await world();
    await expect(eventEraser(acme.work!).erase({ resourceId: 'ayse', orgId: 'acme' })).rejects.toThrow(REMEDY);
  });

  it('control: the root store with { orgId } erases her jobs and events', async () => {
    const { storage } = await world();
    const r = await eraseSubject({ journal: toJournal(storage.runs), work: storage.work!, erasers: [jobEraser(storage), eventEraser(storage.work!)] }, 'ayse', { orgId: 'acme' });
    expect(r.workRecords).toBeGreaterThan(0);
  });
});
