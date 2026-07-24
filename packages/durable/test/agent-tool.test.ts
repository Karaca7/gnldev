// 8.5 createAgentTool: multi-agent durable handoff. The router calls a sub-agent; on resume,
// because the parent durableTool memoizes the result, the sub-agent does NOT run AGAIN (handoff exactly-once).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createAgentTool } from '../src/agent-tool.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('createAgentTool (8.5)', () => {
  it('router calls sub-agent; same runId resume -> NO sub-agent re-run', async () => {
    const journal = new InMemoryJournal();
    let subCalls = 0;
    const subModel = createMockModel(async () => {
      subCalls++;
      return finalTextResult('expert answer: 42');
    });
    const expert = createAgentTool({ journal, model: subModel }, { description: 'math expert' });

    const routerModel = () =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('askExpert', 'call-x', { task: '6x7?' });
        return finalTextResult('Result ready.');
      });

    const r1 = await runDurable({
      runId: 'router1', journal, model: routerModel(), tools: { askExpert: expert },
      prompt: 'calculate', stopWhen: stepCountIs(6),
    });
    expect(r1.text).toContain('Result');
    const calls1 = subCalls;
    expect(calls1).toBeGreaterThan(0); // sub-agent ran

    const r2 = await runDurable({
      runId: 'router1', journal, model: routerModel(), tools: { askExpert: expert },
      prompt: 'calculate', stopWhen: stepCountIs(6),
    });
    expect(r2.text).toContain('Result');
    expect(subCalls).toBe(calls1); // handoff replayed from journal -> sub-agent did not run again
  });
});
