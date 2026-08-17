// An agent as a node in a workflow graph — the combination, not either half.
//
// Both halves are covered elsewhere: @gnldev/workflow tests the graph (then/branch/parallel/foreach,
// suspend, replay) and this package tests the agent loop. Nothing tested what happens when one runs
// INSIDE the other, which is the first thing a reader tries — and it is the case where two journal
// key spaces meet. `Step` is a two-field interface, so putting `runDurable` in a step's `run` needs
// no new API; the question is whether the guarantees survive the nesting, and that is not something
// the README should claim without a test behind it.
//
// What is at stake in each case is written above it. The short version: a workflow that replays must
// not re-execute an agent's side effect, and an agent's own dedup must keep working when its journal
// keys sit under a workflow's prefix.
import { describe, it, expect } from 'vitest';
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/**
 * The adapter under test. There is no `agentStep()` export and this file does not add one: the point
 * is that a step whose `run` calls `runDurable` is all it takes, and that the agent's runId must be
 * DERIVED from the workflow's step identity so a replay of the same step replays the same agent run
 * rather than starting a fresh one.
 */
function agentStep(id: string, opts: { model: () => any; tools?: any; prompt: string }) {
  return step(id, async (input: unknown, ctx: StepCtx) => {
    const res: any = await runDurable({
      // `keyPrefix` is what the workflow uses to namespace nested steps; carrying it into the agent's
      // runId is what keeps a nested agent from colliding with an identically-named one elsewhere.
      runId: `${ctx.keyPrefix ?? ''}${ctx.runId}:${id}`,
      journal: ctx.journal as never,
      model: opts.model(),
      tools: opts.tools,
      prompt: opts.prompt,
    } as never);
    return { ...(input as object), text: res.text as string };
  });
}

describe('an agent as a workflow step', () => {
  it('runs inside the graph and its output flows to the next step', async () => {
    const journal = new InMemoryJournal();
    const wf = workflow<{ ticket: string }>()
      .then(agentStep('triage', { model: () => createMockModel(async () => finalTextResult('refund')), prompt: 'classify' }))
      .then(step('route', async (i: any) => ({ ...i, queue: i.text === 'refund' ? 'billing' : 'general' })));

    const out: any = await wf.run({ ticket: 't-1' }, { runId: 'wf-1', journal: journal as never });
    expect(out.text).toBe('refund');
    expect(out.queue, 'the graph branched on what the agent decided').toBe('billing');
  });

  it('a completed agent step replays from the workflow journal without re-entering the agent', async () => {
    // Worth stating what this does and does NOT prove, because the first version of this file claimed
    // more. A COMPLETED step is replayed by the workflow from its own record, so `run` is never
    // called again and `runDurable` is never reached. The exactly-once here comes from the graph
    // alone — the agent's dedup is not exercised at all. Measured: replacing the derived runId with
    // a random one leaves this test green. The case that does exercise it is the next one.
    const journal = new InMemoryJournal();
    let charges = 0;
    let modelCalls = 0;
    const model = () => {
      let call = 0;
      return createMockModel(async () => {
        modelCalls++;
        call++;
        if (call === 1) return toolCallResult('charge', 'c-1', { amount: 40 });
        return finalTextResult('charged');
      });
    };
    const tools = { charge: { execute: async () => { charges++; return { ok: true }; } } };
    const build = () => workflow<{ order: string }>()
      .then(agentStep('bill', { model, tools, prompt: 'charge the order' }))
      .then(step('notify', async (i: any) => i));

    const first: any = await build().run({ order: 'o-9' }, { runId: 'wf-2', journal: journal as never });
    expect(first.text).toBe('charged');
    expect(charges, 'the tool ran on the first pass').toBe(1);
    const modelCallsAfterFirst = modelCalls;

    // Same runId, same journal: a resume after a crash, from the top.
    const second: any = await build().run({ order: 'o-9' }, { runId: 'wf-2', journal: journal as never });
    expect(second.text, 'the replay returns the recorded answer').toBe('charged');
    expect(charges, 'the side effect did NOT run a second time through the graph').toBe(1);
    expect(modelCalls, 'the provider was not called again either').toBe(modelCallsAfterFirst);
  });

  it('a crash INSIDE the agent step does not re-charge on resume — this is where the nesting matters', async () => {
    // The case the graph cannot cover. The tool executes, then the step dies before the workflow has
    // recorded anything, so there is no step record to replay: on resume the workflow re-enters `run`
    // and calls `runDurable` again. Whether the card is charged twice now depends entirely on the
    // agent recognising its OWN journal — which it can only do if the runId is derived from the step
    // identity rather than made up per call. That is the load-bearing line in `agentStep`, and this
    // is the test that holds it: point the runId at something random and this goes red.
    const journal = new InMemoryJournal();
    let charges = 0;
    let pass = 0;
    const model = () => {
      let call = 0;
      return createMockModel(async () => {
        call++;
        if (call === 1) return toolCallResult('charge', 'c-1', { amount: 40 });
        // First pass: die AFTER the tool ran, BEFORE the turn could finish. Second pass: finish.
        if (pass === 1) throw new Error('process died mid-turn');
        return finalTextResult('charged');
      });
    };
    const tools = { charge: { execute: async () => { charges++; return { ok: true }; } } };
    const build = () => workflow<{ order: string }>()
      .then(agentStep('bill', { model, tools, prompt: 'charge the order' }));

    pass = 1;
    await expect(
      build().run({ order: 'o-7' }, { runId: 'wf-crash', journal: journal as never }),
    ).rejects.toThrow(/died mid-turn/);
    expect(charges, 'the tool did run before the crash — otherwise this proves nothing').toBe(1);

    pass = 2;
    const out: any = await build().run({ order: 'o-7' }, { runId: 'wf-crash', journal: journal as never });
    expect(out.text).toBe('charged');
    expect(charges, 'resume replayed the tool from the agent journal instead of re-charging').toBe(1);
  });

  it('two agent steps in one graph keep separate journal spaces', async () => {
    // Both steps run the same tool name with the same args. Without distinct runIds the second would
    // replay the first's record and silently return its answer.
    const journal = new InMemoryJournal();
    const seen: string[] = [];
    const model = (answer: string) => () => createMockModel(async () => finalTextResult(answer));
    const wf = workflow<{ x: number }>()
      .then(agentStep('first', { model: model('one'), prompt: 'a' }))
      .then(step('record-1', async (i: any) => { seen.push(i.text); return i; }))
      .then(agentStep('second', { model: model('two'), prompt: 'b' }))
      .then(step('record-2', async (i: any) => { seen.push(i.text); return i; }));

    await wf.run({ x: 1 }, { runId: 'wf-3', journal: journal as never });
    expect(seen, 'each agent step produced its own answer').toEqual(['one', 'two']);

    const keys = await (journal as any).listKeys('');
    expect(keys.some((k: string) => k.startsWith('wf-3:first:')), 'the first agent wrote under its own step id').toBe(true);
    expect(keys.some((k: string) => k.startsWith('wf-3:second:')), 'and the second under its own').toBe(true);
  });

  it('the agent\'s own args-based dedup still works under a workflow prefix', async () => {
    // `idempotency: 'args'` is the guard for the model re-planning the same action under a new
    // toolCallId. It keys off the journal, so it has to keep working when those keys sit beneath a
    // workflow's namespace rather than at the root.
    const journal = new InMemoryJournal();
    let charges = 0;
    const model = () => {
      let call = 0;
      return createMockModel(async () => {
        call++;
        if (call === 1) return toolCallResult('charge', 'c-1', { amount: 20 });
        if (call === 2) return toolCallResult('charge', 'c-2', { amount: 20 }); // same args, NEW id
        return finalTextResult('done');
      });
    };
    const tools = { charge: { idempotency: 'args' as const, execute: async () => { charges++; return { ok: true }; } } };

    await workflow<{ o: string }>()
      .then(agentStep('bill', { model, tools, prompt: 'charge' }))
      .run({ o: 'o-1' }, { runId: 'wf-4', journal: journal as never });

    expect(charges, 'the re-planned duplicate collapsed into one execution inside the graph').toBe(1);
  });

  it('an agent step inside .foreach runs once per item, and replays each', async () => {
    // Fan-out is the case a plain agent loop cannot bound: asking a model to "do this for all 3"
    // gives a different number of tool calls each run. foreach is exactly 3, and each item's agent
    // gets its own journal space.
    const journal = new InMemoryJournal();
    let runs = 0;
    const model = () => createMockModel(async () => { runs++; return finalTextResult('ok'); });

    // NOTE the asymmetry, which is a genuine finding and not a detail of this test: `.foreach` takes
    // `(itemsOf, run)` where `run` is a FUNCTION, not a `Step`. So `agentStep` above cannot be reused
    // here — the agent has to be invoked inline. Passing a Step as the first argument type-checks
    // through a cast and then silently does nothing: `itemsOf` is not callable, `list.length` is
    // undefined, and the loop body never runs. That is how the first version of this test "passed"
    // with zero agent runs.
    const wf = workflow<{ ids: string[] }>()
      .map((i) => i.ids)
      .foreach<string, { id: string; text: string }>(
        (ids) => ids,
        async (id, index, ctx) => {
          const res: any = await runDurable({
            runId: `${ctx.keyPrefix ?? ''}${ctx.runId}:handle:${index}`,
            journal: ctx.journal as never,
            model: model(),
            prompt: 'handle one',
          } as never);
          return { id, text: res.text as string };
        },
      );

    await wf.run({ ids: ['a', 'b', 'c'] }, { runId: 'wf-5', journal: journal as never });
    expect(runs, 'exactly one agent run per item, not a number the model chose').toBe(3);

    await wf.run({ ids: ['a', 'b', 'c'] }, { runId: 'wf-5', journal: journal as never });
    expect(runs, 'the second pass replayed all three from the journal').toBe(3);
  });
});

// Referenced so an unused-import lint cannot fire on the shape helper above.
void usage;
