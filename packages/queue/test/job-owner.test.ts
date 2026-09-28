// A job started for an end user stays theirs: the queue carries whose it is and which organization it
// belongs to, and hands both to the handler — so the run it starts lands in that organization, stamped
// with that user, and the user can see and approve it. A job without them is the system's, as before.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, withSubjectJournal, user, UNKNOWN } from '@gnldev/durable';
import { enqueue, createWorker, listJobs, retryJob, type JobCtx } from '../src/index.js';

describe('a job enqueued on behalf of an end user', () => {
  it('reaches the handler with the user, the organization, and storage scoped to it', async () => {
    const storage = new InMemoryStorage();
    // An owned job's id is the one enqueue returns (`<org>:<user>:<id>`), not the bare name given.
    const j1 = await enqueue(storage.work!, 'summary', { week: 39 }, { id: 'j1', resourceId: 'ayse', orgId: 'acme' });
    let seen: JobCtx | undefined;
    await createWorker(storage, {
      summary: async (_p, ctx) => {
        seen = ctx;
        // The worker has already recorded the job's owner as the owner of ctx.runId.
        await ctx.journal.put(`${ctx.runId}:model:0`, { text: 'WEEKLY' });
      },
    }).drain();
    expect(seen?.caller).toEqual(user('ayse', 'acme'));
    expect(seen?.orgId).toBe('acme');

    // The run is in acme's partition, and nowhere else.
    expect(await storage.runs.get(`org:acme:job:${j1}:model:0`)).toEqual({ text: 'WEEKLY' });
    expect(await storage.runs.get(`job:${j1}:model:0`)).toBeUndefined();
    // Through acme's own view: Ayşe reads it, Mallory does not.
    const acme = withOrgStorage(storage, 'acme').runs as any;
    expect(JSON.stringify(await withSubjectJournal(acme, 'ayse').readRun!(`job:${j1}`))).toContain('WEEKLY');
    expect(JSON.stringify(await withSubjectJournal(acme, 'mallory').readRun!(`job:${j1}`) ?? null)).not.toContain('WEEKLY');
  });

  it('the listing says whose each job is', async () => {
    const storage = new InMemoryStorage();
    const mine = await enqueue(storage.work!, 't', {}, { id: 'mine', resourceId: 'ayse', orgId: 'acme' });
    await enqueue(storage.work!, 't', {}, { id: 'sys' });
    const byId = Object.fromEntries((await listJobs(storage.work!)).map((j) => [j.id, j]));
    expect({ r: byId[mine]!.resourceId, o: byId[mine]!.orgId }).toEqual({ r: 'ayse', o: 'acme' });
    expect({ r: byId.sys!.resourceId, o: byId.sys!.orgId }).toEqual({ r: undefined, o: undefined });
  });

  it('a malformed organization is refused at the door, not discovered by the worker five retries later', async () => {
    const storage = new InMemoryStorage();
    await expect(enqueue(storage.work!, 't', {}, { orgId: 'a:b' })).rejects.toThrow(/invalid orgId/);
    await expect(enqueue(storage.work!, 't', {}, { orgId: '' })).rejects.toThrow(/invalid orgId/);
    await expect(enqueue(storage.work!, 't', {}, { resourceId: '' })).rejects.toThrow(/resourceId/);
  });

  it('a retried job is still the same user\'s, in the same organization', async () => {
    const storage = new InMemoryStorage();
    const dead = await enqueue(storage.work!, 't', {}, { id: 'dead', resourceId: 'ayse', orgId: 'acme' });
    await createWorker(storage, { t: async () => { throw new Error('boom'); } }, { maxAttempts: 1 }).drain();
    const again = await retryJob(storage.work!, dead);
    const job = (await listJobs(storage.work!)).find((j) => j.id === again)!;
    expect({ r: job.resourceId, o: job.orgId }).toEqual({ r: 'ayse', o: 'acme' });
  });

  it('a job with neither is the system\'s: unscoped storage, no user — unchanged', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {}, { id: 's1' });
    let seen: JobCtx | undefined;
    await createWorker(storage, { t: async (_p, ctx) => { seen = ctx; await ctx.journal.put(`${ctx.runId}:x`, 1); } }).drain();
    expect(seen?.caller).toEqual(UNKNOWN);
    expect(seen?.orgId).toBeUndefined();
    expect(seen?.storage).toBe(storage);
    expect(await storage.runs.get('job:s1:x')).toBe(1);
  });
});
