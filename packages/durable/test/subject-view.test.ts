// A reader handed to an end user cannot produce another user's run or thread — whether or not the
// code holding it remembered to ask. This is the "forgotten gate" property, tested on the view itself.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, withSubjectJournal, withSubjectMemory, threadOwnerFromRuns, asReaderJournal } from '../src/index.js';

async function seed() {
  const j = asReaderJournal(new InMemoryJournal() as object) as any;
  await j.put('r-ayse:input', { resourceId: 'ayse' });
  await j.put('r-ayse:model:0', { text: 'AYSE-SECRET' });
  await j.put('r-ops:input', {});
  await j.put('r-ops:model:0', { text: 'OPS-SECRET' });
  await j.put('r-mal:input', { resourceId: 'mallory' });
  await j.put('r-mal:model:0', { text: 'MINE' });
  await j.put('org:acme:r-x:input', { resourceId: 'mallory' });
  await j.put('org:acme:r-x:model:0', { text: 'ACME-SECRET' });
  return j;
}

describe('withSubjectJournal', () => {
  it('a caller with no gate at all reads only its own runs', async () => {
    const v = withSubjectJournal(await seed(), 'mallory', { root: true });
    const all = JSON.stringify(await Promise.all(['r-ayse', 'r-ops', 'org:acme:r-x'].map((id) => v.readRun!(id))));
    expect(all).not.toMatch(/SECRET/);
    expect(JSON.stringify(await v.readRun!('r-mal'))).toContain('MINE');
    expect((await v.listRuns!()).map((r) => r.runId)).toEqual(['r-mal']);
    expect(await v.get('org:acme:r-x:model:0')).toBeUndefined();
  });

  it('outside the root, an org-prefixed-looking id is the caller\'s own business', async () => {
    const v = withSubjectJournal(await seed(), 'mallory');
    expect(JSON.stringify(await v.readRun!('org:acme:r-x'))).toContain('ACME-SECRET');
  });
});

describe('withSubjectMemory', () => {
  const base = (lookup: boolean): any => ({
    append: async () => {},
    getMessages: async (t: string) => [{ content: `MSG-${t}` }],
    listThreads: async (o: { resourceId: string }) => [{ id: `t-${o.resourceId}`, resourceId: o.resourceId }],
    listAllThreads: async () => [{ id: 't-ayse' }, { id: 't-mallory' }],
    ...(lookup ? { getThreadResource: async (t: string) => (t === 't-mallory' ? 'mallory' : t === 't-ayse' ? 'ayse' : undefined) } : {}),
  });
  it('refuses another user\'s thread and an ownerless one', async () => {
    const m = withSubjectMemory(base(true), 'mallory');
    expect(await m.getMessages('t-ayse')).toEqual([]);
    expect(await m.getMessages('t-nobody')).toEqual([]);
    expect(await m.getMessages('t-mallory')).toEqual([{ content: 'MSG-t-mallory' }]);
    expect(await m.listAllThreads!()).toEqual([{ id: 't-mallory', resourceId: 'mallory' }]);
  });
  it('fails closed when the store cannot name an owner', async () => {
    const m = withSubjectMemory(base(false), 'mallory');
    expect(await m.getMessages('t-mallory')).toEqual([]);
  });
});

describe('threadOwnerFromRuns', () => {
  it('lets an owner-blind memory serve its owner, and nobody else', async () => {
    const j = asReaderJournal(new InMemoryJournal() as object) as any;
    await j.put('r1:input', { resourceId: 'mallory', threadId: 't-m' });
    await j.put('r2:input', { resourceId: 'ayse', threadId: 't-a' });
    await j.put('r3:input', { threadId: 't-a' });
    for (const r of ['r1', 'r2', 'r3']) await j.put(`${r}:model:0`, {});
    const mem: any = { append: async () => {}, getMessages: async (t: string) => [t] };
    const m = withSubjectMemory(mem, 'mallory', { threadOwner: threadOwnerFromRuns(j) });
    expect(await m.getMessages('t-m')).toEqual(['t-m']);
    expect(await m.getMessages('t-a')).toEqual([]);
    const a = withSubjectMemory(mem, 'ayse', { threadOwner: threadOwnerFromRuns(j) });
    expect(await a.getMessages('t-a')).toEqual([]); // an ownerless run on it pins it to nobody
  });
});
