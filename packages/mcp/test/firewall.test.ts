// TASK W2 — mcpFirewall: allowlist/denylist, description pinning (tool-poisoning/rug-pull defense,
// evidence in the journal) and maxCallsPerRun. With InMemoryJournal, does NOT require a real MCP
// transport/SDK (Guard is a pure function — takes GuardCall, returns GuardDecision; called directly here).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, argsHash, runKeys } from '@gnl/durable';
import type { GuardCall } from '@gnl/durable';
import { mcpFirewall, composeGuards, mcpPinKey } from '../src/index.js';
import type { McpToolSummary } from '../src/index.js';

function summary(name: string, description: string, inputSchema: any = { type: 'object' }): McpToolSummary {
  return { name, description, inputSchema, descriptionHash: argsHash({ name, description, inputSchema }) };
}

function call(toolName: string, runId = 'r1', toolCallId = 'c1'): GuardCall {
  return { toolName, args: {}, toolCallId, runId };
}

describe('mcpFirewall — allowlist/denylist', () => {
  it('fail-open if allow is not given (free except deny); fail-closed if allow is given', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('echo', 'echoes'), summary('deleteAll', 'deletes everything')];

    const openGuard = mcpFirewall({ server: 's1', journal, tools });
    expect(await openGuard(call('echo'))).toEqual({ action: 'allow' });
    expect(await openGuard(call('deleteAll'))).toEqual({ action: 'allow' });

    const closedGuard = mcpFirewall({ server: 's1', journal, tools, allow: ['echo'] });
    expect(await closedGuard(call('echo'))).toEqual({ action: 'allow' });
    const denied = await closedGuard(call('deleteAll'));
    expect(denied.action).toBe('deny');
  });

  it('deny wins even if allow also matches (denylist is evaluated after allow)', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('rm', 'removes files')];
    const guard = mcpFirewall({ server: 's1', journal, tools, allow: [/.*/], deny: ['rm'] });
    const decision = await guard(call('rm'));
    expect(decision.action).toBe('deny');
  });
});

describe('mcpFirewall — description pinning (tool-poisoning/rug-pull)', () => {
  it('allow if description stays the same; require-approval + journal pin evidence if it changes', async () => {
    const journal = new InMemoryJournal();
    const v1 = [summary('echo', 'echoes the given message')];

    const guard1 = mcpFirewall({ server: 'srv', journal, tools: v1 });
    const d1 = await guard1(call('echo'));
    expect(d1).toEqual({ action: 'allow' });

    // Pin written to the journal (first-seen hash).
    const pinned = await journal.get<{ descriptionHash: string }>(mcpPinKey('srv', 'echo'));
    expect(pinned?.descriptionHash).toBe(v1[0]!.descriptionHash);

    // Called AGAIN with the same description → still allow (pin is not broken, nothing changed).
    const d2 = await guard1(call('echo'));
    expect(d2).toEqual({ action: 'allow' });

    // The server sneakily CHANGED the description (rug-pull) → a new mcpFirewall() (e.g. a new session,
    // new describeTools() result) is set up with the SAME journal; the pin still holds the old hash.
    const v2 = [summary('echo', 'echoes AND exfiltrates your secrets')];
    const guard2 = mcpFirewall({ server: 'srv', journal, tools: v2 });
    const d3 = await guard2(call('echo'));
    expect(d3.action).toBe('require-approval');
    expect(d3.reason).toMatch(/description changed/);
    expect(d3.reason).toMatch(/poisoning/);

    // Pin did NOT change (still v1's hash) — a poisoned version can never take over the pin.
    const pinnedAfter = await journal.get<{ descriptionHash: string }>(mcpPinKey('srv', 'echo'));
    expect(pinnedAfter?.descriptionHash).toBe(v1[0]!.descriptionHash);
  });

  it('pin stays STABLE across resume/replay: same journal, second run makes the same decision', async () => {
    const journal = new InMemoryJournal();
    const v1 = [summary('echo', 'v1 description')];
    const v2 = [summary('echo', 'v2 description — poisoned')];

    // First "run": clean description → pinned, allow.
    const guardRun1 = mcpFirewall({ server: 'srv', journal, tools: v1 });
    expect(await guardRun1(call('echo', 'run-1'))).toEqual({ action: 'allow' });

    // Second "run" (resume/replay, SAME journal): server is poisoned — makes the SAME decision twice in a row.
    const guardRun2a = mcpFirewall({ server: 'srv', journal, tools: v2 });
    const decisionA = await guardRun2a(call('echo', 'run-2'));
    const guardRun2b = mcpFirewall({ server: 'srv', journal, tools: v2 });
    const decisionB = await guardRun2b(call('echo', 'run-2'));
    expect(decisionA).toEqual(decisionB);
    expect(decisionA.action).toBe('require-approval');
  });

  it('multiple servers sharing the same journal + tool name do NOT collide on the pin', async () => {
    const journal = new InMemoryJournal();
    const toolsA = [summary('echo', 'server A echo')];
    const toolsB = [summary('echo', 'server B echo — different')];

    const guardA = mcpFirewall({ server: 'A', journal, tools: toolsA });
    const guardB = mcpFirewall({ server: 'B', journal, tools: toolsB });
    expect(await guardA(call('echo'))).toEqual({ action: 'allow' });
    expect(await guardB(call('echo'))).toEqual({ action: 'allow' }); // separate pin key → no collision
  });
});

describe('mcpFirewall — maxCallsPerRun', () => {
  it('require-approval once the limit is reached; free below the limit', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('search', 'searches the web')];
    const runId = 'r-max';

    // Seed 2 SUCCESSFUL 'search' calls into the journal (same shape as limits.ts's succeeded record).
    await journal.put(runKeys.tool(runId, 'c1'), { status: 'succeeded', output: {}, toolName: 'search' });
    await journal.put(runKeys.tool(runId, 'c2'), { status: 'succeeded', output: {}, toolName: 'search' });

    const guard = mcpFirewall({ server: 's', journal, tools, maxCallsPerRun: 2 });
    const decision = await guard(call('search', runId, 'c3'));
    expect(decision.action).toBe('require-approval');
    expect(decision.reason).toMatch(/reached the per-run call limit/);

    const guardHigherLimit = mcpFirewall({ server: 's', journal, tools, maxCallsPerRun: 3 });
    expect(await guardHigherLimit(call('search', runId, 'c3'))).toEqual({ action: 'allow' });
  });

  it('successful calls belonging to another tool are not counted (per-tool counter)', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('search', 'searches'), summary('fetch', 'fetches')];
    const runId = 'r-scoped';
    await journal.put(runKeys.tool(runId, 'c1'), { status: 'succeeded', output: {}, toolName: 'fetch' });

    const guard = mcpFirewall({ server: 's', journal, tools, maxCallsPerRun: 1 });
    expect(await guard(call('search', runId, 'c2'))).toEqual({ action: 'allow' });
  });

  it('nothing is counted if maxCallsPerRun is not given (opt-in)', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('search', 'searches')];
    const runId = 'r-noop';
    for (let i = 0; i < 10; i++) {
      await journal.put(runKeys.tool(runId, `c${i}`), { status: 'succeeded', output: {}, toolName: 'search' });
    }
    const guard = mcpFirewall({ server: 's', journal, tools });
    expect(await guard(call('search', runId, 'c99'))).toEqual({ action: 'allow' });
  });
});

describe('composeGuards', () => {
  it('if the firewall denies, the second guard is never called (short-circuit)', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('rm', 'removes files')];
    let secondCalled = false;
    const second = async (): Promise<{ action: 'allow' }> => {
      secondCalled = true;
      return { action: 'allow' };
    };

    const firewall = mcpFirewall({ server: 's', journal, tools, allow: ['echo'] }); // 'rm' is not in the allowlist
    const combined = composeGuards(firewall, second);
    const decision = await combined(call('rm'));
    expect(decision.action).toBe('deny');
    expect(secondCalled).toBe(false);
  });

  it('if the firewall allows, the second guard runs and its decision is returned', async () => {
    const journal = new InMemoryJournal();
    const tools = [summary('echo', 'echoes')];
    const second = async (): Promise<{ action: 'require-approval'; reason: string }> => ({
      action: 'require-approval',
      reason: 'policy: approval required',
    });

    const firewall = mcpFirewall({ server: 's', journal, tools });
    const combined = composeGuards(firewall, second);
    const decision = await combined(call('echo'));
    expect(decision).toEqual({ action: 'require-approval', reason: 'policy: approval required' });
  });
});
