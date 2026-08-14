// @gnldev/studio/workflow — compiles a managed (UI-authored) WorkflowDef into a REAL @gnldev/workflow Workflow.
// Separate sub-export: keeps the @gnldev/workflow import isolated from the studio core (server.ts) → core stays decoupled.
// The host passes this via `createStudioApp({ compileWorkflow: compileManagedWorkflow })`; the server runs the
// Compiled Workflow with the same engine (each step is journaled as `${runId}:wf:${stepId}` → exactly-once + suspend/resume,
// Poll-to-stream / run-state / run-history / inspector all work the same way as for code workflows).
import { workflow, step } from '@gnldev/workflow';
import type { WorkflowLike } from '@gnldev/durable';
import type { WorkflowDef } from './server.js';

/** The studio runner's agent executor (structurally compatible with StudioAgentRunner.run). */
export type RunAgentFn = (name: string, opts: { runId: string; prompt?: string }) => Promise<{ text?: string }>;

/** Fills the prompt template: {{input}} = the original workflow input, {{prev}} = the previous step's output. */
function fillPrompt(tmpl: string | undefined, original: unknown, prev: unknown): string {
  const t = tmpl && tmpl.trim() ? tmpl : '{{prev}}';
  const origStr = typeof original === 'string' ? original : JSON.stringify(original ?? '');
  const prevStr = typeof prev === 'string' ? prev : JSON.stringify(prev ?? original ?? '');
  return t.replaceAll('{{input}}', origStr).replaceAll('{{prev}}', prevStr);
}

/**
 * Managed WorkflowDef → WorkflowLike. Each step calls an agent (a durable sub-run) and returns its text;
 * The `.then` chain passes outputs along. `original` is kept in the closure so {{input}} stays accessible in every step.
 */
export function compileManagedWorkflow(def: WorkflowDef, runAgent: RunAgentFn, original: unknown): WorkflowLike {
  let wf = workflow<unknown>();
  for (const s of def.steps) {
    wf = wf.then(
      step(s.id, async (prev: unknown, ctx: { runId: string }) => {
        const prompt = fillPrompt(s.prompt, original, prev);
        const r = await runAgent(s.agentName, { runId: `${ctx.runId}_${s.id}`, prompt });
        return r.text ?? '';
      }),
    );
  }
  return wf as unknown as WorkflowLike;
}
