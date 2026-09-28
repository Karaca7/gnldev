// Owner metadata travels in the NAME the engine writes (`ownedName`), never in caller bytes, and one
// erasure (`eraseSubject`) removes a person's runs, threads, documents, jobs, triggers and events.
// (Kept from the candidate-B acceptance probes; these areas belong to ADR-0002 phase 2.)
import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, indexDocuments } from '../../rag/src/index.js';
import { runDurable } from '../src/run.js';
import { InMemoryStorage, BasicMemory, eraseSubject, toJournal } from '../src/index.js';
import { enqueue, listJobs } from '../../queue/src/index.js';
import { emit, createConsumer } from '../../events/src/index.js';
import { scheduleWorkflow, listTriggers } from '../../scheduler/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const J = (v: unknown) => JSON.stringify(v);

describe('owner in the name, one erasure', () => {
  it('a system event whose payload carries an owner envelope is delivered as the system\'s', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 'webhook', { __gnlEventOwner: { orgId: 'globex', resourceId: 'victim' }, payload: { cmd: 'x' } });
    const got: any[] = [];
    await createConsumer(work, 'webhook', (p, meta) => { got.push({ p, meta }); }, { name: 'c' }).poll();
    expect(got[0].meta.resourceId).toBeUndefined();
    expect(got[0].meta.orgId).toBeUndefined();
  });

  it('a system id cannot collide with an owned one, and a lone surrogate does not throw', async () => {
    const work = new InMemoryStorage().work!;
    const a = await enqueue(work, 'report', {}, { id: 'acme:bob:x' });
    const b = await enqueue(work, 'report', {}, { id: 'x', orgId: 'acme', resourceId: 'bob' });
    expect(a).not.toBe(b);
    await expect(enqueue(work, 'r', 1, { id: 'k', resourceId: 'u\uD800' })).resolves.toBeTypeOf('string');
    await expect(enqueue(work, 'r', 1, { id: b })).rejects.toThrow(/reserved/);
  });

  it('eraseSubject removes a person\'s runs, threads, documents, jobs, triggers and events', async () => {
    const storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    const vectors = new InMemoryVectorStore();
    await indexDocuments(vectors, async () => [1, 0], [{ id: 'd', text: 'Ayse private', owner: 'ayse' }, { id: 's', text: 'shared', shared: true }]);
    await enqueue(storage.work!, 'weekly', { note: 'Ayse data' }, { resourceId: 'ayse' });
    await enqueue(storage.work!, 'weekly', { note: 'system' });
    await emit(storage.work!, 'audit', { note: 'Ayse event' }, { resourceId: 'ayse' });
    await scheduleWorkflow(journal, { id: 'ayse-weekly', every: 3600_000, name: 'summary', resourceId: 'ayse' });
    await scheduleWorkflow(journal, { id: 'sys', every: 3600_000, name: 'summary' });
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'ra', journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'AYSE-SECRET', threadId: 'ta', memory, resourceId: 'ayse' });
    await eraseSubject({ journal, work: storage.work!, vectors, memory }, 'ayse');
    const events: unknown[] = [];
    await createConsumer(storage.work!, 'audit', (p) => { events.push(p); }, { name: 'c' }).poll();
    expect((await vectors.query([1, 0], 10)).map((m) => m.text)).toEqual(['shared']);
    expect((await listJobs(storage.work!)).filter((j: any) => j.resourceId === 'ayse')).toEqual([]);
    expect((await listJobs(storage.work!)).length).toBe(1);
    expect((await listTriggers(journal)).map((t: any) => t.id)).toEqual(['sys']);
    expect(events).toEqual([]);
    expect(await journal.get('ra:input')).toBeUndefined();
    expect(J(await memory.getMessages('ta'))).not.toContain('AYSE-SECRET');
  });
});
