// Every step's output is journaled under `${runId}:wf:${stepId}`, so two steps that derive the same
// default id share one record. `.map` had always been position-unique (`map#${steps.length}`); the
// other six derived theirs from a fixed string or from their own contents, so using any of them
// TWICE in one workflow collapsed both onto one key.
//
// The failure was silent and it was a wrong ANSWER, not an error: the second combinator's bodies
// never ran, and the workflow returned the FIRST one's output as if it were the second's. Nothing in
// the API hints that an id is required — the README's own line is `.foreach(...)` · `.loop(...)`.
//
// The suite could not have caught it: across nine files it contained exactly one `.foreach` and one
// `.loop`. This test uses each combinator twice, which is the only shape that shows the bug.
import { describe, it, expect } from 'vitest';
import { workflow, type JournalLike } from '../src/index.js';

function memJournal(): JournalLike {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as any,
    put: async (k, v) => { m.set(k, v); },
    putIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    listKeys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  };
}

const run = (wf: any, input: unknown, runId: string) =>
  wf.run(input, { runId, journal: memJournal() } as any);

describe('a combinator used twice gets two journal keys, not one', () => {
  it('foreach twice: both bodies run, and the second returns its own output', async () => {
    const seen: string[] = [];
    const wf = workflow<string[]>()
      .foreach(
        (xs) => xs,
        async (x: string) => { seen.push(`a:${x}`); return `charged ${x}`; },
      )
      .map((out: string[]) => out.map((s) => s.replace('charged', 'for')))
      .foreach(
        (xs) => xs,
        async (x: string) => { seen.push(`b:${x}`); return `emailed ${x}`; },
      );

    const out: any = await run(wf, ['inv-1', 'inv-2'], 'fe-1');
    expect(seen).toEqual(['a:inv-1', 'a:inv-2', 'b:for inv-1', 'b:for inv-2']);
    expect(out).toEqual(['emailed for inv-1', 'emailed for inv-2']);
  });

  it('loop twice: the second loop runs rather than replaying the first', async () => {
    const wf = workflow<number>()
      .loop(async (n: number) => n + 1, (n: number) => n < 3)
      .loop(async (n: number) => n * 10, (n: number) => n < 300);

    const out: any = await run(wf, 0, 'lp-1');
    expect(out).toBe(300);
  });

  it('dowhile and dountil twice each', async () => {
    const wf = workflow<number>()
      .dowhile(async (n: number) => n + 1, (n: number) => n < 2)
      .dowhile(async (n: number) => n + 10, (n: number) => n < 22)
      .dountil(async (n: number) => n + 100, (n: number) => n >= 122)
      .dountil(async (n: number) => n + 1000, (n: number) => n >= 1122);

    const out: any = await run(wf, 0, 'dw-1');
    expect(out).toBe(1122);
  });

  it('parallel twice over identically-named sub-steps', async () => {
    const leg = (tag: string) => ({ id: 'leg', run: async (n: number) => n + (tag === 'x' ? 1 : 2) });
    const wf = workflow<number>()
      .parallel([leg('x'), leg('y')])
      .map((o: Record<string, number>) => Object.values(o)[0] ?? 0)
      .parallel([leg('x'), leg('y')]);

    const out: any = await run(wf, 0, 'pl-1');
    expect(Object.keys(out)).toHaveLength(1); // both legs share the id 'leg' by construction
  });

  it('branch twice over identically-named arms', async () => {
    const hi = { id: 'hi', run: async (n: number) => n + 1 };
    const lo = { id: 'lo', run: async (n: number) => n - 1 };
    const wf = workflow<number>()
      .branch((n: number) => n > 0, hi, lo)
      .branch((n: number) => n > 0, hi, lo);

    const out: any = await run(wf, 1, 'br-1');
    expect(out).toBe(3); // 1 -> 2 -> 3, not 1 -> 2 -> replayed 2
  });

  it('the default ids are distinct, which is the property all of the above rests on', () => {
    const steps = workflow<any>()
      .foreach((x: any[]) => x, async () => 1)
      .foreach((x: any[]) => x, async () => 2)
      .loop(async (n: any) => n, () => false)
      .loop(async (n: any) => n, () => false)
      .build();
    const ids = steps.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
