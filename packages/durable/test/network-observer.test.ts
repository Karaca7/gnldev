// P2-network (AUDIT-R2 GAP 5/7): observer callback visibility into runNetwork's routing
// loop. Determinism is NOT changed — the router's generateText stays blocking/CAS-frozen; these tests
// verify (1) event ORDER on a fresh run, (2) full REPLAY on resume with cached flags and ZERO
// model/agent re-execution, (3) a throwing observer never breaks the run, and (4) delegation veto
// (skip + replaceResult) both live and replayed deterministically on resume.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runNetwork, netKeys, type NetworkTarget, type NetworkObserver } from '../src/network.js';
import { createMockModel, finalTextResult } from './mock.js';

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

function fakeTarget(text: string, counter?: { runs: number }): NetworkTarget {
  return {
    description: `agent producing ${text}`,
    run: async () => {
      if (counter) counter.runs++;
      return { text };
    },
  };
}

describe('runNetwork observer', () => {
  it('fires in order on a fresh run: routeStart→routeDecision→agentStart→agentFinish per iter→final', async () => {
    const journal = new InMemoryJournal();
    const events: string[] = [];
    const observer: NetworkObserver = {
      onRouteStart: (i) => { events.push(`routeStart:${i}`); },
      onRouteDecision: (i, d, fromCache) => { events.push(`routeDecision:${i}:${d.action}:${fromCache}`); },
      onAgentStart: (i, agent) => { events.push(`agentStart:${i}:${agent}`); },
      onAgentFinish: (i, agent, res) => { events.push(`agentFinish:${i}:${agent}:${'cached' in res ? 'cached' : res.text}`); },
      onFinal: (text) => { events.push(`final:${text}`); },
    };
    const res = await runNetwork({
      runId: 'o1',
      journal,
      routerModel: scriptedRouter([route('ara', 'find'), route('yaz', 'summarize'), final('done')]),
      agents: { ara: fakeTarget('sources'), yaz: fakeTarget('summary') },
      task: 'go',
      observer,
    });
    expect(res.text).toBe('done');
    expect(events).toEqual([
      'routeStart:0',
      'routeDecision:0:route:false',
      'agentStart:0:ara',
      'agentFinish:0:ara:sources',
      'routeStart:1',
      'routeDecision:1:route:false',
      'agentStart:1:yaz',
      'agentFinish:1:yaz:summary',
      'routeStart:2',
      'routeDecision:2:final:false',
      'final:done',
    ]);
  });

  it('on resume, all events re-fire with cached/fromCache=true and NO model/agent re-execution', async () => {
    const journal = new InMemoryJournal();
    const routerCalls = { calls: 0 };
    const agentRuns = { runs: 0 };
    const opts = {
      runId: 'o2',
      journal,
      agents: { a: fakeTarget('result A', agentRuns) },
      task: 'task',
    };
    const firstEvents: string[] = [];
    const firstObserver: NetworkObserver = {
      onRouteStart: (i) => firstEvents.push(`routeStart:${i}`),
      onRouteDecision: (i, d, c) => firstEvents.push(`routeDecision:${i}:${c}`),
      onAgentStart: (i, a, _t, c) => firstEvents.push(`agentStart:${i}:${a}:${!!c}`),
      onAgentFinish: (i, a, r) => firstEvents.push(`agentFinish:${i}:${a}:${'cached' in r ? 'cached' : r.text}`),
      onFinal: (t) => firstEvents.push(`final:${t}`),
    };
    await runNetwork({ ...opts, routerModel: scriptedRouter([route('a', 't1'), final('answer')], routerCalls), observer: firstObserver });
    expect(routerCalls.calls).toBe(2);
    expect(agentRuns.runs).toBe(1);

    const resumeEvents: string[] = [];
    const resumeObserver: NetworkObserver = {
      onRouteStart: (i) => resumeEvents.push(`routeStart:${i}`),
      onRouteDecision: (i, d, c) => resumeEvents.push(`routeDecision:${i}:${c}`),
      onAgentStart: (i, a, _t, c) => resumeEvents.push(`agentStart:${i}:${a}:${!!c}`),
      onAgentFinish: (i, a, r) => resumeEvents.push(`agentFinish:${i}:${a}:${'cached' in r ? 'cached' : r.text}`),
      onFinal: (t) => resumeEvents.push(`final:${t}`),
    };
    // Even if a fresh router WOULD answer differently, the frozen path wins — no new model call happens.
    const second = await runNetwork({ ...opts, routerModel: scriptedRouter([final('ANOTHER answer')], routerCalls), observer: resumeObserver });
    expect(second.text).toBe('answer');
    expect(routerCalls.calls).toBe(2); // no new router call
    expect(agentRuns.runs).toBe(1); // sub-agent did not rerun

    expect(resumeEvents).toEqual([
      'routeStart:0',
      'routeDecision:0:true', // fromCache
      'agentStart:0:a:true', // fromCache
      'agentFinish:0:a:cached',
      'routeStart:1',
      'routeDecision:1:true',
      'final:answer',
    ]);
  });

  it('throwing observer callbacks never break the run', async () => {
    const journal = new InMemoryJournal();
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const observer: NetworkObserver = {
        onRouteStart: () => { throw new Error('boom-routeStart'); },
        onRouteDecision: () => { throw new Error('boom-routeDecision'); },
        onAgentStart: () => { throw new Error('boom-agentStart'); },
        onAgentFinish: () => { throw new Error('boom-agentFinish'); },
        onFinal: () => { throw new Error('boom-final'); },
      };
      const res = await runNetwork({
        runId: 'o3',
        journal,
        routerModel: scriptedRouter([route('a', 't1'), final('done')]),
        agents: { a: fakeTarget('x') },
        task: 'g',
        observer,
      });
      expect(res.text).toBe('done');
      expect(res.steps).toHaveLength(1);
      expect(warnings.length).toBeGreaterThanOrEqual(5); // one warn per thrown hook
    } finally {
      console.warn = originalWarn;
    }
  });

  it('async observer callbacks (Promise-returning) are awaited without breaking the flow', async () => {
    const journal = new InMemoryJournal();
    const events: string[] = [];
    const observer: NetworkObserver = {
      onRouteStart: async (i) => { await Promise.resolve(); events.push(`routeStart:${i}`); },
      onFinal: async (t) => { await Promise.resolve(); events.push(`final:${t}`); },
    };
    const res = await runNetwork({
      runId: 'o4', journal,
      routerModel: scriptedRouter([final('ok')]),
      agents: { a: fakeTarget('x') }, task: 'g',
      observer,
    });
    expect(res.text).toBe('ok');
    expect(events).toEqual(['routeStart:0', 'final:ok']);
  });
});

describe('runNetwork observer — delegation veto', () => {
  it('onAgentStart returning {skip:true} prevents sub-agent execution and feeds replaceResult to the router', async () => {
    const journal = new InMemoryJournal();
    const agentRuns = { runs: 0 };
    const target = fakeTarget('should never see this', agentRuns);
    const seenTasks: string[] = [];
    const router = createMockModel(async ({ prompt }: any) => {
      const text = JSON.stringify(prompt);
      seenTasks.push(text);
      // First turn → route to 'a'; once the vetoed result shows up in history → final.
      if (text.includes('vetoed instead')) return finalTextResult(final('used veto result'));
      return finalTextResult(route('a', 'do the risky thing'));
    });
    const observer: NetworkObserver = {
      onAgentStart: (_i, agent, task) => {
        expect(agent).toBe('a');
        expect(task).toBe('do the risky thing');
        return { skip: true, replaceResult: 'vetoed instead of running' };
      },
    };
    const res = await runNetwork({
      runId: 'v1', journal, routerModel: router,
      agents: { a: target }, task: 'g', observer,
    });
    expect(agentRuns.runs).toBe(0); // sub-agent NEVER ran
    expect(res.steps).toEqual([{ i: 0, agent: 'a', task: 'do the risky thing', text: 'vetoed instead of running' }]);
    expect(res.text).toBe('used veto result');
    expect(await journal.get(netKeys.veto('v1', 0))).toEqual({ v: { replaceResult: 'vetoed instead of running' } });
  });

  it('veto with no replaceResult defaults to empty string', async () => {
    const journal = new InMemoryJournal();
    const observer: NetworkObserver = { onAgentStart: () => ({ skip: true }) };
    const res = await runNetwork({
      runId: 'v2', journal,
      routerModel: scriptedRouter([route('a', 't1'), final('f')]),
      agents: { a: fakeTarget('x') }, task: 'g', observer,
    });
    expect(res.steps[0]!.text).toBe('');
  });

  it('veto replays deterministically on resume: decision callback NOT re-invoked, notification fires with cached flag, no re-execution', async () => {
    const journal = new InMemoryJournal();
    const agentRuns = { runs: 0 };
    const routerCalls = { calls: 0 };
    const opts = {
      runId: 'v3',
      journal,
      agents: { a: fakeTarget('result A', agentRuns) },
      task: 'task',
    };
    const firstObserver: NetworkObserver = {
      onAgentStart: () => ({ skip: true, replaceResult: 'first veto' }),
    };
    const first = await runNetwork({ ...opts, routerModel: scriptedRouter([route('a', 't1'), final('answer')], routerCalls), observer: firstObserver });
    expect(first.steps).toEqual([{ i: 0, agent: 'a', task: 't1', text: 'first veto' }]);
    expect(agentRuns.runs).toBe(0);

    // Resume: even though this callback would return a DIFFERENT veto (or no veto at all), the frozen
    // veto from the journal wins — the callback's decision is NOT solicited/used, only the fromCache
    // notification fires.
    let decisionCalls = 0;
    const notifications: Array<{ agent: string; task: string; fromCache: boolean | undefined }> = [];
    const resumeObserver: NetworkObserver = {
      onAgentStart: (_i, agent, task, fromCache) => {
        notifications.push({ agent, task, fromCache });
        if (!fromCache) {
          decisionCalls++;
          return { skip: true, replaceResult: 'SHOULD NOT BE USED' };
        }
        // fromCache === true: return value must be ignored by runNetwork — return something that
        // WOULD change behavior if it were consulted, to prove it isn't.
        return { skip: true, replaceResult: 'IGNORED ON REPLAY' };
      },
    };
    const second = await runNetwork({ ...opts, routerModel: scriptedRouter([final('ANOTHER')], routerCalls), observer: resumeObserver });
    expect(second.steps).toEqual([{ i: 0, agent: 'a', task: 't1', text: 'first veto' }]); // unchanged
    expect(second.text).toBe('answer'); // frozen route decision wins too
    expect(agentRuns.runs).toBe(0); // sub-agent never ran, even on resume
    expect(decisionCalls).toBe(0); // the decision-branch of the callback was never taken
    expect(notifications).toEqual([{ agent: 'a', task: 't1', fromCache: true }]); // notified with cached flag
  });

  it('veto that crashes BEFORE the step freezes (only the veto record exists) replays the same veto without re-asking', async () => {
    const journal = new InMemoryJournal();
    // Simulate the crash window manually: journal a veto record directly, WITHOUT a step record,
    // exactly as runNetwork would leave it if the process died between claim(vetoKey) and claim(stepKey).
    await journal.put(netKeys.route('v4', 0), { v: { action: 'route', agent: 'a', task: 't1' } });
    await journal.put(netKeys.veto('v4', 0), { v: { replaceResult: 'crash-window veto' } });

    let decisionCalls = 0;
    const observer: NetworkObserver = {
      onAgentStart: (_i, _a, _t, fromCache) => {
        if (!fromCache) { decisionCalls++; return { skip: true, replaceResult: 'SHOULD NOT BE USED' }; }
        return undefined;
      },
    };
    const agentRuns = { runs: 0 };
    const res = await runNetwork({
      runId: 'v4', journal,
      routerModel: scriptedRouter([final('done')]),
      agents: { a: fakeTarget('x', agentRuns) }, task: 'g', observer,
    });
    expect(res.steps).toEqual([{ i: 0, agent: 'a', task: 't1', text: 'crash-window veto' }]);
    expect(agentRuns.runs).toBe(0);
    expect(decisionCalls).toBe(0); // the decision branch of the callback was never taken — fromCache was true
  });

  it('returning a non-veto value (or undefined) from onAgentStart lets the sub-agent run normally', async () => {
    const journal = new InMemoryJournal();
    const agentRuns = { runs: 0 };
    const observer: NetworkObserver = { onAgentStart: () => undefined };
    const res = await runNetwork({
      runId: 'v5', journal,
      routerModel: scriptedRouter([route('a', 't1'), final('f')]),
      agents: { a: fakeTarget('real result', agentRuns) }, task: 'g', observer,
    });
    expect(agentRuns.runs).toBe(1);
    expect(res.steps[0]!.text).toBe('real result');
  });
});
