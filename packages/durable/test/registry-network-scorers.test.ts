// C4 runtime scorers + C5 first-class agent network (registry).
// - scorers: automatic when a run completes; journal-memoized → scorer does NOT RE-RUN on resume.
// - agents: registered agents become an `agent_<name>` tool; handoff is exactly-once via two-level journaling.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

describe('registry: runtime scorers (C4)', () => {
  it('scores when the run finishes; scorer does not re-run on resume/replay call', async () => {
    const journal = new InMemoryJournal();
    let scorerRuns = 0;
    const gnl = createGnl({
      journal,
      agents: {
        a: {
          model: createMockModel(async () => finalTextResult('final answer')),
          scorers: [{ name: 'len', score: ({ output }) => { scorerRuns++; return { score: output.length }; } }],
        },
      },
    });

    const r1: any = await gnl.run('a', { runId: 'sc-1', prompt: 'x' });
    expect(r1.scores.len.score).toBe('final answer'.length);
    expect(scorerRuns).toBe(1);
    // journal-memoized: same key schema as scoreRun
    expect(await journal.get('sc-1:proc:eval:len')).toEqual({ v: { score: 12 } });

    const r2: any = await gnl.run('a', { runId: 'sc-1', prompt: 'x' }); // replay
    expect(r2.scores.len.score).toBe(12);
    expect(scorerRuns).toBe(1); // exactly-once
  });
});

describe('registry: first-class agent network (C5)', () => {
  it('agents: sub-agent becomes an agent_<name> tool; handoff is journaled nested; skipped on resume', async () => {
    const journal = new InMemoryJournal();
    const routerCalls = { n: 0 };
    const subCalls = { n: 0 };

    const gnl = createGnl({
      journal,
      agents: {
        researcher: {
          model: createMockModel(async () => { subCalls.n++; return finalTextResult('RESEARCH RESULT'); }),
          system: 'You are a researcher.',
        },
        router: {
          model: createMockModel(async (options: any) => {
            routerCalls.n++;
            // First turn: hand off to the sub-agent; once the tool result arrives, write the final answer.
            return countToolResults(options.prompt) === 0
              ? toolCallResult('agent_researcher', 'call-r1', { task: 'research the topic' })
              : finalTextResult('Report ready.');
          }),
          agents: ['researcher'],
        },
      },
    });

    const r1: any = await gnl.run('router', { runId: 'net-1', prompt: 'research and report' });
    expect(r1.text).toBe('Report ready.');
    expect(subCalls.n).toBe(1);
    // Nested run in its own journal namespace, scoped to the parent: agent:<parentRunId>:<toolCallId>
    expect(await journal.get('agent:net-1:call-r1:model:0')).toBeDefined();
    // Parent's tool record memoized the handoff output
    const toolRec: any = await journal.get('net-1:tool:call-r1');
    expect(toolRec?.status).toBe('succeeded');
    expect(toolRec?.output?.text).toBe('RESEARCH RESULT');

    // Resume: parent models replay → sub-agent does NOT run AT ALL (handoff exactly-once)
    const before = { router: routerCalls.n, sub: subCalls.n };
    const r2: any = await gnl.run('router', { runId: 'net-1', prompt: 'research and report' });
    expect(r2.text).toBe('Report ready.');
    expect(routerCalls.n).toBe(before.router); // model middleware replay
    expect(subCalls.n).toBe(before.sub); // sub-agent skipped
  });

  it('unregistered sub-agent name throws an early, clear error', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { router: { model: createMockModel(async () => finalTextResult('x')), agents: ['no-such-agent'] } },
    });
    await expect(gnl.run('router', { runId: 'net-2', prompt: 'x' })).rejects.toThrow("agent 'no-such-agent' is not registered");
  });
});
