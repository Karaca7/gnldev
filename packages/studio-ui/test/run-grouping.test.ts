// Pure grouping test: groupRunsByThread (Inspector.tsx — Runs | Threads toggle).
import { describe, it, expect } from 'vitest';
import { groupRunsByThread } from '../src/views/Inspector';
import type { RunSummary } from '../src/api';

function run(runId: string, threadId?: string, status: RunSummary['status'] = 'completed'): RunSummary {
  return { runId, status, modelSteps: 1, toolCalls: 0, threadId };
}

describe('groupRunsByThread (Runs | Threads toggle — pure grouping)', () => {
  it('groups runs that have a threadId by thread', () => {
    const runs = [run('r1', 't-a'), run('r2', 't-a'), run('r3', 't-b')];
    const groups = groupRunsByThread(runs);
    expect(groups).toEqual([
      { threadId: 't-a', runs: [run('r1', 't-a'), run('r2', 't-a')] },
      { threadId: 't-b', runs: [run('r3', 't-b')] },
    ]);
  });

  it('runs without a threadId are collected into a single "ungrouped" (threadId: null) group and placed LAST', () => {
    const runs = [run('r1'), run('r2', 't-a'), run('r3')];
    const groups = groupRunsByThread(runs);
    expect(groups.map((g) => g.threadId)).toEqual(['t-a', null]);
    expect(groups.find((g) => g.threadId === null)?.runs.map((r) => r.runId)).toEqual(['r1', 'r3']);
  });

  it('a run whose threadId equals its own runId (memory-off sentinel) is folded into "ungrouped", not a pseudo-thread', () => {
    // pg-1 self-threads (threadId === runId); t-a is a real multi-turn thread.
    const runs = [run('r1', 't-a'), run('pg-1', 'pg-1'), run('r2', 't-a'), run('pg-2', 'pg-2')];
    const groups = groupRunsByThread(runs);
    expect(groups.map((g) => g.threadId)).toEqual(['t-a', null]);
    expect(groups.find((g) => g.threadId === null)?.runs.map((r) => r.runId)).toEqual(['pg-1', 'pg-2']);
  });

  it('within a group, order matches input order (newest-first is preserved)', () => {
    const runs = [run('newest', 't-a'), run('middle', 't-a'), run('oldest', 't-a')];
    const groups = groupRunsByThread(runs);
    expect(groups[0].runs.map((r) => r.runId)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('group order is stable by first-seen order (ungrouped is always last)', () => {
    const runs = [
      run('a1', 't-a'),
      run('u1'),
      run('b1', 't-b'),
      run('a2', 't-a'),
      run('u2'),
    ];
    const groups = groupRunsByThread(runs);
    expect(groups.map((g) => g.threadId)).toEqual(['t-a', 't-b', null]);
    expect(groups[0].runs.map((r) => r.runId)).toEqual(['a1', 'a2']);
    expect(groups[2].runs.map((r) => r.runId)).toEqual(['u1', 'u2']);
  });

  it('empty input: returns an empty array', () => {
    expect(groupRunsByThread([])).toEqual([]);
  });
});

// Group heading: thread NAME from Playground > shortened id > "ungrouped" (a bare UUID isn't readable).
import { threadGroupLabel } from '../src/views/Inspector';

describe('threadGroupLabel', () => {
  it('uses the title when present (same name as in Playground)', () => {
    expect(threadGroupLabel('c0812495-dd51-4f68', 'New Beginnings')).toBe('New Beginnings');
  });
  it('when there is no title, a long id is shortened; a short id is left as-is', () => {
    expect(threadGroupLabel('c0812495-dd51-4f68-9e02', undefined)).toBe('c0812495-dd5…');
    expect(threadGroupLabel('th-1', undefined)).toBe('th-1');
  });
  it('null → ungrouped (EN default; passed in by the i18n caller, see ThreadGroupRow)', () => {
    expect(threadGroupLabel(null, undefined)).toBe('ungrouped');
  });
});

// Org derivation from runId: `org:<id>:<rest>` prefix (root view) → { org, displayId }.
import { parseOrgFromRunId } from '../src/views/Inspector';

describe('parseOrgFromRunId', () => {
  it('org-prefixed runId → org + prefix-stripped displayId', () => {
    expect(parseOrgFromRunId('org:acme:order-1')).toEqual({ org: 'acme', displayId: 'order-1' });
  });
  it('displayId keeps any remaining colons (only the org: prefix + org id are stripped)', () => {
    expect(parseOrgFromRunId('org:acme:order-1:fork:123')).toEqual({ org: 'acme', displayId: 'order-1:fork:123' });
  });
  it('a plain (unscoped) runId → org null, displayId = runId unchanged', () => {
    expect(parseOrgFromRunId('order-1')).toEqual({ org: null, displayId: 'order-1' });
    expect(parseOrgFromRunId('wf-order-fulfillment-123')).toEqual({ org: null, displayId: 'wf-order-fulfillment-123' });
  });
  it('edge: `org:` with an org id but no rest does NOT match (needs a non-empty displayId)', () => {
    expect(parseOrgFromRunId('org:acme:')).toEqual({ org: null, displayId: 'org:acme:' });
    expect(parseOrgFromRunId('org:acme')).toEqual({ org: null, displayId: 'org:acme' });
    expect(parseOrgFromRunId('org:')).toEqual({ org: null, displayId: 'org:' });
  });
  it('a runId that merely contains "org:" mid-string is not treated as org-scoped', () => {
    expect(parseOrgFromRunId('my-org:run-1')).toEqual({ org: null, displayId: 'my-org:run-1' });
  });
});
