// ADR-0002 point 3: `runOwnerOf` is the ONE answer to "does this run exist, and whose is it", and
// `decideRunAccess` the one rule on it. These pin the answer in every record state (normal, ownerless,
// record missing with rows present, unreadable), the `_v` rule, the bounded probe, and the decisions.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { stampFormat } from '../src/format.js';
import { withSubjectJournal } from '../src/subject-view.js';
import { runOwnerOf, decideRunAccess, decideRun, admitRun, claimRunOwner, user, STAFF, UNKNOWN, type Caller, type RunOwner } from '../src/run-identity.js';

const AYSE = user('ayse');
const MALLORY = user('mallory');
const CALLERS: Record<string, Caller> = { ayse: AYSE, mallory: MALLORY, staff: STAFF, unknown: UNKNOWN };

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

describe('runOwnerOf: every record state', () => {
  it('normal: a stamped record names its owner', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', AYSE, { prompt: 'x' });
    const o = await runOwnerOf(j, 'r');
    expect(o).toMatchObject({ state: 'owned', owner: { kind: 'user', id: 'ayse' }, kind: 'agent', recorded: true });
  });

  it('ownerless: a run born with no end user is staff\'s (or unknown\'s), and SAYS so', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r-staff', STAFF, { workflow: 'w' });
    await claimRunOwner(j, 'r-anon', UNKNOWN, { prompt: 'x' });
    expect(await runOwnerOf(j, 'r-staff')).toMatchObject({ state: 'owned', owner: { kind: 'staff' }, kind: 'workflow' });
    expect(await runOwnerOf(j, 'r-anon')).toMatchObject({ state: 'owned', owner: { kind: 'unknown' } });
  });

  it('record missing, rows present: the run EXISTS and is nobody\'s — never "not started"', async () => {
    for (const row of [runKeys.model('r', 0), runKeys.tool('r', 'c1'), 'r:wf:s', 'r:net:route:0', 'r:outcome']) {
      const j = new InMemoryJournal();
      await j.put(row, { any: 1 });
      expect(await runOwnerOf(j, 'r'), row).toMatchObject({ state: 'owned', owner: { kind: 'staff' }, recorded: false });
    }
    // The workflow registry row lives outside the run's prefix, and counts too.
    const j = new InMemoryJournal();
    await j.put('wfrun:r', { runId: 'r', status: 'suspended' });
    expect(await runOwnerOf(j, 'r')).toMatchObject({ state: 'owned', owner: { kind: 'staff' } });
  });

  it('a `:`-prefix of another run\'s id is occupied (its keys would be ambiguous with the longer run\'s)', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'team:1', AYSE, { workflow: 'w' });
    expect(await runOwnerOf(j, 'team')).toMatchObject({ state: 'owned', owner: { kind: 'staff' } });
    expect(await runOwnerOf(j, 'tea')).toEqual({ state: 'missing' });
  });

  it('bookkeeping written before a run starts (lock, lessons, inherited taint) or after it is swept is not a row', async () => {
    const j = new InMemoryJournal();
    for (const k of ['r:lock', 'r:cfg:lessons', 'r:proc:__gnl_taint', 'r:swept']) await j.put(k, { at: 1 });
    expect(await runOwnerOf(j, 'r')).toEqual({ state: 'missing' });
  });

  it('unreadable: the store\'s failure is reported, not read as "missing"', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', AYSE, { prompt: 'x' });
    const o = await runOwnerOf(failing(j, ['r:input']), 'r');
    expect(o.state).toBe('unreadable');
  });

  it('the `_v` rule: an unstamped record (a caller\'s payload under `<x>:input`) names nobody', async () => {
    const j = new InMemoryJournal();
    await j.put('r:input', { resourceId: 'mallory', prompt: 'planted' }); // appendLog(j, 'r', …, 'input') writes this shape
    const o = await runOwnerOf(j, 'r');
    expect(o).toMatchObject({ state: 'owned', owner: { kind: 'staff' }, recorded: false });
    expect(decideRunAccess(o, MALLORY)).toBe('deny');
    // The same bytes, stamped by the journal, are an owner.
    await j.put('s:input', stampFormat({ resourceId: 'mallory', prompt: 'x' }));
    expect(decideRunAccess(await runOwnerOf(j, 's'), MALLORY)).toBe('allow');
  });

  it('refuses an end user\'s VIEW: a decision reads the raw journal', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', AYSE, { prompt: 'x' });
    await expect(runOwnerOf(withSubjectJournal(j, 'ayse') as never, 'r')).rejects.toThrow(/VIEW/);
  });
});

describe('runOwnerOf: the probe is bounded', () => {
  function spying(j: InMemoryJournal) {
    const calls: Array<{ prefix: string; limit?: number; returned: number }> = [];
    const proxy = new Proxy(j, {
      get(t, p) {
        if (p === 'listKeys') return async (prefix: string, o?: { limit?: number }) => {
          const out = await t.listKeys(prefix, o);
          calls.push({ prefix, ...(o?.limit !== undefined ? { limit: o.limit } : {}), returned: out.length });
          return out;
        };
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return { proxy, calls };
  }

  it('a new run id costs one limited listing, however many keys its neighbours hold', async () => {
    const j = new InMemoryJournal();
    for (let i = 0; i < 5_000; i++) await j.put(`big:tool:c${i}`, { i });
    const { proxy, calls } = spying(j);
    expect(await runOwnerOf(proxy, 'fresh')).toEqual({ state: 'missing' });
    expect(await runOwnerOf(proxy, 'big')).toMatchObject({ state: 'owned' });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.limit).toBeDefined();
      expect(c.returned).toBeLessThanOrEqual(c.limit!);
    }
  });

  it('a recorded run is answered by its record alone (no listing)', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', AYSE, { prompt: 'x' });
    for (let i = 0; i < 100; i++) await j.put(`r:tool:c${i}`, { i });
    const { proxy, calls } = spying(j);
    await runOwnerOf(proxy, 'r');
    expect(calls).toEqual([]);
  });

  it('a journal that cannot list gets a fixed set of point reads', async () => {
    const inner = new InMemoryJournal();
    await inner.put(runKeys.model('r', 0), { x: 1 });
    let gets = 0;
    const bare = { get: async (k: string) => { gets++; return inner.get(k); }, put: (k: string, v: unknown) => inner.put(k, v) };
    expect(await runOwnerOf(bare as never, 'r')).toMatchObject({ state: 'owned' });
    gets = 0;
    expect(await runOwnerOf(bare as never, 'nothing')).toEqual({ state: 'missing' });
    expect(gets).toBeLessThanOrEqual(6);
  });
});

describe('decideRunAccess: the one rule', () => {
  const owned = (owner: Caller): RunOwner => ({ state: 'owned', owner, kind: 'agent', recorded: true });
  const cases: Array<[string, RunOwner, Record<keyof typeof CALLERS, 'allow' | 'deny' | 'missing'>]> = [
    ['missing', { state: 'missing' }, { ayse: 'missing', mallory: 'missing', staff: 'missing', unknown: 'missing' }],
    ['ayse\'s', owned(AYSE), { ayse: 'allow', mallory: 'deny', staff: 'allow', unknown: 'deny' }],
    ['staff\'s (ownerless)', owned(STAFF), { ayse: 'deny', mallory: 'deny', staff: 'allow', unknown: 'deny' }],
    ['unknown\'s', owned(UNKNOWN), { ayse: 'deny', mallory: 'deny', staff: 'allow', unknown: 'allow' }],
    ['unreadable', { state: 'unreadable', error: new Error('EIO') }, { ayse: 'deny', mallory: 'deny', staff: 'deny', unknown: 'deny' }],
  ];
  for (const [name, owner, expected] of cases) {
    it(`a run that is ${name}`, () => {
      for (const [who, c] of Object.entries(CALLERS)) expect(decideRunAccess(owner, c), who).toBe(expected[who as keyof typeof CALLERS]);
    });
  }

  it('decideRun reads and decides in one call', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', AYSE, { prompt: 'x' });
    expect(await decideRun(j, 'r', AYSE)).toBe('allow');
    expect(await decideRun(j, 'r', MALLORY)).toBe('deny');
    expect(await decideRun(j, 'nope', MALLORY)).toBe('missing');
  });
});

describe('admitRun: the entry every run kind shares', () => {
  it('a new run is born with its caller as owner — ownerless too', async () => {
    const j = new InMemoryJournal();
    expect((await admitRun(j, 'a', AYSE, { workflow: 'w' })).acting).toEqual(AYSE);
    expect((await admitRun(j, 'b', UNKNOWN, { workflow: 'w' })).acting).toEqual(UNKNOWN);
    expect(await runOwnerOf(j, 'a')).toMatchObject({ owner: { kind: 'user', id: 'ayse' } });
    expect(await runOwnerOf(j, 'b')).toMatchObject({ owner: { kind: 'unknown' } });
  });

  it('a re-entry acts for the RECORDED owner; a caller who may not act is refused and nothing is written', async () => {
    const j = new InMemoryJournal();
    await admitRun(j, 'a', AYSE, { workflow: 'w' });
    expect((await admitRun(j, 'a', STAFF, { workflow: 'w' })).acting).toEqual(AYSE);
    await expect(admitRun(j, 'a', MALLORY, { workflow: 'w' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    await expect(admitRun(j, 'a', UNKNOWN, { workflow: 'w' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
  });

  it('a run whose record is gone but whose rows remain is refused to an end user, and is NOT claimed', async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('legacy', 0), { content: 'STAFF-SECRET' });
    await expect(admitRun(j, 'legacy', MALLORY, { prompt: 'x' })).rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
    expect(await j.get('legacy:input')).toBeUndefined();
  });

  it('an unreadable owner refuses with the store\'s own error', async () => {
    const j = new InMemoryJournal();
    await admitRun(j, 'a', AYSE, { workflow: 'w' });
    await expect(admitRun(failing(j, ['a:input']) as never, 'a', AYSE, { workflow: 'w' })).rejects.toThrow(/EIO/);
  });

  it('the refusal names nobody in its sentence', async () => {
    const j = new InMemoryJournal();
    await admitRun(j, 'a', AYSE, { workflow: 'w' });
    const e = await admitRun(j, 'a', MALLORY).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain('ayse');
    expect(String((e as Error).message)).not.toContain('mallory');
  });
});
