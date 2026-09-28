// 0.7.0 release panel 2 (debt): the engine resolved the server's seal, an explicit `caller` and the
// `resourceId` shorthand by precedence, and let the seal win SILENTLY on a conflict — a context sealed
// for ayse plus `caller: mallory` started ayse's run and nobody was told. A seal and an explicit
// `caller` that disagree now throw, on every registry entry (run, stream, runWorkflow, runNetwork).
// Agreement, a seal alone, and the documented P1.7 override of the `resourceId` shorthand still work.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, user, staff, STAFF, sealRequestContext, sealFieldsOf, resolveCaller } from '../src/index.js';
import { workflow, step } from '../../workflow/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

function world() {
  const storage = new InMemoryStorage();
  const model = createMockModel(async () => finalTextResult('ok'));
  const router = createMockModel(async () => finalTextResult(JSON.stringify({ action: 'final', answer: 'x' })));
  const gnl = createGnl({
    storage, agents: { a: { model }, r: { model: router } },
    workflows: { w: workflow<any>().then(step('s', async () => 'done')) },
    networks: { n: { router, agents: ['a'] } },
  } as never);
  return { gnl, runs: storage.runs as any };
}
const sealedFor = (c: Parameters<typeof sealFieldsOf>[0], org?: string) => sealRequestContext({}, sealFieldsOf(c, org));
const outcome = (p: Promise<unknown>) => p.then(() => 'OK', (e: Error) => `${e.name}: ${e.message.slice(0, 60)}`);

describe('a seal and a declared caller that disagree are refused, not overruled', () => {
  const entries: Array<[string, (gnl: any, o: any) => Promise<unknown>]> = [
    ['gnl.run', (gnl, o) => gnl.run('a', { runId: 'r1', prompt: 'x', ...o })],
    ['gnl.stream', (gnl, o) => gnl.stream('a', { runId: 'r1', prompt: 'x', ...o }).then((r: any) => r.text)],
    ['gnl.runWorkflow', (gnl, o) => gnl.runWorkflow('w', {}, { runId: 'r1', ...o })],
    ['gnl.runNetwork', (gnl, o) => gnl.runNetwork('n', { runId: 'r1', task: 'x', ...o })],
  ];
  for (const [label, go] of entries) {
    it(`${label}: sealed ayse, caller mallory → throws, and no run is started`, async () => {
      const { gnl, runs } = world();
      expect(await outcome(go(gnl, { context: sealedFor(user('u-ayse')), caller: user('u-mallory') }))).toMatch(/^TypeError: .*sealed for u-ayse/);
      expect(await runs.get('r1:input')).toBeUndefined();
    });
  }

  it('siblings: sealed staff + caller user, sealed user + caller staff, sealed ayse@acme + caller ayse@globex', async () => {
    const { gnl } = world();
    const run = (o: object) => outcome(gnl.run('a', { runId: `r-${Math.random()}`, prompt: 'x', ...o }));
    expect(await run({ context: sealedFor(STAFF), caller: user('u-mallory') })).toMatch(/^TypeError/);
    expect(await run({ context: sealedFor(user('u-ayse')), caller: STAFF })).toMatch(/^TypeError/);
    expect(await run({ context: sealedFor(user('u-ayse', 'acme'), 'acme'), caller: user('u-ayse', 'globex') })).toMatch(/^TypeError/);
  });

  it('unchanged (P1.7): the `resourceId` shorthand, the field a body reaches, is still overruled by the seal', async () => {
    const { gnl, runs } = world();
    expect(await outcome(gnl.run('a', { runId: 'p1', prompt: 'x', context: sealedFor(user('u-ayse')), resourceId: 'u-mallory' }))).toBe('OK');
    expect((await runs.get('p1:input'))?.resourceId).toBe('u-ayse');
  });

  it('controls: agreement, a seal alone, and a caller alone still run as before', async () => {
    const { gnl, runs } = world();
    expect(await outcome(gnl.run('a', { runId: 'c1', prompt: 'x', context: sealedFor(user('u-ayse', 'acme'), 'acme'), caller: user('u-ayse', 'acme') }))).toBe('OK');
    expect((await runs.get('c1:input'))?.resourceId).toBe('u-ayse');
    expect(await outcome(gnl.run('a', { runId: 'c2', prompt: 'x', context: sealedFor(user('u-ayse')) }))).toBe('OK');
    expect((await runs.get('c2:input'))?.resourceId).toBe('u-ayse');
    expect(await outcome(gnl.run('a', { runId: 'c3', prompt: 'x', caller: user('u-mallory') }))).toBe('OK');
    expect((await runs.get('c3:input'))?.resourceId).toBe('u-mallory');
    expect(await outcome(gnl.run('a', { runId: 'c4', prompt: 'x', context: sealedFor(staff('acme'), 'acme'), caller: STAFF }))).toBe('OK');
  });

  it('resolveCaller and sealFieldsOf are one mapping: a door\'s seal read back is the caller it sealed', () => {
    for (const c of [user('u-ayse', 'acme'), staff('acme'), user('u-bob')]) {
      const org = c.kind === 'unknown' ? undefined : c.orgId;
      expect(resolveCaller(sealFieldsOf(c, org), { caller: c })).toEqual(c);
    }
    expect(sealFieldsOf({ kind: 'unknown' } as never, 'acme')).toEqual({ orgId: 'acme' });
  });
});
