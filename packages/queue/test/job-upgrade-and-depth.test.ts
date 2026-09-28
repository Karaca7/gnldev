// R21: giving an existing system job an owner (an upgrade) must not double it.
// R22: `maxDepth` is counted per organization at O(min(depth, maxDepth)) pages — not by reading every
// other organization's backlog (measured before: 40 pages read for an organization with 0 jobs).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, purgeOrganizationWork, user } from '@gnldev/durable';
import { enqueue, createWorker, listJobs, moveJob, QueueDepthExceededError } from '../src/index.js';

describe('moving a pre-upgrade job to its owner', () => {
  it('the post-upgrade enqueue finds the moved job: one job, run once, as the owner', async () => {
    const storage = new InMemoryStorage();
    const work = storage.work!;
    await work.append('qjob', { type: 'report', payload: 1 }, 'weekly-report'); // what an older release wrote
    const moved = await moveJob(work, 'weekly-report', { orgId: 'acme' });
    const after = await enqueue(work, 'report', 1, { id: 'weekly-report', orgId: 'acme' });
    expect(after).toBe(moved);
    const ran: unknown[] = [];
    await createWorker(storage, { report: async (_p, ctx) => { ran.push([ctx.jobId, ctx.orgId]); } }).drain();
    expect(ran).toEqual([[moved, 'acme']]);
    const byId = Object.fromEntries((await listJobs(work)).map((j) => [j.id, j.status]));
    expect(byId).toEqual({ 'weekly-report': 'done', [moved!]: 'done' });
  });

  it('a job that had already finished stays finished under its owner — it does not run again', async () => {
    const storage = new InMemoryStorage();
    const work = storage.work!;
    await work.append('qjob', { type: 'report', payload: 1 }, 'weekly-report');
    let runs = 0;
    await createWorker(storage, { report: async () => { runs++; } }).drain();
    await moveJob(work, 'weekly-report', { caller: user('ayse', 'acme') });
    await enqueue(work, 'report', 1, { id: 'weekly-report', caller: user('ayse', 'acme') });
    await createWorker(storage, { report: async () => { runs++; } }).drain();
    expect(runs).toBe(1);
  });

  it('refuses an owned job, an ownerless target, and answers null for no such job', async () => {
    const work = new InMemoryStorage().work!;
    const owned = await enqueue(work, 'r', 1, { id: 'x', orgId: 'acme' });
    await expect(moveJob(work, owned, { orgId: 'globex' })).rejects.toThrow(/already has an owner/);
    await work.append('qjob', { type: 'r', payload: 1 }, 'old');
    await expect(moveJob(work, 'old', {})).rejects.toThrow(/needs an owner/);
    expect(await moveJob(work, 'missing', { orgId: 'acme' })).toBeNull();
  });
});

describe('maxDepth reads only the caller\'s own organization', () => {
  function counted(work: NonNullable<InMemoryStorage['work']>) {
    const c = { pages: 0 };
    const orig = work.list.bind(work);
    (work as { list: typeof work.list }).list = ((ns: string, q?: unknown) => { c.pages++; return orig(ns, q as never); }) as typeof work.list;
    return c;
  }

  it('an organization with no jobs pays one page, whatever another organization has queued', async () => {
    const work = new InMemoryStorage().work!;
    for (let i = 0; i < 500; i++) await enqueue(work, 'r', i, { orgId: 'globex' });
    const c = counted(work);
    await enqueue(work, 'r', 0, { orgId: 'acme', maxDepth: 5 });
    expect(c.pages).toBe(1);
  });

  it('an organization over its own limit stops after min(depth, maxDepth) records', async () => {
    const work = new InMemoryStorage().work!;
    for (let i = 0; i < 500; i++) await enqueue(work, 'r', i, { orgId: 'globex' });
    const c = counted(work);
    await expect(enqueue(work, 'r', 0, { orgId: 'globex', maxDepth: 5 })).rejects.toBeInstanceOf(QueueDepthExceededError);
    expect(c.pages).toBe(1);
  });

  it('system jobs are counted apart from every organization, and a repeat id is not counted twice', async () => {
    const work = new InMemoryStorage().work!;
    for (let i = 0; i < 3; i++) await enqueue(work, 'r', i, { orgId: 'acme' });
    await enqueue(work, 'r', 0, { id: 'n1', maxDepth: 2 });
    await enqueue(work, 'r', 0, { id: 'n1', maxDepth: 2 }); // idempotent: still one
    await enqueue(work, 'r', 0, { id: 'n2', maxDepth: 2 });
    await expect(enqueue(work, 'r', 0, { id: 'n3', maxDepth: 2 })).rejects.toBeInstanceOf(QueueDepthExceededError);
  });

  it('the depth index goes with the organization when it is purged', async () => {
    const work = new InMemoryStorage().work!;
    for (let i = 0; i < 3; i++) await enqueue(work, 'r', i, { orgId: 'acme' });
    await purgeOrganizationWork(work, 'acme');
    await expect(enqueue(work, 'r', 0, { orgId: 'acme', maxDepth: 3 })).resolves.toBeTruthy();
  });
});
