// ADR-0002 5a: a queued job's run belongs to the job's recorded owner WITHOUT the handler passing it.
// Before: the handler had to pass `resourceId: ctx.resourceId` on to runDurable, and forgetting it gave
// an ownerless run the user could not see (measured: owner `unknown`). Now the worker records the
// job's owner as the run's owner before the handler runs, and `ctx.run` / `ctx.caller` carry it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, runDurable, runOwnerOf, toJournal, withOrgStorage, user, staff, UNKNOWN, type Caller } from '@gnldev/durable';
import { enqueue, createWorker, retryJob, listJobs } from '../src/index.js';
import { createMockModel, finalTextResult } from '../../durable/test/mock.js';

const model = () => createMockModel(async () => finalTextResult('ok'));
const ownerOf = async (storage: InMemoryStorage, runId: string, orgId?: string) => {
  const runs = orgId ? withOrgStorage(storage, orgId).runs : storage.runs;
  const o = await runOwnerOf(toJournal(runs), runId);
  return o.state === 'owned' ? o.owner : o.state;
};

describe('a job runs as its recorded owner', () => {
  it('ctx.run starts the run as the job\'s user — nothing passed by hand', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 'sum', {}, { resourceId: 'ayse', orgId: 'acme' });
    await createWorker(storage, { sum: async (_p, ctx) => { await ctx.run({ model: model(), prompt: 'weekly' }); } }).drain();
    expect(await ownerOf(storage, `job:${id}`, 'acme')).toEqual(user('ayse', 'acme'));
  });

  it('a handler that forgets the user is refused, not given an ownerless run', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 'sum', {}, { resourceId: 'ayse' });
    const errors: unknown[] = [];
    await createWorker(storage, {
      sum: async (_p, ctx) => { await runDurable({ journal: toJournal(ctx.journal), runId: ctx.runId, model: model(), prompt: 'weekly' }); },
    }, { maxAttempts: 1, onError: (e) => errors.push(e) }).drain();
    expect(String(errors[0])).toMatch(/belongs to a different subject/);
    // The run is still hers — never `unknown`.
    expect(await ownerOf(storage, `job:${id}`)).toEqual(user('ayse'));
    expect((await listJobs(storage.work!))[0]!.status).toBe('failed');
  });

  it('a handler passing another user is refused the same way', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 'sum', {}, { resourceId: 'ayse' });
    const errors: unknown[] = [];
    await createWorker(storage, {
      sum: async (_p, ctx) => { await runDurable({ journal: toJournal(ctx.journal), runId: ctx.runId, resourceId: 'mallory', model: model(), prompt: 'x' }); },
    }, { maxAttempts: 1, onError: (e) => errors.push(e) }).drain();
    expect(String(errors[0])).toMatch(/belongs to a different subject/);
  });

  it('a job with no owner runs as unknown — never staff by omission', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 'sys', {}, { id: 'nightly' });
    let seen: Caller | undefined;
    await createWorker(storage, { sys: async (_p, ctx) => { seen = ctx.caller; await ctx.run({ model: model(), prompt: 'x' }); } }).drain();
    expect(seen).toEqual(UNKNOWN);
    expect(await ownerOf(storage, `job:${id}`)).toEqual(UNKNOWN);
  });

  it('staff is said out loud at enqueue, and kept by a retry and by a follow-up', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 'ops', {}, { caller: staff('acme') });
    const seen: Caller[] = [];
    let fail = true;
    await createWorker(storage, {
      ops: async (_p, ctx) => { seen.push(ctx.caller); if (fail) throw new Error('once'); await ctx.enqueue('next', {}); },
      next: async (_p, ctx) => { seen.push(ctx.caller); },
    }, { maxAttempts: 1 }).drain();
    fail = false;
    const again = await retryJob(storage.work!, id);
    expect(again).toBeTruthy();
    await createWorker(storage, {
      ops: async (_p, ctx) => { seen.push(ctx.caller); await ctx.enqueue('next', {}); },
      next: async (_p, ctx) => { seen.push(ctx.caller); },
    }).drain();
    expect(seen).toEqual([staff('acme'), staff('acme'), staff('acme')]);
    expect(await ownerOf(storage, `job:${again}`, 'acme')).toEqual(staff('acme'));
  });

  it('caller and a different resourceId are refused: one owner per job', async () => {
    const storage = new InMemoryStorage();
    await expect(enqueue(storage.work!, 't', {}, { caller: user('ayse'), resourceId: 'bora' })).rejects.toThrow(/one owner per job/);
    await expect(enqueue(storage.work!, 't', {}, { caller: user('ayse', 'acme'), orgId: 'globex' })).rejects.toThrow(/one owner per job/);
    // The shorthand and the caller agree: the same job.
    const a = await enqueue(storage.work!, 't', {}, { id: 'x', caller: user('ayse', 'acme') });
    const b = await enqueue(storage.work!, 't', {}, { id: 'x', resourceId: 'ayse', orgId: 'acme' });
    expect(b).toBe(a);
  });

  it('a follow-up for another user runs as that user, not as the parent', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 'parent', {}, { resourceId: 'ayse', orgId: 'acme' });
    const seen: Caller[] = [];
    await createWorker(storage, {
      parent: async (_p, ctx) => { await ctx.enqueue('child', {}, { resourceId: 'bora' }); },
      child: async (_p, ctx) => { seen.push(ctx.caller); },
    }).drain();
    expect(seen).toEqual([user('bora', 'acme')]);
  });
});
