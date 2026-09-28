// R20: ONE erasure removes a person's runs, threads, documents, queued jobs, triggers and events —
// and every marker and lock those leave behind. Measured before (eraseSubject on adr2/core): the job's
// `qfail` (holding the handler's error text), `qatt` and `qown` markers and the worker's lease lock in
// the root journal survived; so did a consumer's dead-letter record for the person's event.
//
// The seam: durable cannot import the background packages, so each hands in its own eraser
// (`jobEraser`, `triggerEraser`, `eventEraser`); durable erases what it owns (runs, threads, documents)
// and every owned log record by the owner's id prefix.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, scopeConfigToOrg, eraseSubject, toJournal, withOrgStorage, runOwnerOf } from '../src/index.js';
import { indexDocuments } from '../../rag/src/index.js';
import { enqueue, createWorker, listJobs, jobEraser } from '../../queue/src/index.js';
import { emit, createConsumer, eventEraser } from '../../events/src/index.js';
import { scheduleWorkflow, pollScheduler, listTriggers, triggerEraser } from '../../scheduler/src/index.js';
import { workflow, step } from '../../workflow/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const model = () => createMockModel(async () => finalTextResult('ok'));

async function world(orgs: Array<string | undefined>) {
  const storage = new InMemoryStorage();
  const root = toJournal(storage.runs);
  const work = storage.work!;
  const vectors = storage.vectors!;
  const wf = workflow<{ who: string }>().then(step('s', async (i) => ({ text: `WF-${i.who}` })));
  const config = { storage, workflows: { weekly: wf } };
  const gnlFor = (org: string) => createGnl(scopeConfigToOrg(config, org).config);
  const people: Array<{ who: string; orgId?: string }> = [];
  for (const orgId of orgs) for (const who of ['ayse', 'bora']) people.push({ who, ...(orgId ? { orgId } : {}) });
  // An organization's documents sit in its namespace, under its ids — written through withOrgStorage.
  for (const [i, p] of people.entries()) {
    await indexDocuments((p.orgId ? withOrgStorage(storage, p.orgId) : storage).vectors!, async () => [1, 0], [{ id: `d${i}`, text: `DOC-${p.who}-${p.orgId ?? '-'}`, owner: p.who }]);
  }
  for (const p of people) {
    const tag = `${p.who}-${p.orgId ?? '-'}`;
    await enqueue(work, 'weekly', { note: `JOB-${tag}` }, { resourceId: p.who, ...(p.orgId ? { orgId: p.orgId } : {}) });
    await emit(work, 'audit', { note: `EVT-${tag}` }, { resourceId: p.who, ...(p.orgId ? { orgId: p.orgId } : {}) });
    await scheduleWorkflow(root, { id: 'weekly', name: 'weekly', input: { who: tag }, at: 0, resourceId: p.who, ...(p.orgId ? { orgId: p.orgId } : {}) }, 0);
  }
  // The job runs as its owner, then fails once with an error that names the person (a qfail record).
  await createWorker(storage, {
    weekly: async (p, ctx) => { await ctx.run({ model: model(), prompt: `JOBRUN-${(p as { note: string }).note}` }); throw new Error(`FAIL-${(p as { note: string }).note}`); },
  }, { maxAttempts: 1 }).drain();
  // A consumer that dead-letters every event (a record holding the error text), and one that acks.
  await createConsumer(work, 'audit', (p) => { throw new Error(`DEAD-${(p as { note: string }).note}`); }, { name: 'bad', maxAttempts: 1 }).poll();
  await createConsumer(work, 'audit', () => {}, { name: 'ok' }).poll();
  await pollScheduler(root, createGnl(config), 1, { runnerForOrg: gnlFor });
  return { storage, root, work, vectors };
}

async function everything(storage: InMemoryStorage, vectors: NonNullable<InMemoryStorage['vectors']>): Promise<string> {
  const keys = await storage.runs.listKeys('');
  const values = await Promise.all(keys.map(async (k) => `${k}=${JSON.stringify(await storage.runs.get(k))}`));
  const jobs = await listJobs(storage.work!);
  const kv: string[] = [];
  for (const j of jobs) for (const m of ['qdone', 'qfail', 'qatt', 'qown']) kv.push(`${m}:${j.id}=${JSON.stringify(await storage.work!.get(`${m}:${j.id}`))}`);
  const events: string[] = [];
  await createConsumer(storage.work!, 'audit', (p) => { events.push(JSON.stringify(p)); }, { name: `probe-${Math.random()}` }).poll();
  const docs = (await vectors.query([1, 0], 100)).map((m) => m.text);
  const triggers = (await listTriggers(toJournal(storage.runs))).map((t) => `${t.id}:${JSON.stringify(t.input)}`);
  return [...values, ...jobs.map((j) => JSON.stringify(j)), ...kv, ...events, ...docs, ...triggers].join('\n');
}

describe('eraseSubject with the background erasers', () => {
  it('a person in an organization: nothing that names them survives, anywhere', async () => {
    const { storage, root, work, vectors } = await world(['acme', 'globex']);
    const before = await everything(storage, vectors);
    expect(before).toContain('ayse-acme');
    const report = await eraseSubject(storage, 'ayse', { orgId: 'acme', erasers: [jobEraser(storage), triggerEraser(root), eventEraser(work)] });
    expect(report.byEraser.jobs).toBeGreaterThan(0);
    expect(report.byEraser.triggers).toBeGreaterThan(0);
    expect(report.byEraser.events).toBeGreaterThan(0);
    const after = await everything(storage, vectors);
    // Nothing of hers in acme: no payload, no error text, no run, no key that names her.
    expect(after).not.toContain('ayse-acme');
    expect(after.split("\n").filter((l) => l.includes("~o~acme:ayse:"))).toEqual([]);
    // Everyone else is intact: bora in acme, and the other ayse — in globex, a different person.
    for (const other of ['JOB-bora-acme', 'EVT-bora-acme', 'WF-bora-acme', 'DOC-bora-acme', 'JOB-ayse-globex', 'EVT-ayse-globex', 'WF-ayse-globex', 'DOC-ayse-globex', 'FAIL-JOB-bora-acme']) {
      expect(after, other).toContain(other);
    }
  });

  it('a person with no organization: the same, and organization members of the same id are untouched', async () => {
    const { storage, root, work, vectors } = await world([undefined, 'acme']);
    await eraseSubject(storage, 'ayse', { erasers: [jobEraser(storage), triggerEraser(root), eventEraser(work)] });
    const after = await everything(storage, vectors);
    expect(after).not.toContain('ayse--');
    expect(after.split("\n").filter((l) => l.includes("~o~:ayse:"))).toEqual([]);
    for (const other of ['JOB-bora--', 'EVT-bora--', 'WF-bora--', 'JOB-ayse-acme', 'EVT-ayse-acme', 'WF-ayse-acme', 'JOBRUN-JOB-ayse-acme']) expect(after, other).toContain(other);
  });

  it('the job run erased is the one the worker recorded as hers (ctx.run), found by its owner record', async () => {
    const { storage, root, work, vectors } = await world(['acme']);
    const job = (await listJobs(work)).find((j) => j.resourceId === 'ayse')!;
    const acme = toJournal(withOrgStorage(storage, 'acme').runs);
    expect((await runOwnerOf(acme, `job:${job.id}`)).state).toBe('owned');
    await eraseSubject(storage, 'ayse', { orgId: 'acme', erasers: [jobEraser(storage)] });
    expect((await runOwnerOf(acme, `job:${job.id}`)).state).toBe('missing');
  });

  it('a store that cannot delete makes the eraser refuse, instead of reporting a partial erasure', async () => {
    const storage = new InMemoryStorage();
    const work = storage.work!;
    const blind = { ...storage, work: { ...work, append: work.append.bind(work), list: work.list.bind(work), get: work.get.bind(work), put: work.put.bind(work), ackOnce: work.ackOnce.bind(work), deleteIdPrefix: undefined, deletePrefix: undefined } };
    await expect(jobEraser(blind as never).erase({ resourceId: 'ayse' })).rejects.toThrow(/cannot be erased/);
    await expect(eventEraser(blind.work as never).erase({ resourceId: 'ayse' })).rejects.toThrow(/cannot be erased/);
  });
});
