// Architecture probe (not product test): sibling scenarios for "a name belongs to its owner".
import { describe, it, expect } from 'vitest';
import { InMemoryStorage as DistMem } from '../dist/index.js';
import { InMemoryStorage, purgeResource, ownedName } from '../src/index.js';
import { enqueue, listJobs } from '../../queue/src/index.js';
import { emit, createConsumer } from '../../events/src/index.js';
import { scheduleWorkflow, listTriggers, pollScheduler } from '../../scheduler/src/index.js';

const log = (...a: unknown[]) => console.log('PROBE', ...a);
const tryIt = async (f: () => Promise<unknown>) => { try { return 'ok:' + JSON.stringify(await f()); } catch (e: any) { return 'THROW:' + (e?.name ?? '') + ':' + String(e?.message).slice(0, 60); } };

describe('zz-arch owned keyspace', () => {
  it('S1 queue: system id "acme:bob:x" vs acme/bob id "x" (ownedName ambiguity)', async () => {
    const work = new DistMem().work!;
    const a = await enqueue(work, 'report', { who: 'system' }, { id: 'acme:bob:x' });
    const b = await enqueue(work, 'report', { who: 'bob' }, { id: 'x', orgId: 'acme', resourceId: 'bob' });
    const jobs = await listJobs(work);
    log('S1 ids', a, b, 'jobs', JSON.stringify(jobs));
    expect(true).toBe(true);
  });

  it('S2 events: same collision + lone surrogate resourceId (ownedName uses encodeURIComponent)', async () => {
    const work = new DistMem().work!;
    const a = await emit(work, 't', { who: 'system' }, { id: 'acme:bob:e1' });
    const b = await emit(work, 't', { who: 'bob' }, { id: 'e1', orgId: 'acme', resourceId: 'bob' });
    const got: unknown[] = [];
    const c = createConsumer(work, 't', (p, meta) => { got.push({ p, meta }); }, { name: 'c1' });
    await c.poll();
    log('S2 ids', a, b, 'delivered', JSON.stringify(got));
    log('S2 surrogate emit w/o id', await tryIt(() => emit(work, 't', 1, { resourceId: 'u\uD800' })));
    log('S2 surrogate emit with id', await tryIt(() => emit(work, 't', 1, { id: 'k', resourceId: 'u\uD800' })));
    log('S2 surrogate enqueue with id', await tryIt(() => enqueue(work, 'r', 1, { id: 'k', resourceId: 'u\uD800' })));
    log('S2 ownedName direct', await tryIt(async () => ownedName('k', { resourceId: 'u\uD800' })));
  });

  it('S3 events: a system event whose payload carries the envelope key is read as owned', async () => {
    const work = new DistMem().work!;
    const userJson = { __gnlEventOwner: { orgId: 'globex', resourceId: 'victim' }, payload: { cmd: 'x' } };
    await emit(work, 'webhook', userJson); // system emit of caller-supplied JSON
    const got: unknown[] = [];
    await createConsumer(work, 'webhook', (p, meta) => { got.push({ p, meta }); }, { name: 'c' }).poll();
    log('S3 delivered', JSON.stringify(got));
  });

  it('S4 scheduler: upgrade adds orgId to an existing trigger (CHANGELOG item 3) -> second trigger', async () => {
    const j = new DistMem().runs;
    const now = 1_000_000;
    await scheduleWorkflow(j, { name: 'nightly', every: 1000 }, now); // pre-upgrade boot
    await scheduleWorkflow(j, { name: 'nightly', every: 1000, orgId: 'acme' }, now); // post-upgrade boot
    const t = await listTriggers(j);
    const fired: string[] = [];
    const runner = { runWorkflow: async (n: string, _i: unknown, o?: any) => { fired.push(`${n}:${o?.runId}`); return { runId: o?.runId ?? 'r' }; } };
    const r = await pollScheduler(j, runner, now + 5000, { runnerForOrg: () => runner });
    log('S4 triggers', t.map((x: any) => x.id).join(','), 'poll', JSON.stringify(r), 'fired', fired.join(','));
  });

  it('S5 queue: a pre-upgrade job id and the same caller after upgrade', async () => {
    const work = new DistMem().work!;
    // what 123aad2c wrote: work.append('qjob', {type,payload}, opts.id)
    await work.append('qjob', { type: 'report', payload: 1 }, 'weekly-report');
    const after = await enqueue(work, 'report', 1, { id: 'weekly-report', orgId: 'acme' });
    log('S5 after-id', after, 'jobs', (await listJobs(work)).map((j) => j.id).join(','));
  });

  it('S6 purgeResource prefix: resourceId "bob" vs "bob:evil" (server admits ":")', async () => {
    const j = new InMemoryStorage().runs;
    await j.put('xid:res:bob:send:h1', { v: 1 });
    await j.put('xid:res:bob:evil:send:h2', { v: 2 });
    await j.put('lesson:res:bob:evil:s1', { v: 3 });
    const n = await purgeResource(j, 'bob');
    log('S6 deleted', n, 'bob:evil xid left?', JSON.stringify(await j.get('xid:res:bob:evil:send:h2')), 'lesson left?', JSON.stringify(await j.get('lesson:res:bob:evil:s1')));
  });

  it('S8 scheduler handed an org-scoped journal (queue/events refuse the analogue)', async () => {
    const { withOrg } = await import('../dist/index.js');
    const root = new DistMem().runs;
    const scoped = withOrg(root, 'acme');
    const now = 1_000_000;
    log('S8 schedule on scoped', await tryIt(() => scheduleWorkflow(scoped, { name: 'n', every: 1000 }, now)));
    const fired: string[] = [];
    const runner = { runWorkflow: async (n: string, _i: unknown, o?: any) => { fired.push(n); return { runId: o?.runId ?? 'r' }; } };
    const r = await pollScheduler(root, runner, now + 5000, { runnerForOrg: () => runner });
    log('S8 root poll', JSON.stringify(r), 'root triggers', (await listTriggers(root)).length);
  });

  it('S9 per-org maxDepth cost: pages read when another org owns the log', async () => {
    const work = new DistMem().work!;
    for (let i = 0; i < 2000; i++) await enqueue(work, 'r', i, { orgId: 'globex' });
    let pages = 0;
    const orig = work.list.bind(work);
    (work as any).list = (ns: string, q?: any) => { pages++; return orig(ns, q); };
    await enqueue(work, 'r', 0, { orgId: 'acme', maxDepth: 5 });
    const acmePages = pages; pages = 0;
    await enqueue(work, 'r', 0, { maxDepth: 5, orgId: 'globex' }).catch(() => {});
    log('S9 pages read: acme(0 own jobs, maxDepth 5)=', acmePages, ' globex(2000 own)=', pages);
  });

  it('S7 maxDepth per org, not per user: one user fills the org queue', async () => {
    const work = new DistMem().work!;
    for (let i = 0; i < 3; i++) await enqueue(work, 'r', i, { orgId: 'acme', resourceId: 'mallory', maxDepth: 3 });
    log('S7 alice after mallory', await tryIt(() => enqueue(work, 'r', 0, { orgId: 'acme', resourceId: 'alice', maxDepth: 3 })));
    log('S7 globex', await tryIt(() => enqueue(work, 'r', 0, { orgId: 'globex', maxDepth: 3 })));
    log('S7 system', await tryIt(() => enqueue(work, 'r', 0, { maxDepth: 3 })));
  });
});
