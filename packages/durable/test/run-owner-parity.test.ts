// PARITY: `runOwnerOf` + `decideRunAccess` replaced the definitions of "does this run exist, and whose
// is it" that the doors and the engine each carried (ADR-0002 point 7). The old definitions are kept
// here VERBATIM (as of 15e10409) and asked the same question on the same fixtures. Where the answers
// differ, the difference must be one this decision made on purpose — always toward closed — and it is
// listed below. A new divergence, or a listed one that disappears, turns this test red.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, runIdOfKey } from '../src/journal.js';
import { isRealRun } from '../src/retention.js';
import { runOwnerOf, decideRunAccess, claimRunOwner, user, STAFF, UNKNOWN, userIdOf, type Caller } from '../src/run-identity.js';

type Decision = 'allow' | 'deny' | 'missing';
type Who = 'ayse' | 'mallory' | 'staff';
const AS: Record<Who, Caller> = { ayse: user('ayse'), mallory: user('mallory'), staff: STAFF };

// ── the definitions that were replaced (15e10409) ────────────────────────────────────────────────

/** @gnldev/server `ownershipDenied` + `workflowTraceOf`: its reading, mapped to a decision. */
async function serverGateAtBase(j: InMemoryJournal, runId: string, who: Who): Promise<Decision> {
  const expected = who === 'staff' ? undefined : AS[who].kind === 'user' ? (AS[who] as { id: string }).id : undefined;
  let input: { resourceId?: string } | undefined;
  try {
    input = await j.get<{ resourceId?: string }>(`${runId}:input`);
    if (!input && ((await j.get(`wfrun:${runId}`)) !== undefined || (await j.get(`${runId}:wf:_input`)) !== undefined)) input = {};
  } catch {
    return 'allow'; // "a reader that cannot serve the entry is not evidence of a mismatch"
  }
  if (!input) return 'missing'; // "the run does not exist yet, and starting it is what this caller is here to do"
  if (!expected) return 'allow'; // staff stating nothing
  if (input.resourceId === expected) return 'allow';
  return 'deny';
}

/** The subject view's `ownerOf` (subject-view.ts): the record's `resourceId`, a failed read is nobody. */
async function viewOwnerAtBase(j: InMemoryJournal, runId: string): Promise<string | undefined> {
  try { return (await j.get<{ resourceId?: string }>(`${runId}:input`))?.resourceId; } catch { return undefined; }
}

/** The engine's adoption (run.ts): the frozen record's `resourceId`; a read error propagates. */
async function engineOwnerAtBase(j: InMemoryJournal, runId: string): Promise<string | undefined | 'threw'> {
  try { return (await j.get<{ resourceId?: string }>(runKeys.input(runId)))?.resourceId; } catch { return 'threw'; }
}

// ── fixtures: the four record states ────────────────────────────────────────────────────────────

function failing(j: InMemoryJournal, key: string) {
  return new Proxy(j, {
    get(t, p) {
      if (p === 'get') return async (k: string) => { if (k === key) throw new Error('EIO'); return t.get(k); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const FIXTURES: Record<string, () => Promise<InMemoryJournal>> = {
  normal: async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', user('ayse'), { prompt: 'x' });
    await j.put(runKeys.model('r', 0), { text: 'AYSE' });
    return j;
  },
  ownerless: async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', STAFF, { prompt: 'x' });
    await j.put(runKeys.model('r', 0), { text: 'STAFF' });
    return j;
  },
  'ownerless, before owner kinds were recorded': async () => {
    const j = new InMemoryJournal();
    await j.put('r:input', { _v: 2, at: 1, prompt: 'x' }); // what persistInput wrote for a staff run at 15e10409
    await j.put(runKeys.model('r', 0), { text: 'STAFF' });
    return j;
  },
  'record missing, agent rows present': async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('r', 0), { text: 'STAFF' });
    return j;
  },
  'record missing, workflow rows present': async () => {
    const j = new InMemoryJournal();
    await j.put('wfrun:r', { runId: 'r', status: 'suspended' });
    await j.put('r:wf:s', 'draft');
    return j;
  },
  unreadable: async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', user('ayse'), { prompt: 'x' });
    return failing(j, 'r:input') as unknown as InMemoryJournal;
  },
};

/** Every place the new rule answers differently from the old one — each toward closed, each on purpose. */
const DIVERGENCES = new Set([
  // D2: an agent run whose record is gone read as "not started" at the server gate — any end user
  // could start it and become its owner (measured: another user read its output).
  'record missing, agent rows present | ayse | server missing -> deny',
  'record missing, agent rows present | mallory | server missing -> deny',
  // …and so did its staff "restart" answer: the run exists, staff reaches it.
  'record missing, agent rows present | staff | server missing -> allow',
  // The read-error policy: the server gate treated an unreadable owner as "no evidence" and let it through.
  'unreadable | ayse | server allow -> deny',
  'unreadable | mallory | server allow -> deny',
  'unreadable | staff | server allow -> deny',
]);

describe('runOwnerOf agrees with the definitions it replaced (or differs on purpose, toward closed)', () => {
  it('server gate: every fixture x caller', async () => {
    const seen = new Set<string>();
    for (const [name, make] of Object.entries(FIXTURES)) {
      for (const who of Object.keys(AS) as Who[]) {
        const old = await serverGateAtBase(await make(), 'r', who);
        const now = decideRunAccess(await runOwnerOf(await make(), 'r'), AS[who]);
        if (old !== now) {
          seen.add(`${name} | ${who} | server ${old} -> ${now}`);
          // Never toward open: nothing the old rule denied is allowed now.
          expect(old === 'deny' && now !== 'deny', `${name} ${who}`).toBe(false);
        }
      }
    }
    expect([...seen].sort()).toEqual([...DIVERGENCES].sort());
  });

  it('subject view: the owner it reads is the owner runOwnerOf names, in every fixture', async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const old = await viewOwnerAtBase(await make(), 'r');
      const o = await runOwnerOf(await make(), 'r');
      const now = o.state === 'owned' ? userIdOf(o.owner) : undefined;
      expect(now, name).toBe(old);
    }
  });

  it('engine adoption: the same owner, and a read error still refuses', async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const old = await engineOwnerAtBase(await make(), 'r');
      const o = await runOwnerOf(await make(), 'r');
      if (old === 'threw') expect(o.state, name).toBe('unreadable');
      else expect(o.state === 'owned' ? userIdOf(o.owner) : undefined, name).toBe(old);
    }
  });

  it('isRealRun: the `_v` rule is one rule — a record isRealRun refuses names no owner here', async () => {
    const j = new InMemoryJournal();
    await j.put('planted:input', { resourceId: 'mallory' }); // unstamped: a caller's payload
    await claimRunOwner(j, 'real', user('ayse'), { prompt: 'x' });
    expect(await isRealRun(j, 'planted')).toBe(false);
    expect(runIdOfKey('planted:input', await j.get('planted:input'))).toBeNull();
    expect(userIdOf(((await runOwnerOf(j, 'planted')) as { owner: Caller }).owner)).toBeUndefined();
    expect(await isRealRun(j, 'real')).toBe(true);
    expect(userIdOf(((await runOwnerOf(j, 'real')) as { owner: Caller }).owner)).toBe('ayse');
    // Both ask the journal for the same key, once; neither needs the other.
    expect(decideRunAccess(await runOwnerOf(j, 'planted'), UNKNOWN)).toBe('deny');
  });
});
