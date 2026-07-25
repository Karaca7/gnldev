// P1.1 (AUDIT-R2) — trajectory/tool-call scorer. createTrajectoryScorer is pure (no model
// call, no journal I/O) — tested directly against hand-built tool-call sequences here; scoreTrajectory/
// trajectoryScorerFor (the journal-reading variants) are tested against a real runDurable trace so the
// buildDecisionSequence integration is exercised end-to-end too.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { createTrajectoryScorer, scoreTrajectory, trajectoryScorerFor, scoreRun } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from '../../durable/test/mock.js';

describe('@gnldev/evals createTrajectoryScorer — ordered/required/forbidden/budget', () => {
  it('expectedTools: full ordered subsequence match → score 1', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['search', 'fetch', 'summarize'] });
    const r = scorer.score({ output: '', toolCalls: ['search', 'fetch', 'summarize'] });
    expect(r).not.toBeInstanceOf(Promise);
    expect((r as any).score).toBe(1);
  });

  it('expectedTools: subsequence match with extra calls interleaved → still score 1 (order preserved)', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['search', 'fetch'] });
    const r: any = scorer.score({ output: '', toolCalls: ['log', 'search', 'noop', 'fetch', 'cleanup'] });
    expect(r.score).toBe(1);
  });

  it('expectedTools: shuffled order → partial score, not 1', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['search', 'fetch', 'summarize'] });
    // fetch before search: 'search' never found before end since it appears AFTER 'fetch' positionally,
    // the greedy walk only advances on 'search' first, and 'search' does occur later — but 'fetch'
    // required next must come strictly after that occurrence.
    const r: any = scorer.score({ output: '', toolCalls: ['fetch', 'summarize', 'search'] });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('forbiddenTools: hit → score degraded below 1, reason mentions VIOLATION', () => {
    const scorer = createTrajectoryScorer({ forbiddenTools: ['deleteAll'] });
    const r: any = scorer.score({ output: '', toolCalls: ['search', 'deleteAll', 'fetch'] });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('VIOLATION');
  });

  it('forbiddenTools: none hit → score 1', () => {
    const scorer = createTrajectoryScorer({ forbiddenTools: ['deleteAll'] });
    const r: any = scorer.score({ output: '', toolCalls: ['search', 'fetch'] });
    expect(r.score).toBe(1);
  });

  it('maxToolCalls: within budget → score 1', () => {
    const scorer = createTrajectoryScorer({ maxToolCalls: 5 });
    const r: any = scorer.score({ output: '', toolCalls: ['a', 'b', 'c'] });
    expect(r.score).toBe(1);
  });

  it('maxToolCalls: exceeded → score degraded proportionally, reason mentions EXCEEDED', () => {
    const scorer = createTrajectoryScorer({ maxToolCalls: 2 });
    const r: any = scorer.score({ output: '', toolCalls: ['a', 'b', 'c', 'd'] });
    expect(r.score).toBeCloseTo(2 / 4);
    expect(r.reason).toContain('EXCEEDED');
  });

  it('requiredTools: all present in any order → score 1', () => {
    const scorer = createTrajectoryScorer({ requiredTools: ['a', 'b'] });
    const r: any = scorer.score({ output: '', toolCalls: ['b', 'x', 'a'] });
    expect(r.score).toBe(1);
  });

  it('requiredTools: one missing → partial score, reason lists it', () => {
    const scorer = createTrajectoryScorer({ requiredTools: ['a', 'b'] });
    const r: any = scorer.score({ output: '', toolCalls: ['a'] });
    expect(r.score).toBe(0.5);
    expect(r.reason).toContain('missing [b]');
  });

  it('weighted composite: combines multiple dimensions with configured weights', () => {
    const scorer = createTrajectoryScorer({
      expectedTools: ['a', 'b'],
      forbiddenTools: ['x'],
      weights: { order: 3, forbidden: 1 },
    });
    // order: full match (1.0), forbidden: hit (0.0) → composite = (1*3 + 0*1) / 4 = 0.75
    const r: any = scorer.score({ output: '', toolCalls: ['a', 'x', 'b'] });
    expect(r.score).toBeCloseTo(0.75);
  });

  it('no constraints configured → vacuously 1', () => {
    const scorer = createTrajectoryScorer({});
    const r: any = scorer.score({ output: '', toolCalls: ['anything'] });
    expect(r.score).toBe(1);
  });

  it('missing toolCalls/decisionPoints on sample → score 0 with a clear reason (not silent pass)', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['a'] });
    const r: any = scorer.score({ output: '' });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('toolCalls');
  });

  it('accepts sample.decisionPoints (raw DecisionPoint[]) as an alternative to toolCalls', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['search', 'fetch'] });
    const r: any = scorer.score({
      output: '',
      decisionPoints: [
        { step: 0, kind: 'model', value: {} },
        { step: 0, kind: 'tool', toolName: 'search', value: {} },
        { step: 1, kind: 'tool', toolName: 'fetch', value: {} },
      ],
    });
    expect(r.score).toBe(1);
  });

  it('is deterministic: same sample scored twice → identical result', () => {
    const scorer = createTrajectoryScorer({ expectedTools: ['a', 'b'], maxToolCalls: 3 });
    const sample = { output: '', toolCalls: ['a', 'x', 'b'] };
    const r1: any = scorer.score(sample);
    const r2: any = scorer.score(sample);
    expect(r1).toEqual(r2);
  });
});

// ── journal-integrated variants ─────────────────────────────────────────────

function makeToolModel(steps: { tool?: { name: string; args: unknown }; final?: string }[]) {
  let i = 0;
  return createMockModel(async () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i++;
    if (step.tool) return toolCallResult(step.tool.name, `call-${i}`, step.tool.args);
    return finalTextResult(step.final ?? 'done');
  });
}

describe('@gnldev/evals scoreTrajectory / trajectoryScorerFor — from a real run journal', () => {
  it('scoreTrajectory reads the run, rebuilds the decision sequence, scores tool order', async () => {
    const journal = new InMemoryJournal();
    const model = makeToolModel([
      { tool: { name: 'search', args: { q: 'x' } } },
      { tool: { name: 'fetch', args: { url: 'y' } } },
      { final: 'Done' },
    ]);
    const tools = {
      search: { execute: async () => ({ ok: true }) },
      fetch: { execute: async () => ({ ok: true }) },
    };
    await runDurable({ runId: 'traj-run-1', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'go' });

    const result = await scoreTrajectory(journal, 'traj-run-1', { expectedTools: ['search', 'fetch'] });
    expect(result.score).toBe(1);
  });

  it('trajectoryScorerFor via scoreRun: sample.runId is populated automatically, no extra wiring', async () => {
    const journal = new InMemoryJournal();
    const model = makeToolModel([{ tool: { name: 'forbiddenOp', args: {} } }, { final: 'Done' }]);
    const tools = { forbiddenOp: { execute: async () => ({ ok: true }) } };
    await runDurable({ runId: 'traj-run-2', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'go' });

    const scorer = trajectoryScorerFor(journal, { forbiddenTools: ['forbiddenOp'] });
    const res = await scoreRun(journal, 'traj-run-2', [scorer]);
    expect(res.scores['trajectory']!.score).toBe(0);
    expect(res.scores['trajectory']!.reason).toContain('VIOLATION');
  });

  it('trajectoryScorerFor: sample without runId → score 0, clear reason', async () => {
    const journal = new InMemoryJournal();
    const scorer = trajectoryScorerFor(journal, { expectedTools: ['a'] });
    const r = await scorer.score({ output: 'x' });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('runId');
  });
});
