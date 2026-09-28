// A job id names a job WITHIN its owner, like every other name the engine takes from a caller. The
// queue is one log for every organization, so an explicit id was global: globex's `weekly-report`
// collapsed into acme's (same id, "already enqueued") and globex's job never ran. A follow-up job
// enqueued through the handler's org-scoped storage landed where no worker polls. And one
// organization filling `maxDepth` refused every other organization's work.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, userIdOf } from '@gnldev/durable';
import { enqueue, createWorker, listJobs, retryJob, QueueDepthExceededError } from '../src/index.js';

describe('job ids belong to their owner', () => {
  it('two organizations with the same explicit id get two jobs, each run as its own', async () => {
    const storage = new InMemoryStorage();
    const a = await enqueue(storage.work!, 'report', { who: 'acme' }, { id: 'weekly-report', resourceId: 'ayse', orgId: 'acme' });
    const b = await enqueue(storage.work!, 'report', { who: 'globex' }, { id: 'weekly-report', resourceId: 'bora', orgId: 'globex' });
    expect(b).not.toBe(a);
    const seen: unknown[] = [];
    await createWorker(storage, { report: async (p, ctx) => { seen.push([p, ctx.orgId, userIdOf(ctx.caller)]); } }).drain();
    expect(seen).toEqual([[{ who: 'acme' }, 'acme', 'ayse'], [{ who: 'globex' }, 'globex', 'bora']]);
  });

  it('two users in one organization with the same id get two jobs; one user repeating it gets one', async () => {
    const storage = new InMemoryStorage();
    const a1 = await enqueue(storage.work!, 't', {}, { id: 'x', resourceId: 'ayse', orgId: 'acme' });
    const a2 = await enqueue(storage.work!, 't', {}, { id: 'x', resourceId: 'ayse', orgId: 'acme' });
    const m = await enqueue(storage.work!, 't', {}, { id: 'x', resourceId: 'mallory', orgId: 'acme' });
    expect(a2).toBe(a1);
    expect(m).not.toBe(a1);
    expect((await listJobs(storage.work!)).length).toBe(2);
  });

  it('a system job keeps the id it was given, byte for byte', async () => {
    const storage = new InMemoryStorage();
    expect(await enqueue(storage.work!, 't', {}, { id: 'nightly' })).toBe('nightly');
  });

  it('an id with a colon cannot be spelled into another owner\'s', async () => {
    const storage = new InMemoryStorage();
    const a = await enqueue(storage.work!, 't', {}, { id: 'x', resourceId: 'b', orgId: 'a' });
    const forged = await enqueue(storage.work!, 't', {}, { id: 'b:x', orgId: 'a' });
    expect(forged).not.toBe(a);
    // A user id with a colon in it, against a job id with one: without encoding both read `a:b:c:d`.
    const one = await enqueue(storage.work!, 't', {}, { id: 'c:d', resourceId: 'b', orgId: 'a' });
    const two = await enqueue(storage.work!, 't', {}, { id: 'd', resourceId: 'b:c', orgId: 'a' });
    expect(two).not.toBe(one);
  });

  it('retryJob addresses the job by the id enqueue returned', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {}, { id: 'dead', resourceId: 'ayse', orgId: 'acme' });
    await createWorker(storage, { t: async () => { throw new Error('x'); } }, { maxAttempts: 1 }).drain();
    expect(await retryJob(storage.work!, id)).toBeTruthy();
  });
});

describe('a follow-up job', () => {
  it('ctx.enqueue lands in the worker\'s queue, as the same user in the same organization', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 'parent', {}, { id: 'p1', resourceId: 'ayse', orgId: 'acme' });
    const ran: unknown[] = [];
    await createWorker(storage, {
      parent: async (_p, ctx) => { ran.push('parent'); await ctx.enqueue('child', { n: 1 }); },
      child: async (p, ctx) => { ran.push(['child', p, ctx.orgId, userIdOf(ctx.caller)]); },
    }).drain();
    expect(ran).toEqual(['parent', ['child', { n: 1 }, 'acme', 'ayse']]);
  });

  it('enqueuing into an organization-scoped store is refused, not silently lost', async () => {
    const storage = new InMemoryStorage();
    await expect(enqueue(withOrgStorage(storage, 'acme').work!, 't', {})).rejects.toThrow(/ctx\.enqueue|organization/);
  });
});

describe('maxDepth is counted per organization', () => {
  it('one organization at its limit does not refuse another', async () => {
    const storage = new InMemoryStorage();
    for (let i = 0; i < 3; i++) await enqueue(storage.work!, 't', {}, { orgId: 'acme', maxDepth: 3 });
    await expect(enqueue(storage.work!, 't', {}, { orgId: 'acme', maxDepth: 3 })).rejects.toBeInstanceOf(QueueDepthExceededError);
    await expect(enqueue(storage.work!, 't', {}, { orgId: 'globex', maxDepth: 3 })).resolves.toBeTruthy();
  });
});
