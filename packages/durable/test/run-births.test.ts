// ADR-0002 point 3 / R7: every run kind records its owner — ownerless too — at ONE common start point
// (`claimRunOwner`), so "no record" never reads as "not started" for a run that has started. Each
// birth below is asked for a user, for staff and for a caller that named nobody; the record it leaves
// must say exactly that, stamped, so the gates and the listings read the same owner.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { workflow, step } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { createBatch } from '../src/batch.js';
import { createAgentTool } from '../src/agent-tool.js';
import { forkRun } from '../src/time-travel.js';
import { rolloverRun } from '../src/rollover.js';
import { replayRun } from '../src/regression.js';
import { runOwnerOf, user, STAFF, UNKNOWN, type Caller } from '../src/run-identity.js';
import { createMockModel, createMockStreamAgent, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const text = () => createMockModel(async () => finalTextResult('ok'));
const WHO: Array<[string, Caller]> = [['a user', user('ayse')], ['staff', STAFF], ['nobody', UNKNOWN]];

/** The owner the record names, in the shape the gates read it. */
async function ownerOf(j: InMemoryJournal, runId: string): Promise<string> {
  const o = await runOwnerOf(j, runId);
  if (o.state !== 'owned') return o.state;
  expect(o.recorded, `${runId} is recorded (stamped), not inferred`).toBe(true);
  return o.owner.kind === 'user' ? `user:${o.owner.id}` : o.owner.kind;
}
const expected = (c: Caller) => (c.kind === 'user' ? `user:${c.id}` : c.kind);

/** The births. Each starts ONE run as `caller` and returns its runId. */
const BIRTHS: Record<string, (j: InMemoryJournal, caller: Caller) => Promise<string>> = {
  'agent (runDurable)': async (j, caller) => { await runDurable({ runId: 'a', journal: j, model: text(), prompt: 'x', caller }); return 'a'; },
  'agent (streamDurable)': async (j, caller) => {
    const r = await streamDurable({ runId: 's', journal: j, model: createMockStreamAgent(), prompt: 'x', caller } as never);
    await (r as { text: Promise<string> }).text;
    return 's';
  },
  'agent (createGnl.run)': async (j, caller) => { await createGnl({ journal: j, agents: { a: { model: text() } } } as never).run('a', { runId: 'g', prompt: 'x', caller }); return 'g'; },
  workflow: async (j, caller) => {
    await createGnl({ journal: j, workflows: { w: workflow<any>().then(step('s', async () => 1)) } } as never).runWorkflow!('w', {}, { runId: 'w1', caller } as never);
    return 'w1';
  },
  network: async (j, caller) => {
    const gnl = createGnl({ journal: j, agents: { a: { model: text() } }, networks: { n: { router: createMockModel(async () => finalTextResult(JSON.stringify({ action: 'final', answer: 'ok' }))), agents: ['a'] } } } as never);
    await gnl.runNetwork('n', { runId: 'n1', task: 'x', caller } as never);
    return 'n1';
  },
  'batch item': async (j, caller) => {
    const t = Object.assign(tool({ description: 'd', inputSchema: z.object({ id: z.string() }), execute: async (i) => i.id }), { idempotent: true });
    const b = createBatch(j, { tool: t as never, toolName: 'echo', itemKey: (i: any) => i.id, caller, onDuplicate: 'skip' });
    const plan = await b.preflight('b1', [{ id: 'x' }]);
    await b.run('b1', [{ id: 'x' }], { planToken: plan.token });
    return (await j.listKeys('batch:b1:')).find((k) => k.endsWith(':input'))!.slice(0, -':input'.length);
  },
  'agent-tool child': async (j, caller) => {
    const helper = createAgentTool({ journal: j, model: text() } as never);
    const model = createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCallResult('helper', 'c1', { task: 't' }) : finalTextResult('ok')));
    await runDurable({ runId: 'p', journal: j, model, tools: { helper }, prompt: 'x', stopWhen: stepCountIs(4), caller });
    return (await j.listKeys('')).find((k) => k.endsWith(':input') && k !== 'p:input')!.slice(0, -':input'.length);
  },
  fork: async (j, caller) => {
    await runDurable({ runId: 'src', journal: j, model: text(), prompt: 'x', caller });
    return (await forkRun(j, 'src', 1, 'fk')).newRunId;
  },
  rollover: async (j, caller) => {
    await runDurable({ runId: 'ro', journal: j, model: text(), prompt: 'x', caller });
    return (await rolloverRun(j, 'ro')).newRunId;
  },
  replay: async (j, caller) => {
    await runDurable({ runId: 'rp', journal: j, model: text(), prompt: 'x', caller });
    return (await replayRun({ journal: j, runId: 'rp', model: text() })).newRunId;
  },
};

describe('every run birth records its owner, ownerless too', () => {
  for (const [birth, start] of Object.entries(BIRTHS)) {
    for (const [label, caller] of WHO) {
      it(`${birth}, started for ${label}`, async () => {
        const j = new InMemoryJournal();
        const runId = await start(j, caller);
        expect(await ownerOf(j, runId)).toBe(expected(caller));
      });
    }
  }
});

describe('ONE start point: nothing outside it writes a run\'s owner record', () => {
  // A new birth added with its own `put(<runId>:input)` would bypass the stamp, the ownerless marker
  // and the first-write-wins claim — the three things this decision is about. The two writers below
  // freeze CONTENT over a record that claimRunOwner already wrote (the frozen agent input; a fork's
  // copy of its source's input), with the same owner fields.
  const ALLOWED = new Set(['durable/src/run-identity.ts', 'durable/src/run.ts', 'durable/src/time-travel.ts']);
  const root = join(__dirname, '..', '..');
  const INPUT_KEY = /runKeys\.input\(|:input`/;

  /** Lines that WRITE a run's `:input` — directly, or through a variable that holds such a key. */
  function inputWrites(src: string): string[] {
    const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line));
    const vars = code.flatMap((line) => {
      const m = /\b(?:const|let)\s+(\w+)\s*=\s*(.*)$/.exec(line);
      return m && INPUT_KEY.test(m[2]!) ? [m[1]!] : [];
    });
    const target = new RegExp(`(?:\\.put|\\bclaim|putIfAbsent)\\((?:[\\w.]+,\\s*)?(?:${['runKeys\\.input\\(', '`[^`]*:input`', ...vars.map((v) => `${v}\\b`)].join('|')})`);
    return code.filter((line) => target.test(line));
  }

  it('the scan sees the writers that exist (it is not vacuous)', () => {
    for (const f of ['run-identity.ts', 'run.ts', 'time-travel.ts']) {
      expect(inputWrites(readFileSync(join(root, 'durable', 'src', f), 'utf8')).length, f).toBeGreaterThan(0);
    }
  });

  it('every package source is scanned, and only the allowed files write `:input`', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(root)) {
      let files: string[];
      try { files = readdirSync(join(root, pkg, 'src'), { recursive: true }) as string[]; } catch { continue; }
      for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
        const rel = `${pkg}/src/${f}`;
        if (inputWrites(readFileSync(join(root, pkg, 'src', f), 'utf8')).length && !ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
