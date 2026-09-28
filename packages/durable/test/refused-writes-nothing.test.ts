// A caller the engine has not admitted writes NOTHING under the run it asked for.
//
// Found by the conformance registry (packages/server/test/ownership-matrix*.test.ts): with the target
// run's owner record unreadable, another user's `runDurable` on that id rejected with the store's error
// (correct) and then wrote the run's `:outcome` as `failed` (wrong) — ~250 cells, through the engine,
// a queue worker and an events consumer. The outer catch of `runDurable` recorded every failure, even
// one thrown before the engine knew whose run it was. An unreadable owner is not permission, and the
// outcome record belongs to the admitted run only.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { user, STAFF, type Caller } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

const AYSE = user('ayse');
const MALLORY = user('mallory');
const ok = () => createMockModel(async () => finalTextResult('ok'));

/** A journal whose reads of the listed keys fail, as a store that is down would. */
function failing(j: InMemoryJournal, keys: string[]) {
  return new Proxy(j, {
    get(t, p) {
      if (p === 'get') return async (k: string) => { if (keys.includes(k)) throw new Error('EIO (injected)'); return t.get(k); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** Every key of run `r`, with its value. */
async function snapshot(j: InMemoryJournal, runId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of await j.listKeys(`${runId}:`)) out[k] = JSON.stringify(await j.get(k));
  return out;
}

/** Ayşe's completed run `r`. */
async function aysesRun(): Promise<InMemoryJournal> {
  const j = new InMemoryJournal();
  await runDurable({ runId: 'r', journal: j, model: ok(), prompt: 'SECRET', caller: AYSE });
  expect((await j.get<{ status: string }>(runKeys.outcome('r')))?.status).toBe('completed');
  return j;
}

describe('the owner record is unreadable: nobody writes under the run', () => {
  const callers: Array<[string, Caller]> = [['another user', MALLORY], ['the owner herself', AYSE], ['staff', STAFF]];
  for (const [name, caller] of callers) {
    it(`${name}: refused with the store's error, and the run is untouched`, async () => {
      const j = await aysesRun();
      const before = await snapshot(j, 'r');
      await expect(runDurable({ runId: 'r', journal: failing(j, [runKeys.input('r')]) as never, model: ok(), prompt: 'x', caller })).rejects.toThrow(/EIO/);
      expect(await snapshot(j, 'r')).toEqual(before);
    });
  }
});

describe('siblings: every refusal before admission leaves the run as it was', () => {
  it('the thread owner is unreadable: another user on the owner\'s run writes nothing', async () => {
    const j = await aysesRun();
    const before = await snapshot(j, 'r');
    const broken = { getThreadResource: async () => { throw new Error('EIO (thread store)'); }, getMessages: async () => [], append: async () => {} };
    await expect(runDurable({ runId: 'r', journal: j, model: ok(), prompt: 'x', threadId: 'T', memory: broken as never, caller: MALLORY })).rejects.toThrow();
    expect(await snapshot(j, 'r')).toEqual(before);
  });

  it('a readable record that names someone else: refused, nothing written', async () => {
    const j = await aysesRun();
    const before = await snapshot(j, 'r');
    await expect(runDurable({ runId: 'r', journal: j, model: ok(), prompt: 'x', caller: MALLORY })).rejects.toThrow(/different subject/);
    expect(await snapshot(j, 'r')).toEqual(before);
  });

  it('an unreadable record for an id nobody has used: nothing is born under it', async () => {
    const j = new InMemoryJournal();
    await expect(runDurable({ runId: 'fresh', journal: failing(j, [runKeys.input('fresh')]) as never, model: ok(), prompt: 'x', caller: MALLORY })).rejects.toThrow(/EIO/);
    expect(await j.listKeys('fresh:')).toEqual([]);
  });
});

describe('the fix does not silence a real failure', () => {
  it('an admitted run whose model throws still records `failed`', async () => {
    const j = new InMemoryJournal();
    const boom = createMockModel(async () => { throw new Error('provider 401'); });
    await expect(runDurable({ runId: 'f', journal: j, model: boom, prompt: 'x', caller: AYSE })).rejects.toThrow(/401/);
    expect(await j.get(runKeys.outcome('f'))).toMatchObject({ status: 'failed' });
  });
});
