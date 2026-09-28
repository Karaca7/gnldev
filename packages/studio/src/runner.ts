// Converts a createGnl instance into the Playground/Tools runner (StudioAgentRunner). Pure adapter — does not import `ai`.
// @gnldev/cli and the studio CLI `--config` share this → single source of truth.
import type { AgentMeta, StudioAgentRunner, StudioCallbackCtx, ToolMeta, ToolListItem } from './server.js';
import { durableTool, toolDescriptionText, sealRequestContext, serverIdentityOf, runIdentity, userIdOf, UNKNOWN } from '@gnldev/durable';
import type { Guard, Journal, WorkflowMeta, WorkflowRunResult } from '@gnldev/durable';

export interface RunnerToolLike {
  /** AI SDK 7 lets a tool compute its description at call time; mirrors AnyTool in @gnldev/durable. */
  description?: string | ((options: any) => string);
  inputSchema?: unknown;
  execute?: (input: any, options: any) => any;
}
export interface RunnerAgentLike {
  model: unknown;
  /** Static string or a dynamic (requestContext) factory — meta only shows the static one. */
  system?: string | ((ctx: never) => string | Promise<string>);
  /** Static tool map or a dynamic factory — the runner only lists/executes the static map. */
  tools?: Record<string, RunnerToolLike> | ((ctx: never) => unknown);
  maxSteps?: number;
  /** Policy that gates tool calls (same as createGnl). Test-run applies this. */
  guard?: Guard;
  /** Orgs this org-scoped agent belongs to (visibility filter + UI label); GLOBAL if not given. */
  orgs?: string[];
}
export interface RunnerConfigLike {
  agents?: Record<string, RunnerAgentLike>;
  tools?: Record<string, RunnerToolLike>;
  /** For durable tool test-run (visible in the Inspector). Available once the createGnl config is passed. */
  journal?: Journal;
  /** Named workflow registry (the Workflows view fills in once the createGnl config is passed). */
  workflows?: Record<string, unknown>;
}
export interface GnlLike {
  // `ctx` is the per-REQUEST identity the host computed (orgId + actor). It is optional on the
  // callee side — createGnl ignores it today — but it must not stop at this adapter: the server
  // computes it for every call (server.ts:3823, 3867, 3892, 4938) and this runner used to take one parameter too few,
  // so it was dropped on the floor. An adapter that silently discards what its caller worked out is
  // the shape of a hole nobody can see, and this one sits under `@gnldev/cli` AND the studio
  // `--config` path — the file header calls itself the single source of truth.
  run(name: string, opts: any, ctx?: StudioCallbackCtx): Promise<{ text?: string; interrupts?: unknown[]; finishReason?: string }>;
  stream?(name: string, opts: any, ctx?: StudioCallbackCtx): Promise<any>;
  /** createGnl provides these (Workflows view). */
  listWorkflows?(): WorkflowMeta[];
  runWorkflow?(name: string, input: unknown, opts?: { runId?: string; maxSteps?: number }, ctx?: StudioCallbackCtx): Promise<WorkflowRunResult>;
}

/**
 * The calling organization and CALLER, put where the ENGINE reads them.
 *
 * `StudioCallbackCtx` was forwarded as an extra positional argument to `gnl.run`/`stream`/`runWorkflow`,
 * and those take 2, 2 and 3 parameters — measured with `fn.length`. So it arrived as `arguments[n]` and
 * nothing ever named it. createGnl reads identity from `opts.context` via `serverIdentityOf`, and
 * nothing in this package wrote that field. Measured before this: a dynamic `system(ctx)` on an agent
 * run through here saw `{keys: [], id: {}}` — the organization the server had just worked out, gone.
 *
 * What it cost, in a lab: an agent declaring `workScope: 'org'`, two organizations, the same workKey —
 * ONE runId was derived, the model ran ONCE, and the second organization was served the first's answer.
 * That path is NOT reachable through Studio today: no route forwards a `workKey` and the agent route
 * requires a raw `runId`, so it is latent rather than live. What IS live is quieter — a deployment whose
 * `system`/`model`/`tools` vary by organization silently gets the default for everyone.
 *
 * Sealed rather than assigned: `sealRequestContext` strips the reserved keys from whatever was there
 * before writing the server's, which is what stops a caller naming its own organization. Left untouched
 * when there is no org to seal, because calling it with `undefined` STRIPS an orgId a host set for
 * itself, and this adapter has no business deleting that.
 *
 * ONE helper for three call sites on purpose. Three copies is the shape the defect had.
 */
function withCallerOrg<T>(runOpts: T, ctx?: StudioCallbackCtx): T {
  if (ctx?.orgId === undefined && ctx?.caller === undefined) return runOpts;
  const o = (runOpts ?? {}) as { context?: Record<string, unknown> };
  const context = o.context ?? {};
  const caller = ctx.caller;
  return {
    ...o,
    // The CALLER (ADR-0002): the engine's own `Caller`, which the server mapped from the principal
    // (@gnldev/auth `engineCallerOf`). Sealed, so a dynamic `system`/`model`/`tools` function sees the
    // same identity the run is recorded under, and passed as `caller`, so an `unknown` one — which
    // seals nothing — is still said out loud. Without it every playground run an operator started was
    // born nobody's (`unknown`).
    ...(caller ? { caller } : {}),
    context: sealRequestContext(context, {
      // A host's own org survives a ctx that carries only a caller (the seal strips what it is not given).
      orgId: ctx.orgId ?? serverIdentityOf(context).orgId,
      ...(caller ? { resourceId: userIdOf(caller), staff: caller.kind === 'staff' } : {}),
    }),
  } as T;
}

/** Playground/Tools runner options. */
export interface MakeRunnerOptions {
  /**
   * Converts a zod (or other) input schema to JSON Schema — so the Tools view can generate a form.
   * If not given, no schema is exposed (UI shows "no schema"). Since the runner does not import `ai`,
   * the conversion is supplied externally; a ready-made helper: `@gnldev/studio/ai` → `aiToolSchema`.
   */
  toJsonSchema?: (schema: unknown) => unknown;
  /**
   * true → tools can be run from studio for TEST purposes (`POST /tools/:name/execute`, the Tools view's
   * "Run" button). NON-DURABLE by default (no journal); with `durable: true` and a journal the call is
   * journaled exactly-once and shows in the Inspector. If a guard exists it IS APPLIED (won't run
   * deny/require-approval). The tool runs for the caller on the request's ctx — staff, for an
   * operator in Studio — and for `unknown` when the host calls `runTool` with no ctx. Off by default;
   * enable with care for tools with side effects.
   */
  toolExec?: boolean;
}

function toolMeta(
  name: string,
  t: RunnerToolLike | undefined,
  toJsonSchema?: (s: unknown) => unknown,
  guarded?: boolean,
): ToolMeta {
  let inputSchema: unknown;
  if (t?.inputSchema !== undefined && toJsonSchema) {
    try {
      inputSchema = toJsonSchema(t.inputSchema);
    } catch {
      inputSchema = undefined;
    }
  }
  // Studio lists tools without a call context, so a dynamically-computed description has no
  // value to show — undefined is honest, a stringified function is not.
  return { name, description: toolDescriptionText(t), inputSchema, ...(guarded ? { guarded: true } : {}) };
}

/** Builds the Playground/Tools runner from the createGnl return value (`gnl`) + config. */
export function createStudioRunner(
  gnl: GnlLike,
  config: RunnerConfigLike,
  opts: MakeRunnerOptions = {},
): StudioAgentRunner {
  const { toJsonSchema, toolExec } = opts;
  const agents = config.agents ?? {};
  // A dynamic tool factory (requestContext) can't be resolved without a request → the runner only sees the static map.
  const staticTools = (a: RunnerAgentLike): Record<string, RunnerToolLike> =>
    a.tools && typeof a.tools === 'object' ? a.tools : {};
  const sharedTools = config.tools ?? {};
  const sharedNames = Object.keys(sharedTools);
  const anyAgentGuard = Object.values(agents).some((a) => !!a.guard);

  // Agent metadata (+ per-agent tool list: shared + agent-specific; tools are guarded if the agent has a guard).
  const meta: AgentMeta[] = Object.entries(agents).map(([name, a]) => {
    const own = staticTools(a);
    const names = [...new Set([...sharedNames, ...Object.keys(own)])];
    const tools: ToolMeta[] = names.map((tn) => toolMeta(tn, own[tn] ?? sharedTools[tn], toJsonSchema, !!a.guard));
    return {
      name,
      model: typeof a.model === 'string' ? a.model : 'custom',
      system: typeof a.system === 'string' ? a.system : undefined, // dynamic system is never leaked (parity with @gnldev/server)
      hasTools: names.length > 0,
      maxSteps: a.maxSteps ?? 12,
      tools,
      ...(a.orgs?.length ? { orgs: a.orgs } : {}),
    };
  });

  // Is there at least 1 tool? If not, don't expose the Tools capability at all (avoid an empty tab).
  const hasAnyTool = sharedNames.length > 0 || Object.values(agents).some((a) => Object.keys(staticTools(a)).length > 0);

  // Tool name → tool object (for execution); agent-specific overrides shared.
  const resolveTool = (tn: string): RunnerToolLike | undefined => {
    for (const a of Object.values(agents)) if (staticTools(a)[tn]) return staticTools(a)[tn];
    return sharedTools[tn];
  };
  // Guard to apply to a tool: the first guarded agent that owns the tool (or, for shared tools, uses it).
  const resolveGuard = (tn: string): Guard | undefined => {
    for (const a of Object.values(agents)) if ((staticTools(a)[tn] || sharedTools[tn]) && a.guard) return a.guard;
    return undefined;
  };

  // Flat tool list (Tools view): which agents use it + whether it's shared + whether it's guarded.
  const listTools = (): ToolListItem[] => {
    const byName = new Map<string, ToolListItem>();
    const ensure = (tn: string, t: RunnerToolLike | undefined): ToolListItem => {
      let it = byName.get(tn);
      if (!it) {
        it = { ...toolMeta(tn, t, toJsonSchema), agents: [], shared: false };
        byName.set(tn, it);
      }
      return it;
    };
    for (const tn of sharedNames) {
      const it = ensure(tn, sharedTools[tn]);
      it.shared = true;
      if (anyAgentGuard) it.guarded = true; // shared tool: guarded if ANY agent using it has a guard
    }
    for (const [aname, a] of Object.entries(agents)) {
      for (const tn of Object.keys(staticTools(a))) {
        const it = ensure(tn, staticTools(a)[tn]);
        it.agents.push(aname);
        if (a.guard) it.guarded = true;
      }
    }
    return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
  };

  const runner: StudioAgentRunner = {
    listAgents: () => meta,
    run: (name, runOpts, ctx) => gnl.run(name, withCallerOrg(runOpts, ctx), ctx).then((r) => ({ text: r.text, interrupts: r.interrupts ?? [] })),
    ...(gnl.stream ? { stream: (name: string, runOpts: any, ctx?: StudioCallbackCtx) => gnl.stream!(name, withCallerOrg(runOpts, ctx), ctx) } : {}),
  };

  if (hasAnyTool) runner.listTools = listTools;

  // Workflows: createGnl provides listWorkflows/runWorkflow; only surfaced if any workflow is registered.
  const hasWorkflows = !!config.workflows && Object.keys(config.workflows).length > 0;
  if (hasWorkflows && gnl.listWorkflows) runner.listWorkflows = () => gnl.listWorkflows!();
  if (hasWorkflows && gnl.runWorkflow) runner.runWorkflow = (name, input, opts, ctx) => gnl.runWorkflow!(name, input, withCallerOrg(opts, ctx), ctx);

  // TEST execution (opt-in + requires a tool): GUARD IS APPLIED. opts.durable + journal → writes to the
  // journal (exactly-once, visible in the Inspector); otherwise a fast NON-DURABLE sandbox.
  if (hasAnyTool && toolExec) {
    runner.toolExecDurable = !!config.journal; // durable test-run is possible if a journal exists
    // The tool runs for the CALLER on ctx (the one the server mapped, ADR-0002): `durableTool` takes
    // it as the run's identity, and the tool reads it with `identityOf(options)`. It used to be
    // `STAFF` for everyone — a host calling this with no ctx included — so a tool that scopes by the
    // caller served staff's whole view to a call nobody had identified. No ctx is `unknown`: closed.
    runner.runTool = async (name, input, runOpts, ctx) => {
      const caller = ctx?.caller ?? UNKNOWN;
      const t = resolveTool(name);
      if (!t || typeof t.execute !== 'function') return { error: `tool not found or not executable: ${name}` };
      const guard = resolveGuard(name);

      // APPROVE/DENY: resumes a suspended durable tool test — reads args from the suspended sentinel, continues with approvals.
      if (runOpts?.approve && config.journal) {
        const { runId, toolCallId, approved } = runOpts.approve;
        const rec: any = await config.journal.get(`${runId}:tool:${toolCallId}`);
        const args = rec?.output?.__gnl_suspend ? rec.output.__gnl_suspend.args : input;
        try {
          const out: any = await durableTool(t as any, { journal: config.journal, runId, guard, identity: runIdentity(caller, runId), approvals: { [toolCallId]: approved } }, name).execute(args, { toolCallId });
          if (out && out.__gnl_suspend) return { error: 'still awaiting approval', blocked: 'approval', runId };
          if (out && out.__denied) return { error: `approval denied${out.reason ? ': ' + out.reason : ''}`, blocked: 'deny', runId };
          return { result: out, runId };
        } catch (e: any) {
          return { error: String(e?.message ?? e), runId };
        }
      }

      // DURABLE: durableTool writes exactly-once + guard + suspend records to the journal (shows up in the Inspector).
      if (runOpts?.durable && config.journal) {
        const runId = `tooltest-${name}-${Date.now()}`;
        try {
          const out: any = await durableTool(t as any, { journal: config.journal, runId, guard, identity: runIdentity(caller, runId) }, name).execute(input, { toolCallId: `${runId}:call` });
          if (out && out.__gnl_suspend) return { error: `requires approval — appears as suspended in the Inspector`, blocked: 'approval', runId };
          if (out && out.__denied) return { error: `guard denied${out.reason ? ': ' + out.reason : ''}`, blocked: 'deny', runId };
          return { result: out, runId };
        } catch (e: any) {
          return { error: String(e?.message ?? e), runId };
        }
      }

      // NON-DURABLE (fast sandbox): apply the guard manually, don't write to the journal.
      const toolCallId = `studio-test-${name}`;
      if (guard) {
        try {
          const d = await guard({ toolName: name, args: input, toolCallId, runId: toolCallId });
          if (d.action === 'deny') return { error: `guard denied${d.reason ? ': ' + d.reason : ''}`, blocked: 'deny' };
          if (d.action === 'require-approval')
            return { error: `this tool requires approval (test-run does not support the approval flow)${d.reason ? ': ' + d.reason : ''}`, blocked: 'approval' };
        } catch (e: any) {
          return { error: `guard error: ${String(e?.message ?? e)}` };
        }
      }
      try {
        const result = await t.execute(input, { toolCallId });
        return { result };
      } catch (e: any) {
        return { error: String(e?.message ?? e) };
      }
    };
  }

  return runner;
}
