// CLI-only glue for `gnl resume`: turns a registered `config.agents[name]` into the resolved
// {model, tools, guard, maxSteps} that @gnl/durable's resumeRun needs. This mirrors (does not
// reimplement the durable behavior of) @gnl/durable/registry.ts's internal materializeModel — it
// composes the SAME exported primitives (resolveModel/withModelFallback) the registry itself uses,
// so a string spec ('openai/gpt-4o') or a fallback chain resolves identically whether run via
// createGnl().run() or via `gnl resume`. requestContext is empty ({}) — the CLI has no per-request
// context to inject (org/user/etc.), same as an agent invoked with no `context` at createGnl.run time.
import type * as Durable from '@gnl/durable';
import type { AgentConfig, Guard, Journal, ModelInput, RequestContext, ToolSet } from '@gnl/durable';

async function resolveDyn<T>(v: T | ((ctx: RequestContext) => T | Promise<T>), ctx: RequestContext): Promise<T> {
  return typeof v === 'function' ? await (v as (c: RequestContext) => T | Promise<T>)(ctx) : v;
}

/** Same logic as registry.ts's private materializeModel: a string resolves via resolveModel, an array
 *  is a deterministic fallback chain (frozen into the journal by withModelFallback). `d` is the
 *  caller's already project-resolved @gnl/durable module — must be the SAME instance the journal came
 *  from (see runtime.ts). */
async function materializeModel(d: typeof Durable, spec: ModelInput | ModelInput[], runId: string, journal: Journal): Promise<unknown> {
  const chain = Array.isArray(spec) ? spec : [spec];
  if (chain.length === 0) throw new Error('agent model chain is empty');
  const candidates: { spec: string; model: unknown }[] = [];
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i]!;
    candidates.push(typeof m === 'string' ? { spec: m, model: await d.resolveModel(m) } : { spec: `#${i}`, model: m });
  }
  return d.withModelFallback(candidates, journal, runId);
}

export interface ResolvedAgent {
  model: unknown;
  tools?: ToolSet;
  guard?: Guard;
  maxSteps: number;
}

/** Resolves a registered agent's model/tools/guard for a resume — same request-context shape (empty
 *  by default) as createGnl().run() uses when no context is supplied. */
export async function resolveAgentForResume(d: typeof Durable, agentCfg: AgentConfig, runId: string, journal: Journal): Promise<ResolvedAgent> {
  const rc: RequestContext = {};
  const modelSpec = await resolveDyn(agentCfg.model, rc);
  const model = await materializeModel(d, modelSpec, runId, journal);
  const tools = agentCfg.tools ? await resolveDyn(agentCfg.tools, rc) : undefined;
  return { model, tools, guard: agentCfg.guard, maxSteps: agentCfg.maxSteps ?? 12 };
}

/** Local equivalent of the AI SDK's `stepCountIs(n)` — avoided importing the 'ai' package here on
 *  purpose (it is not a runtime dependency of @gnl/cli; only @gnl/durable itself needs it). The shape
 *  is exactly what @gnl/durable's composeStopWhen expects: `(opts: { steps }) => boolean`. */
export function stepCountIs(n: number): (opts: { steps: { length: number } }) => boolean {
  return ({ steps }) => steps.length >= n;
}
