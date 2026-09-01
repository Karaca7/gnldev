// Queue/Jobs: POST /jobs/:id/retry — re-queues a failed (dead-letter) job via queue.retry (the
// host typically bridges this to @gnldev/queue's retryJob — see packages/queue/src/index.ts
// retryJob). Studio itself has NO dependency on @gnldev/queue (bridged via the StudioQueue
// interface) — here we mock queue.retry and verify it's CALLED, plus permission (write) +
// audit + no-op (double-run protection) behavior.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, type StudioJob, type StudioQueue } from '../src/server.js';
import { call } from './call.js';

/** Simple fake queue: id → status. retry only produces a new id for 'failed' jobs (mimics the
 *  real @gnldev/queue retryJob's no-op/double-run-protection semantics). */
function fakeQueue(jobs: StudioJob[]): StudioQueue & { retryCalls: string[] } {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const retryCalls: string[] = [];
  return {
    retryCalls,
    listJobs: () => [...byId.values()],
    retry: async (id: string) => {
      retryCalls.push(id);
      const job = byId.get(id);
      if (!job || job.status !== 'failed') return null; // not found or not terminal-failed → no-op
      const newId = `${id}-retry`;
      byId.set(newId, { id: newId, type: job.type, status: 'pending', attempts: 0 });
      return newId;
    },
  };
}

const post = (app: any, path: string, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

describe('POST /jobs/:id/retry', () => {
  it('re-queues a failed job via queue.retry (enqueue was called), lands in audit', async () => {
    const queue = fakeQueue([{ id: 'j1', type: 'refund', status: 'failed', attempts: 5 }]);
    const app = createStudioApi({ reader: new InMemoryJournal(), queue });

    const res = await post(app, '/jobs/j1/retry', { 'x-gnl-actor': 'ops@acme.co' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, id: 'j1-retry' });
    expect(queue.retryCalls).toEqual(['j1']); // queue.retry (→ @gnldev/queue enqueue in the real world) was called EXACTLY ONCE

    // the new job appears in the queue, the old one (dead-letter) still stands (append-only — not deleted)
    const jobs = await (await call(app, '/jobs')).json();
    expect(jobs.find((j: StudioJob) => j.id === 'j1')?.status).toBe('failed');
    expect(jobs.find((j: StudioJob) => j.id === 'j1-retry')?.status).toBe('pending');

    // audit: job.retry, actor + the new id in detail
    const audit = await (await call(app, '/audit?action=job.retry')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'j1', detail: { newId: 'j1-retry' } });
  });

  it('403 without write permission (queue.retry is never called)', async () => {
    const queue = fakeQueue([{ id: 'j1', type: 'refund', status: 'failed', attempts: 5 }]);
    const app = createStudioApi({ reader: new InMemoryJournal(), queue, auth: { write: () => false } });

    const res = await post(app, '/jobs/j1/retry');
    expect(res.status).toBe(403);
    expect(queue.retryCalls).toHaveLength(0);
  });

  it('a pending/done job or a nonexistent id → 409 no-op (double-run is prevented)', async () => {
    const queue = fakeQueue([
      { id: 'pending-1', type: 'refund', status: 'pending', attempts: 1 },
      { id: 'done-1', type: 'refund', status: 'done', attempts: 1 },
    ]);
    const app = createStudioApi({ reader: new InMemoryJournal(), queue });

    for (const id of ['pending-1', 'done-1', 'no-such-job']) {
      const res = await post(app, `/jobs/${id}/retry`);
      expect(res.status).toBe(409);
    }
    // no new job was opened for any of them
    const audit = await (await call(app, '/audit?action=job.retry')).json();
    expect(audit.items).toHaveLength(0);
  });

  it('501 if queue.retry is not implemented (listJobs only)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), queue: { listJobs: () => [] } });
    const res = await post(app, '/jobs/j1/retry');
    expect(res.status).toBe(501);
  });

  it('501 also if queue is not given at all (feature check comes AFTER the write permission check)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await post(app, '/jobs/j1/retry');
    expect(res.status).toBe(501);
  });
});

/**
 * GET /jobs is PROJECTED through an allowlist, not forwarded.
 *
 * The shipped bridge is safe by accident: the real `@gnldev/queue.listJobs` builds a summary with
 * exactly the four `StudioJob` fields and leaves the job's payload and error text in the store. But
 * `StudioQueue` is a HOST duck-type, so "safe" was a property of somebody else's object — a host that
 * maps its own rows (the obvious way to bridge a queue that is NOT @gnldev/queue) forwards whatever
 * those rows carry to a `catalog:read`-only caller.
 *
 * Untested until now: widening `JOB_FIELDS` with the host's own field names left the suite green.
 */
describe('GET /jobs', () => {
  it('copies the four StudioJob fields and nothing else the host attached', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      queue: {
        listJobs: () => [{
          id: 'j1', type: 'refund', status: 'failed', attempts: 5,
          // A hand-rolled bridge's own row: the argument the job was enqueued with, and the text the
          // worker wrote about it.
          payload: { customerEmail: 'jane@customer.example', ssn: '123-45-6789' },
          lastError: "ValidationError: ssn '123-45-6789' invalid",
          workerHost: 'worker-3.internal',
        }] as never,
      },
      auth: {
        authenticate: () => ({ id: 'support', roles: ['viewer'], permissions: ['catalog:read'] }),
        authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string }) =>
          ((p?.permissions ?? []).includes(ctx.permission ?? '')
            ? { allow: true } : { allow: false as const, status: 403 as const, reason: 'no' }),
        capabilities: () => ({ rbac: true }),
      } as never,
    });

    const res = await call(app, '/jobs');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, 'the job argument reached a grant whose own description promises no customer data').not.toContain('123-45-6789');
    expect(text).not.toContain('worker-3.internal');
    expect(await JSON.parse(text)).toEqual([{ id: 'j1', type: 'refund', status: 'failed', attempts: 5 }]);
  });

  it('drops a field the host simply did not set, rather than sending `undefined`', async () => {
    // `pickFields` skips `undefined`, so a partial host row stays a partial row instead of gaining
    // four null-ish keys the UI would then render as columns.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      queue: { listJobs: () => [{ id: 'j1', status: 'pending' }] as never },
    });
    expect(await (await call(app, '/jobs')).json()).toEqual([{ id: 'j1', status: 'pending' }]);
  });
});
