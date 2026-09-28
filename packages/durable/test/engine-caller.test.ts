// ADR-0002 point 4: the engine's gates take the Caller EXPLICITLY — thread admission, run admission,
// cross-run dedup — and refuse an end user on an ownerless record themselves, instead of trusting a
// server gate that a standalone door (chat-adapter, agui, a direct `gnl.run`) does not have. A direct
// call that names nobody is `unknown`, which is closed (R5).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { InMemoryStorage, BasicMemory, forkRun, toJournal } from '../src/index.js';
import { admitThreadRun } from '../src/thread-owner.js';
import { runOwnerOf, user, STAFF, UNKNOWN } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];
async function kb() {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'ayse-invoice', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'mehmet-invoice', text: 'MEHMET invoice', owner: 'mehmet' },
  ]);
  return store;
}
const text = (t: string) => createMockModel(async () => finalTextResult(t));

describe('R5: resuming through the engine directly', () => {
  async function suspendedRun() {
    const storage = new InMemoryStorage();
    const seen = { text: '' };
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
      seen.text = JSON.stringify(prompt); return finalTextResult('done');
    });
    const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model, tools: { kb: createRagTool({ store: await kb(), embed, topK: 10 }) }, guard: async () => ({ action: 'require-approval' }), maxSteps: 4 } } } as never);
    const r1: any = await gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'ayse' });
    expect(r1.interrupts.length).toBe(1);
    return { gnl, storage, seen };
  }

  it('another user is refused; nothing of hers reaches him', async () => {
    const { gnl, seen } = await suspendedRun();
    await expect(gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'mallory', approvals: { c1: true } })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    expect(seen.text).toBe('');
  });

  it('a call that names nobody is unknown — refused, never "whoever the run says"', async () => {
    const { gnl } = await suspendedRun();
    await expect(gnl.run('a', { runId: 'r-s8', prompt: 'x', approvals: { c1: true } })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
  });

  it('staff may resume it, and it runs as its RECORDED owner', async () => {
    const { gnl, seen } = await suspendedRun();
    await gnl.run('a', { runId: 'r-s8', prompt: 'x', caller: STAFF, approvals: { c1: true } });
    expect(seen.text).toContain('AYSE invoice');
    expect(seen.text).not.toContain('MEHMET invoice');
  });

  it('resumeRun takes the caller the same way', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCallResult('pay', 'c1', {}) : finalTextResult('paid')));
    const pay = tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'ok' });
    const guard = async () => ({ action: 'require-approval' as const });
    await runDurable({ runId: 'rr', journal, model, tools: { pay }, guard, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await expect(resumeRun('rr', { journal, model, tools: { pay }, guard, approvals: { c1: true } } as never)).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    await expect(resumeRun('rr', { journal, model, tools: { pay }, guard, approvals: { c1: true }, resourceId: 'mallory' } as never)).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    const done = await resumeRun('rr', { journal, model, tools: { pay }, guard, approvals: { c1: true }, caller: user('ayse') } as never);
    expect(done.text).toBe('paid');
  });
});

describe('the engine refuses an end user on an ownerless record (SECRET-2, standalone doors)', () => {
  it('admitThreadRun: a thread staff claimed is refused to a user and to unknown, by the engine', async () => {
    const j = new InMemoryJournal();
    await admitThreadRun(j, undefined, 't', STAFF);
    await expect(admitThreadRun(j, undefined, 't', user('mallory'))).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
    await expect(admitThreadRun(j, undefined, 't', UNKNOWN)).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
    await expect(admitThreadRun(j, undefined, 't', STAFF)).resolves.toBeTruthy();
  });

  it('a new run on a staff thread, from the engine (as a standalone chat door would call it): refused, history unseen', async () => {
    const storage = new InMemoryStorage();
    const seen: string[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(JSON.stringify(prompt)); return finalTextResult('ok'); });
    const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model } } } as never);
    await gnl.run('a', { runId: 's1', prompt: 'SECRET-2', threadId: 'T', caller: STAFF });
    seen.length = 0;
    await expect(gnl.run('a', { runId: 'm1', prompt: 'hi', threadId: 'T', resourceId: 'u-mallory' })).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
    expect(seen.join('')).not.toContain('SECRET-2');
  });

  it('a staff run is refused to a user who names its runId (run admission)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'ops', journal, model: text('STAFF-SECRET'), prompt: 'x', caller: STAFF });
    await expect(runDurable({ runId: 'ops', journal, model: text('mine'), prompt: 'y', resourceId: 'mallory' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    expect(await runOwnerOf(journal, 'ops')).toMatchObject({ owner: { kind: 'staff' } });
  });

  it('a run whose record is gone but whose rows remain (legacy) is refused to a user and to unknown', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'legacy', journal, model: text('STAFF-SECRET'), prompt: 'x', caller: STAFF });
    await journal.deletePrefix('legacy:input');
    for (const who of [{ resourceId: 'mallory' }, {}]) {
      await expect(runDurable({ runId: 'legacy', journal, model: text('mine'), prompt: 'y', ...who })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    }
    expect(await journal.get('legacy:input')).toBeUndefined();
  });

  it('an unreadable owner record refuses the run and writes nothing', async () => {
    const inner = new InMemoryJournal();
    await runDurable({ runId: 'r', journal: inner, model: text('AYSE'), prompt: 'x', resourceId: 'ayse' });
    const before = await inner.listKeys('r:');
    const broken = new Proxy(inner, { get(t, p) {
      if (p === 'get') return async (k: string) => { if (k === 'r:input') throw new Error('EIO (injected)'); return t.get(k); };
      const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v;
    } });
    await expect(runDurable({ runId: 'r', journal: broken, model: text('x'), prompt: 'x', resourceId: 'ayse' })).rejects.toThrow(/EIO/);
    expect(await inner.listKeys('r:')).toEqual(before);
  });
});

describe('forkRun writes the owner FIRST (crash between row copy and :input)', () => {
  async function crashedFork(starter: { resourceId: string } | { caller: typeof STAFF }) {
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs) as any;
    await runDurable({ runId: 'src', journal: j, model: text('SECRET-OF-AYSE'), prompt: 'hi', ...starter });
    const crashing = new Proxy(j, { get(t, k) {
      if (k === 'put') return async (key: string, v: unknown) => { if (key.endsWith(':input')) throw new Error('crash (injected)'); return t.put(key, v); };
      const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v;
    } });
    await expect(forkRun(crashing, 'src', 1, 'fk')).rejects.toThrow(/crash/);
    expect(await j.get('fk:model:0')).toBeDefined(); // the rows were copied before the crash
    return j;
  }

  for (const [name, starter, owner] of [['a user\'s', { resourceId: 'u-ayse' }, 'u-ayse'], ['a staff', { caller: STAFF }, undefined]] as const) {
    it(`${name} source: the half-written fork is still its owner's; another user cannot take it`, async () => {
      const j = await crashedFork(starter as never);
      expect(await runOwnerOf(j, 'fk')).toMatchObject({ state: 'owned', owner: owner ? { kind: 'user', id: owner } : { kind: 'staff' } });
      await expect(runDurable({ runId: 'fk', journal: j, model: text('mine now'), prompt: 'mine now', resourceId: 'u-mallory' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
      expect((await j.get('fk:input'))?.resourceId).toBe(owner);
    });
  }

  it('sibling: a fork of a run that does not exist is refused, not born ownerless', async () => {
    const j = toJournal(new InMemoryStorage().runs) as any;
    await expect(forkRun(j, 'nope', 0, 'fk2')).rejects.toThrow(/does not exist/);
    expect(await j.get('fk2:input')).toBeUndefined();
  });
});

describe('cross-run dedup takes the caller explicitly (the same rule as run access)', () => {
  const lookupTool = (calls: string[]) => Object.assign(tool({ description: 'l', inputSchema: z.object({ orderId: z.string() }), execute: async ({ orderId }) => { calls.push(orderId); return { address: `ADDR-${orderId}` }; } }),
    { idempotency: 'args' as const, idempotencyWindow: 'cross-run' as const });
  const run = (journal: InMemoryJournal, runId: string, calls: string[], who: object) => runDurable({
    runId, journal, prompt: 'x', stopWhen: stepCountIs(4), tools: { lookup: lookupTool(calls) }, ...who,
    model: createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCallResult('lookup', `c-${runId}`, { orderId: 'O1' }) : finalTextResult(JSON.stringify(prompt)))),
  });

  it('a user reuses her own record; another user and unknown are refused; staff reach it', async () => {
    const journal = new InMemoryJournal();
    const calls: string[] = [];
    await run(journal, 'a1', calls, { resourceId: 'ayse' });
    expect((await run(journal, 'a2', calls, { resourceId: 'ayse' })).text).toContain('ADDR-O1');
    expect((await run(journal, 'm1', calls, { resourceId: 'mallory' })).text).not.toContain('ADDR-O1');
    expect((await run(journal, 'u1', calls, {})).text).not.toContain('ADDR-O1');
    expect((await run(journal, 's1', calls, { caller: STAFF })).text).toContain('ADDR-O1');
    expect(calls).toEqual(['O1']);
  });
});

describe('a direct call is explicit about its caller', () => {
  it('both `caller` and a different `resourceId` is refused (one caller per call)', async () => {
    await expect(runDurable({ runId: 'x', journal: new InMemoryJournal(), model: text('x'), prompt: 'x', caller: user('ayse'), resourceId: 'mallory' })).rejects.toThrow(/one caller/);
  });

  it('an agent run records who it acts for before its first row (a crash after birth leaves an owner)', async () => {
    const journal = new InMemoryJournal();
    const failing = createMockModel(async () => { throw new Error('upstream 500'); });
    await expect(runDurable({ runId: 'b', journal, model: failing, prompt: 'x', resourceId: 'ayse' })).rejects.toThrow();
    expect(await runOwnerOf(journal, 'b')).toMatchObject({ state: 'owned', owner: { kind: 'user', id: 'ayse' } });
    await expect(runDurable({ runId: 'b', journal, model: text('mine'), prompt: 'x', resourceId: 'mallory' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    // …and its owner's retry is a first run again.
    expect((await runDurable({ runId: 'b', journal, model: text('ok'), prompt: 'x', resourceId: 'ayse' })).text).toBe('ok');
    expect(await journal.get(runKeys.input('b'))).toMatchObject({ prompt: 'x', resourceId: 'ayse' });
  });
});
