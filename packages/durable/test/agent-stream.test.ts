// The agent stream schema, tested at its OWNER.
//
// `sse-parity.test.ts` in @gnldev/studio requires the two surfaces to emit identical events, which
// catches one surface drifting away from this module. It cannot catch a defect INSIDE this module:
// measured, deleting the `tool-error` case here leaves that suite green at 6/6 and the whole server
// suite green at 344/344, because both surfaces then drop the event identically. Consolidating two
// copies into one owner removed the accident that used to make such a bug visible somewhere, so the
// owner needs its own test. This is it.
//
// Every `case` label in agentStreamEvents is exercised, and the last test enforces that by reading
// the source — a lint-shaped check, named as such, because the alternative is a table that silently
// stops being total the next time somebody adds a part type.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStreamEvents, interruptsFromSteps } from '../src/agent-stream.js';

const CODES = { runLimitExceeded: 'run_limit_exceeded', toolLoopDetected: 'tool_loop_detected' };

/** The parts the schema deliberately turns into no event — shared with the lint check at the end. */
const QUIET = ['start', 'finish', 'text-start', 'text-end', 'abort', 'raw'];

/** Drives the generator over `parts`, with `steps` as the finished step list. */
async function events(parts: any[], steps: any[] = []): Promise<{ event: string; data: any }[]> {
  const result = {
    fullStream: (async function* () { yield* parts; })(),
    steps: Promise.resolve(steps),
    finishReason: Promise.resolve('stop'),
    usage: Promise.resolve({ totalTokens: 7 }),
  };
  const out: any[] = [];
  for await (const e of agentStreamEvents(result, 'r1', CODES)) out.push(e);
  return out;
}
/** Everything before the terminal `done`/`error`, which every run ends with. */
const body = (evs: { event: string }[]) => evs.slice(0, -1);
const names = (evs: { event: string }[]) => evs.map((e) => e.event);

describe('agentStreamEvents — every part type', () => {
  it('text-delta carries the text, from either field name, and empty is not an event', async () => {
    expect(body(await events([{ type: 'text-delta', text: 'a' }]))).toEqual([{ event: 'text-delta', data: { text: 'a' } }]);
    expect(body(await events([{ type: 'text-delta', delta: 'b' }]))).toEqual([{ event: 'text-delta', data: { text: 'b' } }]);
    expect(body(await events([{ type: 'text-delta', text: '' }])), 'an empty delta is noise').toEqual([]);
  });

  it('tool-call carries id, name and input', async () => {
    const e = body(await events([{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: { amount: 20 } }]));
    expect(e).toEqual([{ event: 'tool-call', data: { toolCallId: 'c1', toolName: 'charge', input: { amount: 20 } } }]);
  });

  it('tool-result carries the output', async () => {
    const e = body(await events([{ type: 'tool-result', toolCallId: 'c1', toolName: 'charge', output: { ok: 1 } }]));
    expect(e).toEqual([{ event: 'tool-result', data: { toolCallId: 'c1', toolName: 'charge', output: { ok: 1 } } }]);
  });

  // The three internal sentinels. Each is carried by another event; none may reach a client.
  for (const sentinel of ['__gnl_suspend', '__gnl_limit_exceeded', '__gnl_blocked']) {
    it(`tool-result withholds the ${sentinel} sentinel`, async () => {
      const evs = await events([{ type: 'tool-result', toolCallId: 'c1', toolName: 'charge', output: { [sentinel]: { x: 1 } } }]);
      expect(JSON.stringify(evs), 'an internal API on the wire').not.toContain(sentinel);
      expect(body(evs)).toEqual([]);
    });
  }

  it('reasoning start / delta / end — the thinking trace is not dropped', async () => {
    const e = body(await events([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', text: 'hmm' },
      { type: 'reasoning-delta', id: 'r', delta: 'more' },
      { type: 'reasoning-delta', id: 'r', text: '' },
      { type: 'reasoning-end', id: 'r' },
    ]));
    expect(names(e)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-delta', 'reasoning-end']);
    expect(e[1].data).toEqual({ id: 'r', text: 'hmm' });
  });

  it('tool-input start / delta / end, with `id` as the fallback for toolCallId', async () => {
    const e = body(await events([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'charge' },
      { type: 'tool-input-delta', id: 'c1', delta: '{"a' },
      { type: 'tool-input-end', id: 'c1' },
    ]));
    expect(names(e)).toEqual(['tool-input-start', 'tool-input-delta', 'tool-input-end']);
    expect(e[1].data).toEqual({ toolCallId: 'c1', delta: '{"a' });
    expect(e[2].data).toEqual({ toolCallId: 'c1' });
  });

  it('source and file', async () => {
    const e = body(await events([
      { type: 'source', sourceType: 'url', id: 's1', url: 'https://x', title: 'X' },
      { type: 'file', file: { mediaType: 'image/png', base64: 'AAA' } },
    ]));
    expect(e[0].data).toEqual({ sourceType: 'url', id: 's1', url: 'https://x', title: 'X' });
    expect(e[1].data).toEqual({ mediaType: 'image/png', base64: 'AAA' });
  });

  it('start-step / finish-step become step-start / step-finish', async () => {
    const e = body(await events([
      { type: 'start-step' },
      { type: 'finish-step', finishReason: 'tool-calls', usage: { totalTokens: 3 } },
    ]));
    expect(names(e)).toEqual(['step-start', 'step-finish']);
    expect(e[1].data).toEqual({ finishReason: 'tool-calls', usage: { totalTokens: 3 } });
  });

  it('tool-error is NON-terminal: it is reported and the stream goes on', async () => {
    const evs = await events([
      { type: 'tool-error', toolCallId: 'c1', toolName: 'charge', error: new Error('503') },
      { type: 'text-delta', text: 'recovered' },
    ]);
    expect(names(evs)).toEqual(['tool-error', 'text-delta', 'done']);
    expect(evs[0].data).toEqual({ toolCallId: 'c1', toolName: 'charge', error: '503' });
  });

  it('a part-level error keeps the message', async () => {
    expect(body(await events([{ type: 'error', error: new Error('boom') }]))).toEqual([{ event: 'error', data: { error: 'boom' } }]);
  });

  it('the deliberately silent parts emit nothing', async () => {
    const quiet = QUIET.map((type) => ({ type }));
    expect(body(await events(quiet)), 'covered by done / delta-only framing / transport-internal').toEqual([]);
  });

  it('an unknown part is named but never carried', async () => {
    const evs = await events([{ type: 'some-future-part', payload: 'SECRET' }]);
    expect(body(evs)).toEqual([{ event: 'raw', data: { type: 'some-future-part' } }]);
    expect(JSON.stringify(evs), 'the payload of a part nobody has handled yet').not.toContain('SECRET');
  });
});

describe('agentStreamEvents — endings', () => {
  const limitStep = (out: any) => [{ content: [{ type: 'tool-result', toolCallId: 'c1', output: out }] }];

  it('a limit breach ends in a typed error with its detail, and never reaches done', async () => {
    const detail = { limit: 3, count: 4 };
    const evs = await events([], limitStep({ __gnl_limit_exceeded: { kind: 'maxToolCalls', message: 'limit hit', detail } }));
    expect(names(evs)).toEqual(['error']);
    expect(evs[0].data).toEqual({ error: 'limit hit', code: CODES.runLimitExceeded, detail });
  });

  it('a detected loop uses the loop code, not the generic limit one', async () => {
    const evs = await events([], limitStep({ __gnl_limit_exceeded: { kind: 'loop', message: 'looping' } }));
    expect(evs[0].data.code).toBe(CODES.toolLoopDetected);
  });

  // The exact code, not "some string": a client branches on it — `side_effect_retry_blocked` means
  // "do not retry, a side effect may already have happened", `run_busy` means "retry later". And the
  // detail travels with it. Measured before these assertions: replacing the code with any literal, or
  // dropping `detail` from this ending, left every suite in the repository green.
  for (const [blockedBy, wire] of [['RunBusyError', 'run_busy'], ['SideEffectRetryBlockedError', 'side_effect_retry_blocked']]) {
    it(`a blocked run (${blockedBy}) ends in error with code ${wire} and its detail`, async () => {
      const detail = { toolName: 'charge', key: 'r1:tool:c1' };
      const evs = await events([], limitStep({ __gnl_blocked: { code: blockedBy, message: 'blocked', detail } }));
      expect(names(evs)).toEqual(['error']);
      expect(evs[0].data).toEqual({ error: 'blocked', code: wire, detail });
    });
  }

  it('a suspended tool surfaces as interrupt, then done', async () => {
    const evs = await events([], limitStep({ __gnl_suspend: { toolName: 'charge', args: { amount: 20 } } }));
    expect(names(evs)).toEqual(['interrupt', 'done']);
    expect(evs[0].data.interrupts).toHaveLength(1);
  });

  it('an ordinary run ends in done, carrying runId, finishReason and usage', async () => {
    const evs = await events([{ type: 'text-delta', text: 'hi' }]);
    expect(names(evs)).toEqual(['text-delta', 'done']);
    expect(evs[1].data).toEqual({ runId: 'r1', finishReason: 'stop', usage: { totalTokens: 7 } });
  });

  it('a stream that throws mid-flight ends in error, not silence', async () => {
    const result = {
      fullStream: (async function* () { yield { type: 'text-delta', text: 'a' }; throw new Error('socket died'); })(),
      steps: Promise.resolve([]), finishReason: Promise.resolve('stop'), usage: Promise.resolve({}),
    };
    const out: any[] = [];
    for await (const e of agentStreamEvents(result, 'r1', CODES)) out.push(e);
    expect(names(out)).toEqual(['text-delta', 'error']);
    expect(out[1].data.error).toBe('socket died');
  });
});

// Lint-shaped, and named so. The table above is only meaningful while it is TOTAL; a new `case`
// added to the switch with no test here would otherwise be invisible, which is exactly the failure
// mode that made this file necessary.
//
// Both sides are read STATICALLY — the switch from the module, the covered part types from this
// file's own `type: '…'` literals plus QUIET. An earlier version collected them at runtime from the
// tests above, which made this check depend on having run after them: selected alone (`-t`), it
// failed with nothing wrong.
it('every case label in the switch is fed by a test in this file', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'agent-stream.ts'), 'utf8');
  const labels = [...new Set([...src.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!))];
  // Comments are stripped BEFORE matching. Measured without this: adding `case 'ghost-part':` to the
  // switch and writing `type: 'ghost-part'` in a comment here left the file green at 22/22 with an
  // untested branch — a totality check that a sentence can satisfy is not one.
  const self = readFileSync(__filename, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const covered = new Set([...[...self.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]!), ...QUIET]);
  const untested = labels.filter((l) => !covered.has(l));
  expect(untested, 'part types the owner handles but no test above feeds it').toEqual([]);
  expect(labels.length, 'the switch shrank — did a part type stop being handled?').toBeGreaterThanOrEqual(21);
});

// `interruptsFromSteps` moved here with the schema; its only direct test stayed behind in
// @gnldev/server (test/nested-suspend-surface.test.ts). Exercised indirectly by the suspend ending
// above, which proves it returns SOMETHING — not that it reads the right shape or survives a step
// list that is missing the fields it walks. Both surfaces re-export it, so it is public API twice.
describe('interruptsFromSteps', () => {
  const suspended = (toolCallId: string, toolName: string) =>
    ({ type: 'tool-result', toolCallId, output: { __gnl_suspend: { toolCallId, toolName, args: { amount: 20 } } } });

  it('finds a suspended call and carries its name and args', () => {
    const [i] = interruptsFromSteps([{ content: [suspended('c1', 'charge')] }]);
    expect(i).toMatchObject({ toolCallId: 'c1', toolName: 'charge' });
    expect(JSON.stringify(i)).toContain('20');
  });

  it('collects across several steps, in order', () => {
    const got = interruptsFromSteps([
      { content: [suspended('c1', 'charge')] },
      { content: [{ type: 'text', text: 'thinking' }] },
      { content: [suspended('c2', 'ship'), suspended('c3', 'refund')] },
    ]);
    expect(got.map((i: any) => i.toolCallId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('ignores tool results that are not suspensions', () => {
    expect(interruptsFromSteps([{ content: [
      { type: 'tool-result', toolCallId: 'c1', output: { ok: 1 } },
      { type: 'tool-result', toolCallId: 'c2', output: { __gnl_limit_exceeded: { kind: 'maxToolCalls' } } },
      { type: 'tool-call', toolCallId: 'c3', toolName: 'charge' },
    ] }])).toEqual([]);
  });

  // It walks `steps[].content[]` with `?.` at every hop; a caller that hands it a half-built step
  // list must get an empty answer, not a throw that takes the whole stream down with it.
  it('survives a malformed step list instead of throwing', () => {
    for (const steps of [[], [null], [{}], [{ content: null }], [{ content: [null] }], [{ content: [{ type: 'tool-result' }] }]] as any[]) {
      expect(() => interruptsFromSteps(steps), JSON.stringify(steps)).not.toThrow();
      expect(interruptsFromSteps(steps)).toEqual([]);
    }
    expect(interruptsFromSteps(undefined as any)).toEqual([]);
  });
});
