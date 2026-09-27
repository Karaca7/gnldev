// Candidate B acceptance probes: the kit's scenarios (zz-arch-*.test.ts) rewritten against the
// explicit, typed identity API (`ctx.identity`, `options.gnl`, `principal`) and turned into assertions.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { createBatch } from '../src/batch.js';
import { InMemoryStorage, BasicMemory, withSubjectJournal, eraseSubject, toJournal } from '../src/index.js';
import { gnlOf, userIdOf, toolContextFor, runOwnerOf, STAFF, type RunIdentity } from '../src/run-identity.js';
import { AgentMemory } from '../../memory/src/index.js';
import { enqueue, listJobs } from '../../queue/src/index.js';
import { emit, createConsumer } from '../../events/src/index.js';
import { scheduleWorkflow, listTriggers } from '../../scheduler/src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];
async function kb() {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'handbook', text: 'GENERAL handbook', shared: true },
    { id: 'ayse-invoice', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'mehmet-invoice', text: 'MEHMET invoice', owner: 'mehmet' },
  ]);
  return store;
}
const J = (v: unknown) => JSON.stringify(v);

describe('R1–R6: identity reaches code', () => {
  it('R1 a workflow step forwards ctx.identity to a tool: the user, not the whole shelf', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let fwd = ''; let forgot = '';
    const wf = workflow<any>().then(step('lookup', async (_i: any, ctx: StepCtx) => {
      fwd = J(await rag.execute!({ query: 'invoice' }, { toolCallId: 's', messages: [], gnl: toolContextFor(ctx.identity as RunIdentity) } as never));
      forgot = J(await rag.execute!({ query: 'invoice' }, { toolCallId: 's2', messages: [] }));
      return { ok: true };
    }));
    const gnl = createGnl({ journal: new InMemoryJournal(), workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-s1', resourceId: 'ayse' } as never);
    expect(fwd).toContain('AYSE invoice');
    expect(fwd).not.toContain('MEHMET invoice');
    expect(forgot, 'a step that forgets the identity is closed').not.toContain('MEHMET invoice');
    expect(forgot).not.toContain('AYSE invoice');
  });

  it('R2 agent-as-workflow-step: runDurable({ principal: ctx.identity }) runs as the user and is born owned', async () => {
    const journal = new InMemoryJournal();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    const wf = workflow<any>().then(step('agent', async (_i: any, ctx: StepCtx) => {
      const model = createMockModel(async ({ prompt }: any) => {
        if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
        seen = J(prompt); return finalTextResult('done');
      });
      await runDurable({ runId: `${ctx.runId}:agent`, journal: ctx.journal as never, model, tools: { kb: rag }, prompt: 'x', stopWhen: stepCountIs(4), principal: ctx.identity as RunIdentity });
      return { ok: true };
    }));
    await createGnl({ journal, workflows: { w: wf } } as never).runWorkflow!('w', {}, { runId: 'wf-s2', resourceId: 'ayse' } as never);
    expect(seen).toContain('AYSE invoice');
    expect(seen).not.toContain('MEHMET invoice');
    expect((await journal.get<{ resourceId?: string }>('wf-s2:agent:input'))?.resourceId).toBe('ayse');
  });

  it('R3 withIdempotency: owner record and tool identity are one value; mallory is refused ayse\'s result', async () => {
    const journal = new InMemoryJournal();
    let runs = 0; const sawAs: Array<string | undefined> = [];
    const tools = withIdempotency({
      address: tool({ description: 'd', inputSchema: z.object({ orderId: z.string() }), execute: async ({ orderId }, o) => { runs++; sawAs.push(userIdOf(gnlOf(o))); return { orderId, address: `addr-of-${userIdOf(gnlOf(o))}` }; } }),
    }, { journal });
    const as = (who: string) => ({ toolCallId: who, messages: [], gnl: toolContextFor({ kind: 'user', resourceId: who, runId: `r-${who}` }) });
    const a = await tools.address.execute!({ orderId: 'o1' }, as('ayse') as never);
    let b: unknown; let err: any;
    try { b = await tools.address.execute!({ orderId: 'o1' }, as('mallory') as never); } catch (e) { err = e; }
    const ownerKey = (await journal.listKeys('xrun:')).find((k) => k.startsWith('xrun:owner'))!;
    expect(J(a)).toContain('addr-of-ayse');
    expect(b).toBeUndefined();
    expect(err?.name).toBe('IdempotencyOwnerMismatchError');
    expect(runs).toBe(1);
    expect(sawAs).toEqual(['ayse']);
    expect((await journal.get<{ resourceId?: string }>(ownerKey))?.resourceId).toBe('ayse');
  });

  it('R4 a tool composing another: forwarding options → the user; forgetting → closed (general shelf only)', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let fwd = ''; let forgot = '';
    const outer = Object.assign(tool({ description: 'd', inputSchema: z.object({ q: z.string() }), execute: async ({ q }, o) => {
      fwd = J(await rag.execute!({ query: q }, o));
      forgot = J(await rag.execute!({ query: q }, { toolCallId: o.toolCallId, messages: [] }));
      return 'ok';
    } }), { idempotent: true });
    const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('outer', 'c1', { q: 'invoice' }) : finalTextResult('done'));
    await runDurable({ runId: 'r5', journal: new InMemoryJournal(), model, tools: { outer }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(fwd).toContain('AYSE invoice');
    expect(fwd).not.toContain('MEHMET invoice');
    expect(forgot).not.toContain('MEHMET invoice');
    expect(forgot).toContain('GENERAL handbook');
  });

  it('R4b batch: the tool sees the batch principal', async () => {
    const got: unknown[] = [];
    const t = Object.assign(tool({ description: 'd', inputSchema: z.object({ id: z.string() }), execute: async (i, o) => { got.push(userIdOf(gnlOf(o))); return { ok: i.id }; } }), { idempotent: true });
    const journal = new InMemoryJournal();
    const b = createBatch(journal, { tool: t as never, toolName: 'echo', itemKey: (i: any) => i.id, resourceId: 'ayse', onDuplicate: 'skip' });
    const plan = await b.preflight('b1', [{ id: 'x' }]);
    await b.run('b1', [{ id: 'x' }], { planToken: plan.token });
    expect(got).toEqual(['ayse']);
  });

  it('R5 resuming ayse\'s suspended run through the engine as mallory is refused', async () => {
    const storage = new InMemoryStorage();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
      seen = J(prompt); return finalTextResult('done');
    });
    const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model, tools: { kb: rag }, guard: async () => ({ action: 'require-approval' }), maxSteps: 4 } } } as never);
    const r1: any = await gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'ayse' });
    expect(r1.interrupts.length).toBe(1);
    await expect(gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'mallory', approvals: { c1: true } })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    // …and staff resuming it runs as the RECORDED owner.
    await gnl.run('a', { runId: 'r-s8', prompt: 'x', principal: STAFF, approvals: { c1: true } });
    expect(seen).toContain('AYSE invoice');
    expect(seen).not.toContain('MEHMET invoice');
  });

  it('R6 unknown is closed: no principal on an owned thread is refused; a lost identity reads the general shelf', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async () => finalTextResult('ok'));
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'u1', journal, model, prompt: 'x', threadId: 't', memory, resourceId: 'ayse' });
    await expect(runDurable({ runId: 'u2', journal, model, prompt: 'x', threadId: 't', memory })).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    const out = J(await rag.execute!({ query: 'invoice' }, { toolCallId: 'x', messages: [] }));
    expect(out).toContain('GENERAL handbook');
    expect(out).not.toContain('AYSE invoice');
  });
});

describe('R9/R10: the view', () => {
  it('R9 a decision refuses the view at runtime', async () => {
    const j = new InMemoryJournal();
    await j.put('r:input', { resourceId: 'u' });
    const v = withSubjectJournal(j, 'u');
    await expect(runOwnerOf(v as never, 'r')).rejects.toThrow(/VIEW/);
    expect((await runOwnerOf(j, 'r')).exists).toBe(true);
  });

  it('R10 listKeys over 401 keys of one run costs one owner read', async () => {
    const base = new InMemoryJournal();
    await base.put('run-1:input', { resourceId: 'u' });
    for (let i = 0; i < 400; i++) await base.put(`run-1:tool:c${i}:args`, { i });
    let gets = 0;
    const counted = new Proxy(base as any, { get(t, p) { if (p === 'get') return async (k: string) => { gets++; return t.get(k); }; const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
    const keys = await withSubjectJournal(counted, 'u').listKeys!('run-1:');
    expect(keys.length).toBe(401);
    expect(gets).toBeLessThanOrEqual(2);
  });
});

describe('R11–R14: thread ownership', () => {
  for (const kind of ['basic', 'agent'] as const) {
    it(`R11 an anonymous first turn does not pin the thread ownerless (${kind})`, async () => {
      const storage = new InMemoryStorage();
      const seen: string[] = [];
      const model = createMockModel(async ({ prompt }: any) => { seen.push(J(prompt)); return finalTextResult('ok'); });
      const memory = kind === 'basic' ? new BasicMemory(storage.runs) : new AgentMemory({ storage: storage as never });
      const gnl = createGnl({ storage, memory, agents: { a: { model } } } as never);
      await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 't' });
      await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
      seen.length = 0;
      await expect(gnl.run('a', { runId: 'r2', prompt: 'what?', threadId: 't', resourceId: 'mallory' })).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
      expect(seen.join('')).not.toContain('4417');
      expect((await toJournal(storage.runs).get<{ resourceId?: string }>('thread:t:owner'))?.resourceId).toBe('ayse');
    });
  }
});

describe('R15/R16/R20: owner in the name, one erasure', () => {
  it('R15 a system event whose payload carries an owner envelope is delivered as the system\'s', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 'webhook', { __gnlEventOwner: { orgId: 'globex', resourceId: 'victim' }, payload: { cmd: 'x' } });
    const got: any[] = [];
    await createConsumer(work, 'webhook', (p, meta) => { got.push({ p, meta }); }, { name: 'c' }).poll();
    expect(got[0].meta.resourceId).toBeUndefined();
    expect(got[0].meta.orgId).toBeUndefined();
  });

  it('R16 a system id cannot collide with an owned one, and a lone surrogate does not throw', async () => {
    const work = new InMemoryStorage().work!;
    const a = await enqueue(work, 'report', {}, { id: 'acme:bob:x' });
    const b = await enqueue(work, 'report', {}, { id: 'x', orgId: 'acme', resourceId: 'bob' });
    expect(a).not.toBe(b);
    await expect(enqueue(work, 'r', 1, { id: 'k', resourceId: 'u\uD800' })).resolves.toBeTypeOf('string');
    await expect(enqueue(work, 'r', 1, { id: b })).rejects.toThrow(/reserved/);
  });

  it('R20 eraseSubject removes a person\'s runs, threads, documents, jobs, triggers and events', async () => {
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
