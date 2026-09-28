// R15: whose an event is never travels in caller-controlled bytes. The owner lives in the id the
// engine writes (`ownedName`); payload is delivered exactly as given.
// R20 (events' share): one person's events AND every consumer's markers for them are erasable
// without knowing any topic or consumer name — a work store cannot list its keys.
// R22: `maxDepth` reads only the caller's own organization's records for the topic.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, ownedName } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents, eventEraser, EventDepthExceededError, type EventMeta } from '../src/index.js';

describe('the owner is not read from the payload', () => {
  it('a system event carrying an owner envelope is delivered as the system\'s, payload untouched', async () => {
    const work = new InMemoryStorage().work!;
    const forged = { __gnlEventOwner: { orgId: 'globex', resourceId: 'victim' }, payload: { cmd: 'x' } };
    await emit(work, 'webhook', forged);
    const got: Array<[unknown, EventMeta]> = [];
    await createConsumer(work, 'webhook', (p, meta) => { got.push([p, meta]); }, { name: 'c' }).poll();
    expect(got[0]![1].resourceId).toBeUndefined();
    expect(got[0]![1].orgId).toBeUndefined();
    expect(got[0]![0]).toEqual(forged);
  });

  it('a system id cannot claim an owner either, nor a topic', async () => {
    const work = new InMemoryStorage().work!;
    const theirs = ownedName('e1', { orgId: 'globex', resourceId: 'victim' });
    await expect(emit(work, 't', {}, { id: theirs })).rejects.toThrow(/reserved/);
    await expect(emit(work, theirs, {})).rejects.toThrow(/reserved/);
    expect(() => createConsumer(work, theirs, () => {}, { name: 'c' })).toThrow(/reserved/);
  });

  it('an owned event is delivered with its owner, whatever the payload says', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 't', { __gnlEventOwner: { resourceId: 'mallory' } }, { resourceId: 'ayse', orgId: 'acme' });
    const metas: EventMeta[] = [];
    await createConsumer(work, 't', (_p, m) => { metas.push(m); }, { name: 'c' }).poll();
    expect({ r: metas[0]!.resourceId, o: metas[0]!.orgId }).toEqual({ r: 'ayse', o: 'acme' });
  });
});

describe('eventEraser', () => {
  it('removes a person\'s events and every consumer\'s markers for them — and nobody else\'s', async () => {
    const work = new InMemoryStorage().work!;
    const first = await emit(work, 'audit', { note: 'AYSE' }, { resourceId: 'ayse', orgId: 'acme' });
    await emit(work, 'audit', { note: 'AYSE-2' }, { resourceId: 'ayse', orgId: 'acme' });
    await emit(work, 'audit', { note: 'BORA' }, { resourceId: 'bora', orgId: 'acme' });
    await emit(work, 'audit', { note: 'AYSE-ELSEWHERE' }, { resourceId: 'ayse', orgId: 'globex' });
    await emit(work, 'audit', { note: 'SYS' });
    // One consumer acks everything; another fails ayse's first event into the dead-letter set.
    await createConsumer(work, 'audit', () => {}, { name: 'ok' }).poll();
    await createConsumer(work, 'audit', (p) => { if ((p as { note: string }).note === 'AYSE') throw new Error('AYSE-ERROR-TEXT'); }, { name: 'bad', maxAttempts: 1 }).poll();
    expect(JSON.stringify(await listDeadEvents(work, 'audit', 'bad'))).toContain('AYSE-ERROR-TEXT');

    const n = await eventEraser(work).erase({ resourceId: 'ayse', orgId: 'acme' });
    expect(n).toBeGreaterThan(0);
    expect(await listDeadEvents(work, 'audit', 'bad')).toEqual([]);
    // The raw markers themselves, not only the listing (which walks the log): gone.
    const k = (fam: string, consumer: string) => `${fam}:${first.replace(/%/g, '%25').replace(/:/g, '%3A')}:audit:${consumer}`;
    for (const [fam, c] of [['evtack', 'ok'], ['evtdead', 'bad'], ['evtatt', 'bad']]) expect(await work.get(k(fam!, c!)), `${fam} ${c}`).toBeUndefined();
    // A fresh consumer sees what is left: bora's, ayse's in ANOTHER organization, and the system's.
    const left: string[] = [];
    await createConsumer(work, 'audit', (p) => { left.push((p as { note: string }).note); }, { name: 'fresh' }).poll();
    expect(left.sort()).toEqual(['AYSE-ELSEWHERE', 'BORA', 'SYS']);
    // The survivors' markers are untouched: the 'ok' consumer does not see them again.
    const again: string[] = [];
    await createConsumer(work, 'audit', (p) => { again.push((p as { note: string }).note); }, { name: 'ok' }).poll();
    expect(again).toEqual([]);
  });

  it('a user id that extends another (`bob` / `bob:evil`) is a different person', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 't', { note: 'EVIL' }, { resourceId: 'bob:evil' });
    await emit(work, 't', { note: 'BOB' }, { resourceId: 'bob' });
    await eventEraser(work).erase({ resourceId: 'bob' });
    const left: string[] = [];
    await createConsumer(work, 't', (p) => { left.push((p as { note: string }).note); }, { name: 'c' }).poll();
    expect(left).toEqual(['EVIL']);
  });
});

describe('maxDepth per organization', () => {
  it('reads one page for an organization with no events on the topic', async () => {
    const work = new InMemoryStorage().work!;
    for (let i = 0; i < 300; i++) await emit(work, 't', i, { orgId: 'globex' });
    let pages = 0;
    const orig = work.list.bind(work);
    (work as { list: typeof work.list }).list = ((ns: string, q?: unknown) => { pages++; return orig(ns, q as never); }) as typeof work.list;
    await emit(work, 't', 0, { orgId: 'acme', maxDepth: 5 });
    expect(pages).toBe(1);
    await expect(emit(work, 't', 0, { orgId: 'globex', maxDepth: 5 })).rejects.toBeInstanceOf(EventDepthExceededError);
  });
});
