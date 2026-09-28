// A reader handed to an end user cannot produce another user's run or thread — whether or not the
// code holding it remembered to ask. This is the "forgotten gate" property, tested on the view itself.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, withSubjectJournal, withSubjectMemory, asReaderJournal } from '../src/index.js';

async function seed() {
  const j = asReaderJournal(new InMemoryJournal() as object) as any;
  await j.put('r-ayse:input', { _v: 2, resourceId: 'ayse' });
  await j.put('r-ayse:model:0', { text: 'AYSE-SECRET' });
  await j.put('r-ops:input', { _v: 2 });
  await j.put('r-ops:model:0', { text: 'OPS-SECRET' });
  await j.put('r-mal:input', { _v: 2, resourceId: 'mallory' });
  await j.put('r-mal:model:0', { text: 'MINE' });
  await j.put('org:acme:r-x:input', { _v: 2, resourceId: 'mallory' });
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
    const m = withSubjectMemory(base(true), 'mallory', { journal: new InMemoryJournal() });
    expect(await m.getMessages('t-ayse')).toEqual([]);
    expect(await m.getMessages('t-nobody')).toEqual([]);
    expect(await m.getMessages('t-mallory')).toEqual([{ content: 'MSG-t-mallory' }]);
    expect(await m.listAllThreads!()).toEqual([{ id: 't-mallory', resourceId: 'mallory' }]);
  });
  it('fails closed when the store cannot name an owner', async () => {
    const m = withSubjectMemory(base(false), 'mallory', { journal: new InMemoryJournal() });
    expect(await m.getMessages('t-mallory')).toEqual([]);
  });
});

describe('an owner-blind memory, read through the thread owner (threadOwnerOf)', () => {
  it('serves its owner, and nobody else', async () => {
    const j = asReaderJournal(new InMemoryJournal() as object) as any;
    await j.put('r1:input', { _v: 2, resourceId: 'mallory', threadId: 't-m' });
    await j.put('r2:input', { _v: 2, resourceId: 'ayse', threadId: 't-a' });
    await j.put('r3:input', { _v: 2, threadId: 't-a' });
    for (const r of ['r1', 'r2', 'r3']) await j.put(`${r}:model:0`, {});
    const mem: any = { append: async () => {}, getMessages: async (t: string) => [t] };
    const m = withSubjectMemory(mem, 'mallory', { journal: j });
    expect(await m.getMessages('t-m')).toEqual(['t-m']);
    expect(await m.getMessages('t-a')).toEqual([]);
    const a = withSubjectMemory(mem, 'ayse', { journal: j });
    expect(await a.getMessages('t-a')).toEqual([]); // an ownerless run on it pins it to nobody
  });
});

// `get` is the door the rest of this view does not cover by itself: a route that reads a run's entry
// by key — a workflow step, a model turn, the registry row — got it whoever owned the run. The view's
// promise is that a forgotten gate still cannot produce another user's record; that has to hold here.
describe('withSubjectJournal.get', () => {
  async function seeded() {
    const j = asReaderJournal(new InMemoryJournal() as object) as any;
    await j.put('wf-ayse:input', { _v: 2, resourceId: 'ayse' });
    await j.put('wf-ayse:wf:summarise', { text: 'AYSE-STEP' });
    await j.put('wfrun:wf-ayse', { runId: 'wf-ayse', status: 'completed' });
    await j.put('wf-mal:input', { _v: 2, resourceId: 'mallory' });
    await j.put('wf-mal:wf:summarise', { text: 'MAL-STEP' });
    await j.put('wfrun:wf-mal', { runId: 'wf-mal', status: 'completed' });
    await j.put('ops:input', { _v: 2 });
    await j.put('ops:wf:s', { text: 'OPS-STEP' });
    await j.put('not-a-run-record', { text: 'LOOSE' });
    // Run ids contain ':', so one key can sit under two runs. It is readable only when EVERY run it
    // could belong to is the caller's: someone who names a run after another's prefix can then block
    // a read, never make one.
    await j.put('x:input', { _v: 2, resourceId: 'mallory' });
    await j.put('x:y:input', { _v: 2, resourceId: 'ayse' });
    await j.put('x:y:wf:s', { text: 'AYSE-NESTED' });
    await j.put('x:wf:s', { text: 'MAL-OUTER' });
    return j;
  }

  it('reads a key only under a run the caller owns', async () => {
    const m = withSubjectJournal(await seeded(), 'mallory');
    expect(await m.get('wf-ayse:wf:summarise')).toBeUndefined();
    expect(await m.get('wf-ayse:input')).toBeUndefined();
    expect(await m.get('wfrun:wf-ayse')).toBeUndefined();
    expect(await m.get('wf-mal:wf:summarise')).toEqual({ text: 'MAL-STEP' });
    expect(await m.get('wfrun:wf-mal')).toEqual({ runId: 'wf-mal', status: 'completed' });
  });

  it('an ownerless run and a key that belongs to no run are nobody\'s', async () => {
    const m = withSubjectJournal(await seeded(), 'mallory');
    expect(await m.get('ops:wf:s')).toBeUndefined();
    expect(await m.get('not-a-run-record')).toBeUndefined();
  });

  it('a key under two runs with different owners is readable by neither', async () => {
    const m = withSubjectJournal(await seeded(), 'mallory');
    const a = withSubjectJournal(await seeded(), 'ayse');
    expect(await m.get('x:y:wf:s')).toBeUndefined();
    expect(await a.get('x:y:wf:s')).toBeUndefined();
    // A key under only one run is that run's.
    expect(await a.get('x:wf:s')).toBeUndefined();
    expect(await m.get('x:wf:s')).toEqual({ text: 'MAL-OUTER' });
  });

  it('naming a run after someone else\'s record does not make the record yours', async () => {
    const j = await seeded();
    // Mallory's own run, named so that Ayşe's step key sits under it too.
    await j.put('wf-ayse:wf:input', { _v: 2, resourceId: 'mallory' });
    expect(await withSubjectJournal(j, 'mallory').get('wf-ayse:wf:summarise')).toBeUndefined();
  });

  it('listKeys names only what get would answer', async () => {
    const m = withSubjectJournal(await seeded(), 'mallory');
    expect((await m.listKeys!('wfrun:')).sort()).toEqual(['wfrun:wf-mal']);
  });
});
