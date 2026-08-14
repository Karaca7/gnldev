import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable } from './run.js';
import { readRunTaint, markRunTainted } from './taint.js';
import type { Journal } from './journal.js';
import type { Guard, Interrupt } from './guard.js';
import type { ModelInput, ToolSet } from './types.js';
import type { RunLimits } from './limits.js';

/**
 * carry taint across the sub-agent runId boundary. Taint is keyed per-run, so a nested run
 * (`agent:${toolCallId}`) starts CLEAN even when its parent is tainted — a side effect inside the
 * Sub-agent would then bypass the parent's `taintedSideEffects` ladder. If the parent is tainted at the
 * Moment it spawns the sub-agent, mark the nested run tainted BEFORE it executes any tools, preserving
 * The ORIGINAL provenance and noting it was inherited. Only-stricter / fail-safe: an un-tainted parent
 * (or an unknown parentRunId) changes nothing. First-wins/idempotent, so a resume re-marks harmlessly.
 */
async function inheritParentTaint(journal: Journal, parentRunId: string | undefined, nestedRunId: string): Promise<void> {
  if (!parentRunId) return;
  const parentTaint = await readRunTaint(journal, parentRunId);
  if (!parentTaint) return;
  await markRunTainted(journal, nestedRunId, {
    toolCallId: parentTaint.toolCallId,
    toolName: parentTaint.toolName,
    source: parentTaint.source,
    reason: `inherited from tainted parent run '${parentRunId}'${parentTaint.reason ? `: ${parentTaint.reason}` : ''}`,
  });
}

export interface AgentToolConfig {
  journal: Journal;
  /** A model OR a factory that produces a model from the nested runId (to freeze the registry fallback chain onto the nested run). */
  model: ModelInput | ((nestedRunId: string) => unknown | Promise<unknown>);
  tools?: ToolSet;
  system?: string;
  guard?: Guard;
  maxSteps?: number;
  /**
   * TASK W1 fan-out inheritance: the parent's `limits` is passed to the sub-agent AS-IS → the sub-agent
   * Independently bounds its own execution against this same ceiling too (prevents a single sub-agent
   * From spending without limit on its own). Also, the parent's OWN limit check (`limits.ts`
   * `scopedUsage`) RECURSIVELY sums this sub-agent's (nested `runId = agent:${toolCallId}`) usage in the
   * Journal too → the total (parent + all sub-agents) can NEVER bypass the parent's ceiling.
   */
  limits?: RunLimits;
  /** require-approval decisions (passed to the nested run) — approvals flow from here during a network resume. */
  approvals?: Record<string, boolean>;
  /**
   * The runId of the parent that spawned this sub-agent. When the parent is tainted, its taint
   * Is carried into the nested run so the sub-agent's side effects go through the SAME `taintedSideEffects`
   * Ladder. The agent-as-tool path (`createAgentTool`) reads this per-call from `options.parentRunId`; the
   * Network path (`runNetwork` → `runSubAgent`) passes the router's runId here.
   */
  parentRunId?: string;
}

/**
 * The SINGLE source of sub-agent call semantics: run durably under the nested runId, return {text, interrupts}.
 * BOTH `createAgentTool` (static agent-as-tool) AND the registry's `runNetwork` (dynamic network) call
 * THIS — model resolution / maxSteps default / limits inheritance live in one place, the paths cannot silently diverge.
 */
export async function runSubAgent(
  config: AgentToolConfig,
  task: string,
  nestedRunId: string,
): Promise<{ text: string; interrupts: Interrupt[] }> {
  const model = typeof config.model === 'function' ? await config.model(nestedRunId) : config.model;
  // Carry the parent's taint into the nested run BEFORE it executes any tools.
  await inheritParentTaint(config.journal, config.parentRunId, nestedRunId);
  const res = await runDurable({
    runId: nestedRunId,
    journal: config.journal,
    model,
    tools: config.tools,
    system: config.system,
    guard: config.guard,
    approvals: config.approvals,
    prompt: task,
    stopWhen: stepCountIs(config.maxSteps ?? 8),
    limits: config.limits,
  } as any);
  return { text: res.text, interrupts: res.interrupts };
}

/**
 * Turns a sub-agent into an AI SDK tool → "agent-as-tool" for multi-agent setups.
 * Its execute runs a nested `runDurable` (nested runId = `agent:${toolCallId}`, the SAME journal).
 *
 * **Moat synergy (two levels of durability):** When used inside a parent `runDurable`, the parent's
 * `durableTool` memoizes this agent-tool's result → the ENTIRE sub-agent is SKIPPED on a parent resume
 * (exactly-once handoff). If the sub-agent crashes midway, it resumes from its own journal.
 */
export function createAgentTool(config: AgentToolConfig, opts?: { description?: string }) {
  // H7: the nested run is ITSELF durable → a repeated call replays from its own journal, produces
  // No side effect → idempotent (smooth resume without getting stuck at the crash-window gate).
  return Object.assign(tool({
    description: opts?.description ?? 'Delegate a task to an expert sub-agent',
    inputSchema: z.object({ task: z.string().describe('the task/question to give the sub-agent') }),
    execute: async ({ task }, options: any) => {
      const nestedRunId = `agent:${options?.toolCallId}`;
      const model = typeof config.model === 'function' ? await config.model(nestedRunId) : config.model;
      // The parent runId is injected into the tool's execute options by durable-tool.ts. If the
      // Parent is tainted, carry that taint into the nested run before it runs any side-effect tool.
      await inheritParentTaint(config.journal, config.parentRunId ?? options?.parentRunId, nestedRunId);
      const res = await runDurable({
        runId: nestedRunId,
        journal: config.journal,
        model,
        tools: config.tools,
        system: config.system,
        guard: config.guard,
        prompt: task,
        stopWhen: stepCountIs(config.maxSteps ?? 8),
        limits: config.limits,
      } as any);
      return { text: res.text, interrupts: res.interrupts };
    },
  }), { idempotent: true });
}
