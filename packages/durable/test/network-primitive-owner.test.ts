// The exported `runNetwork` primitive is a run birth like every other: its owner is recorded before
// its first row (ADR-0002 point 3).
//
// Found by the conformance registry: `gnl.runNetwork` admits its run (registry.ts `admitRun`), but the
// primitive it calls is exported on its own, and a network started through it wrote its route and
// step rows with no owner record. `runOwnerOf` read it as "staff, not recorded" — so the user who
// started it could not see it, and nothing held a second caller off it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runNetwork } from '../src/network.js';
import { createGnl } from '../src/registry.js';
import { runOwnerOf, user, UNKNOWN } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

const router = () => createMockModel(async () => finalTextResult(JSON.stringify({ action: 'final', answer: 'done' })));
const agents = { a: { description: 'a', run: async (task: string) => ({ text: `a:${task}` }) } };
const label = async (j: InMemoryJournal, id: string) => {
  const o = await runOwnerOf(j, id);
  return o.state === 'owned' ? `${o.owner.kind}${o.owner.kind === 'user' ? `:${o.owner.id}` : ''}${o.recorded ? '' : ' (not recorded)'} ${o.kind}` : o.state;
};
async function snapshot(j: InMemoryJournal, runId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of await j.listKeys(`${runId}:`)) out[k] = JSON.stringify(await j.get(k));
  return out;
}

describe('runNetwork (the exported primitive) records its owner', () => {
  it('started for a user: the run is that user\'s, recorded, and a network', async () => {
    const j = new InMemoryJournal();
    await runNetwork({ runId: 'n1', journal: j, routerModel: router(), agents, task: 'SECRET', caller: user('ayse') });
    expect(await label(j, 'n1')).toBe('user:ayse network');
  });

  it('started with no caller: the run is `unknown`\'s, recorded — never staff by omission', async () => {
    const j = new InMemoryJournal();
    await runNetwork({ runId: 'n2', journal: j, routerModel: router(), agents, task: 'x' });
    expect(await label(j, 'n2')).toBe('unknown network');
  });

  it('another user re-entering it is refused, and the run is untouched', async () => {
    const j = new InMemoryJournal();
    await runNetwork({ runId: 'n3', journal: j, routerModel: router(), agents, task: 'SECRET', caller: user('ayse') });
    const before = await snapshot(j, 'n3');
    await expect(runNetwork({ runId: 'n3', journal: j, routerModel: router(), agents, task: 'x', caller: user('mallory') })).rejects.toThrow(/different subject/);
    expect(await snapshot(j, 'n3')).toEqual(before);
  });

  it('the owner re-entering it replays the frozen answer', async () => {
    const j = new InMemoryJournal();
    await runNetwork({ runId: 'n4', journal: j, routerModel: router(), agents, task: 'x', caller: user('ayse') });
    const again = await runNetwork({ runId: 'n4', journal: j, routerModel: createMockModel(async () => { throw new Error('no model on replay'); }), agents, task: 'x', caller: user('ayse') });
    expect(again.text).toBe('done');
  });

  it('an empty agent list is refused before anything is written', async () => {
    const j = new InMemoryJournal();
    await expect(runNetwork({ runId: 'n5', journal: j, routerModel: router(), agents: {}, task: 'x', caller: UNKNOWN })).rejects.toThrow(/at least one agent/);
    expect(await j.listKeys('n5:')).toEqual([]);
  });
});

describe('gnl.runNetwork keeps its one admission', () => {
  it('the record names the registered network, for the caller', async () => {
    const j = new InMemoryJournal();
    const gnl = createGnl({ journal: j, agents: { a: { model: createMockModel(async () => finalTextResult('x')) } }, networks: { n: { router: router(), agents: ['a'] } } } as never);
    await gnl.runNetwork('n', { runId: 'g1', task: 'x', caller: user('ayse') });
    expect(await label(j, 'g1')).toBe('user:ayse network');
    expect(await j.get('g1:input')).toMatchObject({ network: 'n', resourceId: 'ayse' });
  });
});
