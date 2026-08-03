// An agent that can START a workflow — the composition that was missing.
//
// The frame always composed in one direction: a workflow CONTAINS agents (its steps call them), and
// an agent can contain sub-agents (`agents` → `agent_<name>` tools). But an agent could not reach a
// workflow at all, so "look this up, and if it needs the full onboarding pipeline, kick it off" was
// not expressible — the question that surfaced it, verbatim: "bir agenta workflow bağlanamıyor mu?"
//
// `workflows: ['name']` closes it, mirroring the sub-agent contract piece for piece:
//   · the child runId is derived from the toolCallId, so the SAME parent step maps to the SAME
//     workflow run — a parent resume skips a completed workflow instead of launching a second one
//   · an unknown name is refused at wiring time, naming what IS registered
//   · a suspended workflow comes back as DATA, not as a throw: "it is waiting on a human" is an
//     answer to the agent's question, not a failure of it
import { describe, it, expect } from 'vitest';
import { createGnl, InMemoryJournal } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Calls the workflow tool once, then answers with what it got. */
function delegatingModel(toolName: string) {
  let step = 0;
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: '{"input":{"orderId":"8812"}}' }],
          finishReason: 'tool-calls' as const, usage, warnings: [] as any[],
        };
      }
      return { content: [{ type: 'text', text: 'pipeline done' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
    doStream: async () => { throw new Error('no'); },
  };
}

describe('an agent starts a workflow', () => {
  it('runs it as a tool and hands the output back', async () => {
    const journal = new InMemoryJournal();
    const seen: unknown[] = [];
    const gnl = createGnl({
      journal,
      workflows: {
        onboarding: {
          build: () => [{ id: 's1' }],
          run: async (input: unknown) => { seen.push(input); return { shipped: true }; },
        },
      },
      agents: {
        clerk: { model: delegatingModel('workflow_onboarding') as any, workflows: ['onboarding'] },
      },
    });

    const res = await gnl.run('clerk', { runId: 'r1', prompt: 'onboard order 8812' });

    expect(res.text).toBe('pipeline done');
    // The workflow really ran, with the input the model gave it.
    expect(seen).toEqual([{ orderId: '8812' }]);
  });

  it('derives the child run from the tool call, so a parent resume does not run it twice', async () => {
    // The exactly-once contract `agents` already has, carried over. The parent is re-run under the
    // SAME runId; the journalled tool result answers the call, and the workflow body must not fire
    // again — a second execution here is a second real side effect in production.
    const journal = new InMemoryJournal();
    let executions = 0;
    const mk = () => createGnl({
      journal,
      workflows: {
        pipeline: { build: () => [], run: async () => { executions += 1; return { n: executions }; } },
      },
      agents: {
        clerk: { model: delegatingModel('workflow_pipeline') as any, workflows: ['pipeline'] },
      },
    });

    await mk().run('clerk', { runId: 'same-run', prompt: 'go' });
    await mk().run('clerk', { runId: 'same-run', prompt: 'go' });

    expect(executions).toBe(1);
  });

  it('refuses an unknown workflow at wiring time, naming what exists', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      workflows: { real: { build: () => [], run: async () => ({}) } },
      agents: { clerk: { model: delegatingModel('workflow_ghost') as any, workflows: ['ghost'] } },
    });

    // The refusal happens when the rig is wired for a run — before any model call is paid for —
    // and it lists the registered names instead of a bare "not registered".
    await expect(gnl.run('clerk', { runId: 'r-ghost', prompt: 'go' }))
      .rejects.toThrow(/workflow 'ghost'.*Registered workflows: real/s);
  });

  it('returns a suspended workflow as data, not as a failure', async () => {
    // A workflow that stops for a human answered the agent's question with "it is waiting". The
    // agent gets that as a tool RESULT it can relay — throwing would turn every HITL pause into a
    // crashed run.
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      workflows: {
        approval: {
          build: () => [{ id: 'wait' }],
          run: async () => ({}),
          runResumable: async () => ({ status: 'suspended' as const, stepId: 'wait', reason: 'needs a manager' }),
        },
      },
      agents: { clerk: { model: delegatingModel('workflow_approval') as any, workflows: ['approval'] } },
    });

    const res = await gnl.run('clerk', { runId: 'r-hitl', prompt: 'go' });
    // The model saw the suspension and still finished its own run.
    expect(res.text).toBe('pipeline done');

    // And the tool result in the journal says suspended, with the step that is waiting — the
    // record's output IS the tool's return value, no extra nesting.
    const entries = await journal.readRun('r-hitl');
    const toolRec = entries.find((e: any) => e.kind === 'tool') as any;
    expect(toolRec?.value?.output ?? toolRec?.value).toMatchObject({ suspended: true, stepId: 'wait', reason: 'needs a manager' });
  });
});
