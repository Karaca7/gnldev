// Dynamic multi-agent routing (network.ts) — determinism guarantees:
// routing decision is CAS-frozen (router not called on resume), step result is frozen (sub-agent
// skipped), iteration cap (forced final), single retry on malformed router output, registry integration.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runNetwork, getNetworkTrace, netKeys, type NetworkTarget } from '../src/network.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

/** Router mock that returns the given texts in sequence; counter tracks the number of calls. */
function scriptedRouter(answers: string[], counter?: { calls: number }) {
  let i = 0;
  return createMockModel(async () => {
    if (counter) counter.calls++;
    const text = answers[Math.min(i, answers.length - 1)]!;
    i++;
    return finalTextResult(text);
  });
}

const route = (agent: string, task: string) => JSON.stringify({ action: 'route', agent, task });
const final = (answer: string) => JSON.stringify({ action: 'final', answer });

/** Fake target that returns a fixed text; counts how many times it ran. */
function fakeTarget(text: string, counter?: { runs: number }): NetworkTarget {
  return {
    description: `agent producing ${text}`,
    run: async () => {
      if (counter) counter.runs++;
      return { text };
    },
  };
}

describe('runNetwork', () => {
  it('router route→final flow: steps run, final answer is returned', async () => {
    const journal = new InMemoryJournal();
    const res = await runNetwork({
      runId: 'r1',
      journal,
      routerModel: scriptedRouter([route('ara', 'find source'), route('yaz', 'summarize'), final('done: summary')]),
      agents: { ara: fakeTarget('3 sources found'), yaz: fakeTarget('summary ready') },
      task: 'research and summarize the topic',
    });
    expect(res.text).toBe('done: summary');
    expect(res.steps.map((s) => s.agent)).toEqual(['ara', 'yaz']);
    expect(res.iterations).toBe(2);
    expect(res.stopped).toBeUndefined();
  });

  it('resume: decisions and steps come from the journal — router and agent are NEVER called', async () => {
    const journal = new InMemoryJournal();
    const routerCalls = { calls: 0 };
    const agentRuns = { runs: 0 };
    const opts = {
      runId: 'r2',
      journal,
      agents: { a: fakeTarget('result A', agentRuns) },
      task: 'task',
    };
    const first = await runNetwork({ ...opts, routerModel: scriptedRouter([route('a', 't1'), final('answer')], routerCalls) });
    expect(routerCalls.calls).toBe(2);
    expect(agentRuns.runs).toBe(1);

    // Second call (resume): even with a router that would give a DIFFERENT answer, the frozen path is followed.
    const second = await runNetwork({ ...opts, routerModel: scriptedRouter([final('ANOTHER answer')], routerCalls) });
    expect(second.text).toBe('answer');
    expect(second.steps).toEqual(first.steps);
    expect(routerCalls.calls).toBe(2); // NO new router call
    expect(agentRuns.runs).toBe(1); // sub-agent did NOT rerun
  });

  it('resume mid-crash: completed step is skipped, continues from where it left off', async () => {
    const journal = new InMemoryJournal();
    const agentRuns = { runs: 0 };
    const agents = { a: fakeTarget('result A', agentRuns) };
    // First attempt: router blows up after step 0 (crash simulation).
    let n = 0;
    const crashing = createMockModel(async () => {
      n++;
      if (n === 1) return finalTextResult(route('a', 't1'));
      throw new Error('boom');
    });
    await expect(runNetwork({ runId: 'r3', journal, routerModel: crashing, agents, task: 'g' })).rejects.toThrow();
    expect(agentRuns.runs).toBe(1);

    // Resume: step 0's decision+result come from the journal; router is called only for the new round.
    const calls = { calls: 0 };
    const res = await runNetwork({
      runId: 'r3', journal, agents, task: 'g',
      routerModel: scriptedRouter([final('done')], calls),
    });
    expect(res.text).toBe('done');
    expect(res.steps).toHaveLength(1);
    expect(agentRuns.runs).toBe(1); // step 0 did not rerun
    expect(calls.calls).toBe(1); // only round 1's decision
  });

  it('once maxIterations is exhausted, the router is forced to final and stopped is marked', async () => {
    const journal = new InMemoryJournal();
    // Router always says route; once the force-final prompt arrives it returns final.
    const router = createMockModel(async ({ prompt }: any) => {
      const text = JSON.stringify(prompt);
      if (text.includes('Iteration limit reached')) return finalTextResult(final('forced summary'));
      return finalTextResult(route('a', 'continue'));
    });
    const res = await runNetwork({
      runId: 'r4', journal, routerModel: router,
      agents: { a: fakeTarget('x') }, task: 'g', maxIterations: 2,
    });
    expect(res.stopped).toBe('max-iterations');
    expect(res.iterations).toBe(2);
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('forced summary');
  });

  it('malformed JSON / unknown agent → error is fed back and retried exactly ONCE', async () => {
    const journal = new InMemoryJournal();
    const calls = { calls: 0 };
    const res = await runNetwork({
      runId: 'r5', journal,
      routerModel: scriptedRouter(['this is not json', route('a', 't'), final('ok')], calls),
      agents: { a: fakeTarget('x') }, task: 'g',
    });
    expect(res.text).toBe('ok');
    expect(calls.calls).toBe(3); // 1 malformed + 1 retry + 1 final

    // If both attempts pick an invalid agent, a clear error is thrown.
    await expect(
      runNetwork({
        runId: 'r6', journal,
        routerModel: scriptedRouter([route('yok', 't'), route('yok', 't')]),
        agents: { a: fakeTarget('x') }, task: 'g',
      }),
    ).rejects.toThrow(/unknown agent|could not produce a valid decision/);
  });

  it('getNetworkTrace: route decisions + steps come out ordered from the journal', async () => {
    const journal = new InMemoryJournal();
    await runNetwork({
      runId: 'r7', journal,
      routerModel: scriptedRouter([route('a', 't1'), route('a', 't2'), final('f')]),
      agents: { a: fakeTarget('x') }, task: 'g',
    });
    const trace = await getNetworkTrace(journal, 'r7');
    expect(trace.routes.map((r) => r.i)).toEqual([0, 1, 2]);
    expect(trace.routes[2]!.decision).toEqual({ action: 'final', answer: 'f' });
    expect(trace.steps.map((s) => s.i)).toEqual([0, 1]);
    expect(trace.steps[1]!.task).toBe('t2');
  });

  it('net: keys are invisible to parseJournalKey (readRun stays clean)', async () => {
    const journal = new InMemoryJournal();
    await runNetwork({
      runId: 'r8', journal,
      routerModel: scriptedRouter([final('f')]),
      agents: { a: fakeTarget('x') }, task: 'g',
    });
    expect(await journal.readRun('r8')).toEqual([]); // only :net: keys exist, no model/tool
    expect(await journal.listKeys(netKeys.route('r8', 0))).toHaveLength(1);
  });
});

describe('interrupts and resilient parse/fallback', () => {
  it('when a sub-agent is suspended the step does NOT FREEZE, the interrupt propagates up; after approval it finishes where it left off', async () => {
    const journal = new InMemoryJournal();
    const routerCalls = { calls: 0 };
    let approved = false;
    let runs = 0;
    const target: NetworkTarget = {
      run: async () => {
        runs++;
        return approved
          ? { text: 'approved result' }
          : { text: '', interrupts: [{ toolCallId: 'tc1', toolName: 'pay', args: {} } as any] };
      },
    };
    const opts = { runId: 's1', journal, agents: { a: target }, task: 'g' };

    // 1st call: sub-agent is suspended → returns suspended, step does NOT FREEZE into the journal.
    const r1 = await runNetwork({ ...opts, routerModel: scriptedRouter([route('a', 't1')], routerCalls) });
    expect(r1.suspended).toEqual({ i: 0, agent: 'a', task: 't1' });
    expect(r1.interrupts).toHaveLength(1);
    expect(r1.steps).toHaveLength(0);
    expect(await journal.get(netKeys.step('s1', 0))).toBeUndefined(); // empty result did NOT PERSIST

    // Approval given → retry with the same runId: the route decision is frozen (the router does not rerun
    // for round-0; the FRESH router's FIRST answer is therefore consumed as round-1's final decision),
    // the sub-agent is called again (resumes from its own journal) and the network completes.
    approved = true;
    const callsBefore = routerCalls.calls;
    const r2 = await runNetwork({ ...opts, routerModel: scriptedRouter([final('done')], routerCalls) });
    expect(r2.text).toBe('done');
    expect(r2.steps).toEqual([{ i: 0, agent: 'a', task: 't1', text: 'approved result' }]);
    expect(r2.suspended).toBeUndefined();
    expect(runs).toBe(2); // the suspended attempt + the approved completion
    expect(routerCalls.calls - callsBefore).toBe(1); // only the final decision — round-0's route came from the journal
  });

  it('if the router echoes two JSON templates at once, the FIRST balanced object is taken (does not crash)', async () => {
    const journal = new InMemoryJournal();
    const echo = `${route('a', 'task with {nested} included')}\n${final('wrong')}`;
    const res = await runNetwork({
      runId: 'p1', journal,
      routerModel: scriptedRouter([echo, final('correct')]),
      agents: { a: fakeTarget('x') }, task: 'g',
    });
    // The first object is 'route' → step runs; second round is final. With a greedy regex the parse would
    // have blown up and fallen into retry.
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]!.task).toBe('task with {nested} included');
    expect(res.text).toBe('correct');
  });

  it('if the cap is hit and the router CANNOT BE FORCED to final, the last step\'s text is returned instead of crashing (best-effort)', async () => {
    const journal = new InMemoryJournal();
    // Router says route in EVERY case — including force-final attempts (parseDecision throws on force).
    const stubborn = createMockModel(async () => finalTextResult(route('a', 'continue')));
    const res = await runNetwork({
      runId: 'f1', journal, routerModel: stubborn,
      agents: { a: fakeTarget('last step text') }, task: 'g', maxIterations: 2,
    });
    expect(res.stopped).toBe('max-iterations');
    expect(res.text).toBe('last step text'); // NOT an exception
    expect(res.steps).toHaveLength(2);
  });
});

describe('createGnl runNetwork integration', () => {
  it('routes to registered agents; sub-agent runs durably under a nested runId', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: {
        uzman: {
          description: 'domain expert',
          model: createMockModel(async () => finalTextResult('expert answer')),
        },
      },
      networks: {
        destek: {
          router: scriptedRouter([route('uzman', 'answer the question'), final('result: expert answer')]),
          agents: ['uzman'],
        },
      },
    });
    const res = await gnl.runNetwork('destek', { runId: 'n1', task: 'question' });
    expect(res.text).toBe('result: expert answer');
    expect(res.steps).toEqual([{ i: 0, agent: 'uzman', task: 'answer the question', text: 'expert answer' }]);
    // The sub-agent's own journal was created under a deterministic nested runId.
    const nested = await journal.readRun(netKeys.nestedRunId('n1', 0));
    expect(nested.length).toBeGreaterThan(0);
    expect(gnl.listNetworks()).toEqual([{ name: 'destek', agents: ['uzman'], maxIterations: 6 }]);
  });

  it('unregistered network / unregistered agent → early and clear error', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: {}, networks: { n: { router: 'openai/x', agents: ['yok'] } } });
    await expect(gnl.runNetwork('bilinmez', { runId: 'x', task: 't' })).rejects.toThrow(/not registered/);
    await expect(gnl.runNetwork('n', { runId: 'x', task: 't' })).rejects.toThrow(/'yok' is not registered/);
  });
});
