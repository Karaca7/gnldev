import { nestedAgentRunId } from './journal.js';
import type { ToolSchemaRuleLike } from './types.js';
import { stepCountIs, tool as aiTool, jsonSchema } from 'ai';
import { runDurable, streamDurable } from './run.js';
import type { StreamBreach } from './run.js';
import { resolveModel, withModelFallback, type FallbackCandidate } from './model-router.js';
import { createAgentTool, runSubAgent } from './agent-tool.js';
import { runNetwork as runNetworkCore, type NetworkResult, type NetworkTarget } from './network.js';
import { durableProcessorStep } from './processor.js';
import { recordRunScores } from './metrics.js';
import { assertSuiteConsistent } from './suite-consistency.js';

import type { Journal } from './journal.js';
import type { Storage } from './storage.js';
import type { Guard } from './guard.js';
import type { Memory } from './memory.js';
import type { ModelInput, ToolSet } from './types.js';
import type { Processor } from './processor.js';
import type { RunLimits } from './limits.js';

// Registry/DI: a single top-level `createGnl({...})` factory. Register agents/tools, run durably by name.

/** Request context (the common "requestContext" pattern): per-call values like organization/role/user. */
export type RequestContext = Record<string, unknown>;

/**
 * P1.7 reserved request-context keys that only SERVER-SIDE code is allowed to
 * Fill in (see sealRequestContext below) — mirror of the common "reserved resource-id key" convention,
 * Where a reserved requestContext key carries the AUTHENTICATED resourceId so a client-supplied value
 * In the request body can never impersonate another organization/user.
 */
export const GNL_RESOURCE_ID_KEY = '__gnl_resourceId';
export const GNL_ORG_ID_KEY = '__gnl_orgId';
export const GNL_THREAD_ID_KEY = '__gnl_threadId';

/**
 * Plain keys the SERVER also derives, and which a client therefore must not be able to supply.
 *
 * The seal covered the three `__gnl_*` keys and stopped there, but `@gnldev/server` documents and
 * injects a plain `org` alongside them ("the resolved organization is injected into requestContext as
 * `org`, visible to dynamic agents"), and dynamic `system`/`model`/`tools` functions read it. When no
 * organization resolves for a request — the shared-scope path, which is every request on a deployment
 * that has not configured `org` — a body carrying `context: { org: 'victim' }` reached those functions
 * verbatim. The seal existed to close exactly that class and missed the one key it had published.
 */
const RESERVED_CONTEXT_KEYS = [GNL_RESOURCE_ID_KEY, GNL_ORG_ID_KEY, GNL_THREAD_ID_KEY, 'org'] as const;

/**
 * Writes an OWN property, ignoring the prototype chain.
 *
 * Plain assignment does not: `[[Set]]` walks the prototype before it will create an own property, so
 * a polluted `Object.prototype` decides what happens. Measured against the four shapes an attacker
 * can install, with the server having ALREADY resolved a real identity (`resourceId: 'real-user'`):
 *
 *   data property   ->  "real-user"    the own write lands; only this shape was ever handled
 *   accessor pair   ->  "victim-user"  inherited setter swallows the write, getter answers instead
 *   getter-only     ->  TypeError      "Cannot set property ... which has only a getter"
 *   non-writable    ->  TypeError      "Cannot assign to read only property"
 *
 * The accessor-pair row is the whole point: the server's authenticated identity is silently discarded
 * and `serverIdentityOf` then reports the attacker's value — the exact P1.7 hijack the seal exists to
 * prevent, reachable again through a route the seal never considered. The two TypeError rows land
 * inside `try` blocks in `@gnldev/server`, so they degrade to a 400 on every request.
 *
 * `defineProperty` defines on the object itself and never consults the prototype, so all four shapes
 * behave identically to the unpolluted case. The descriptor matches what assignment would have
 * produced (enumerable/writable/configurable) so nothing downstream — spread, `Object.keys`,
 * `JSON.stringify` — can tell the difference.
 */
function define(target: RequestContext, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * P1.7 seals a request context against the cross-organization hijack class where a
 * Client-supplied `context.__gnl_resourceId`/`__gnl_orgId`/`__gnl_threadId` in the request body would
 * Otherwise be indistinguishable from a value the SERVER derived from the authenticated identity — a
 * Client could smuggle `{ context: { __gnl_resourceId: 'victim-user' } }` and have it silently win
 * Downstream (memory lookup, dynamic model/system resolution), reading/writing another organization's data.
 * Mirrors the common "reserved resource-id key" design: a reserved requestContext key that only server code
 * Writes, so a client can never override its own identity through the request body.
 *
 * ALWAYS overwrites the three reserved keys — even a key `server` has NO value for is stripped from the
 * Client-supplied context (deleted, never left as `undefined` either): a spoofed key must not survive by
 * Omission just because the server didn't happen to supply that particular field this call.
 */
export function sealRequestContext(
  ctx: RequestContext,
  server: { resourceId?: string; orgId?: string; threadId?: string },
): RequestContext {
  const sealed: RequestContext = { ...ctx };
  // A JSON body cannot pollute `Object.prototype` through this function — spread copies `__proto__`
  // as an inert own DATA property — but it does not follow that the key is harmless to pass on. This
  // context is handed to user-written dynamic `system`/`model`/`tools` functions and to tool code, and
  // an ordinary merge there re-arms it, because `Object.assign` writes with `[[Set]]`:
  //
  //   body    {"context": {"a": 1, "__proto__": {"isAdmin": true}}}
  //   sealed  own keys ["a","__proto__","__gnl_orgId","org"]   sealed.isAdmin -> undefined
  //   Object.assign({}, sealed)                                 .isAdmin      -> true   (prototype set)
  //
  // So the seal was handing a live payload to every consumer and relying on none of them using the
  // one-line merge. Dropped here: no legitimate request context carries `__proto__` as data, and this
  // is the function whose whole job is making the context safe to pass onward.
  //
  // SHALLOW, and deliberately so — `context: { profile: { __proto__: {...} } }` still arms
  // `Object.assign({}, ctx.profile)` one level down, and neither `structuredClone` nor a JSON round
  // trip strips it (measured). Closing that means recursively rewriting arbitrary caller data on every
  // request, which is a larger behavioural change than the residual warrants. `__proto__` is the ONLY
  // accessor on `Object.prototype` (surveyed, and pinned by a test that fails if a runtime adds a
  // second), so `constructor`/`toString`/`valueOf` merge into plain own properties and escalate
  // nothing — a surviving `toString` key does make `String(merged)` throw, which is a crash, not a
  // privilege. Consumers must not `Object.assign` untrusted SUB-objects of a request context.
  delete sealed['__proto__'];
  // Stripped from the LIST, not one `delete` per key. The three `__gnl_*` keys were deleted here by
  // hand while a fourth reserved key — the plain `org` that @gnldev/server publishes to dynamic agents
  // — went on arriving from the request body. A rule written out per key is a rule that grows a hole
  // the moment a fifth key is published.
  for (const k of RESERVED_CONTEXT_KEYS) {
    delete sealed[k];
    // `delete` removes the OWN property only, so a reserved key inherited from a polluted
    // `Object.prototype` survives it and reads back exactly like a value the server set. Shadowed with
    // an own `undefined` — and only when the key is still reachable, so an ordinary context gains
    // nothing.
    //
    // gnl's own callers cannot reach this: a JSON body gives `__proto__` as an own data property and
    // object spread copies it as data, leaving `Object.prototype` untouched (measured). But this
    // function is exported from `@gnldev/durable`, so the object it is handed may have come from a
    // YAML parse, a query-string parser, or a config merge — and a seal whose correctness depends on
    // which parser the caller happened to use is not a seal.
    if (k in sealed) define(sealed, k, undefined);
  }
  if (server.resourceId !== undefined) define(sealed, GNL_RESOURCE_ID_KEY, server.resourceId);
  if (server.orgId !== undefined) {
    define(sealed, GNL_ORG_ID_KEY, server.orgId);
    define(sealed, 'org', server.orgId); // the documented, client-readable name for the same server-derived fact
  }
  if (server.threadId !== undefined) define(sealed, GNL_THREAD_ID_KEY, server.threadId);
  return sealed;
}

/** P1.7: reads the sealed server identity back out of a request context (see sealRequestContext). Keys the
 *  Context doesn't carry are simply ABSENT from the result (never `undefined`-valued properties). */
export function serverIdentityOf(ctx: RequestContext): { resourceId?: string; orgId?: string; threadId?: string } {
  const out: { resourceId?: string; orgId?: string; threadId?: string } = {};
  if (typeof ctx[GNL_RESOURCE_ID_KEY] === 'string') out.resourceId = ctx[GNL_RESOURCE_ID_KEY] as string;
  if (typeof ctx[GNL_ORG_ID_KEY] === 'string') out.orgId = ctx[GNL_ORG_ID_KEY] as string;
  if (typeof ctx[GNL_THREAD_ID_KEY] === 'string') out.threadId = ctx[GNL_THREAD_ID_KEY] as string;
  return out;
}

/**
 * Dynamic agent field: a fixed value OR a function deriving it from the request context.
 * Durable twist: the resolved system/messages freeze into `:input` via persistInput → replay-deterministic;
 * The resolved model (string spec) freezes into `:cfg:model` → same model on resume even if the agent
 * Definition changes.
 */
export type DynamicArg<T> = T | ((ctx: RequestContext) => T | Promise<T>);

async function resolveDyn<T>(v: DynamicArg<T>, ctx: RequestContext): Promise<T> {
  return typeof v === 'function' ? await (v as (c: RequestContext) => T | Promise<T>)(ctx) : v;
}

/** P1.2: FNV-1a (32-bit) — a cheap, dependency-free, stable string hash (same algorithm across Node
 *  Versions/platforms, unlike relying on iteration order or object hashing). Used ONLY to bucket runIds
 *  For scorer sampling — not a security hash, no collision-resistance requirement here. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** P1.2: WeakSet so an invalid scorerSampling.rate warns ONCE per config object, not once per run
 *  (a hot agent could otherwise flood stderr with the same warning on every completed run). */
const warnedInvalidSamplingRate = new WeakSet<object>();

/** P1.2: normalizes AgentConfig.scorerSampling into an effective rate — see the field's JSDoc for the
 *  Invalid-value/warn-once contract. No `scorerSampling` at all → 1 (existing behavior: score every run). */
function effectiveScorerRate(a: AgentConfig): number {
  const s = a.scorerSampling;
  if (!s) return 1;
  const r = s.rate;
  if (typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 1) return r;
  if (!warnedInvalidSamplingRate.has(s)) {
    warnedInvalidSamplingRate.add(s);
    console.warn(`[gnl] scorerSampling.rate is invalid (${String(r)}) — expected a number in [0,1]; treating as 1 (scoring every run)`);
  }
  return 1;
}

/** P1.2: deterministic per-runId sampling decision — see AgentConfig.scorerSampling's JSDoc for why this
 *  Is a runId hash and not Math.random(). Bucket space is 0..9999 (four-digit resolution is plenty for a
 *  Sampling *rate*, and keeps the hash→bucket math exact in floating point). */
function shouldSampleScorers(runId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = fnv1a32(runId) % 10000;
  return bucket < rate * 10000;
}

/**
 * Structural compatibility with @gnldev/evals's Scorer (a reverse import would be circular). Runtime
 * Scoring: when a run completes, each scorer is memoized under `${runId}:proc:eval:${name}` →
 * EXACTLY-ONCE (even llmJudge doesn't rerun on resume/repeat calls, the same score is returned).
 * Same key schema as scoreRun — studio /runs/:id/score sees the same records.
 */
export interface ScorerLike {
  name: string;
  /**
   * Runtime scoring sample: `output` = the agent's final text, `input` = the run prompt (if given as a string).
   * NOTE: RAG context (`context`) is NOT AVAILABLE here — scorers that require context (faithfulness,
   * Hallucination, contextPrecision) always return 0 in registry scorers; use them with `scoreRun`,
   * Which builds a custom sample.
   */
  score(sample: { output: string; input?: string; expected?: string }): Promise<{ score: number; [k: string]: unknown }> | { score: number; [k: string]: unknown };
}

export interface AgentConfig {
  /** Short description of what the agent does — the network router sees this when picking an agent. */
  description?: string;
  /**
   * An AI SDK model OR a 'provider/model' string (resolved via the router) OR a fallback CHAIN
   * (array: tried in order, the winner is written to `<runId>:cfg:model` → deterministic fallback)
   * any of these can also be a function deriving it from requestContext.
   */
  model: DynamicArg<ModelInput | ModelInput[]>;
  tools?: DynamicArg<ToolSet>;
  system?: DynamicArg<string>;
  guard?: Guard;
  maxSteps?: number;
  /** 8.7 Processor pipeline (PII/moderation/tool-filter). */
  processors?: Processor[];
  /**
   * C5 first-class agent network: names of other registered agents. Each is exposed as an
   * `agent_<name>` tool (agent-as-tool, two-level journal → exactly-once handoff; a completed
   * Sub-agent is fully skipped on parent resume).
   */
  agents?: string[];
  /**
   * Workflows this agent may START, by registry name — the missing direction of composition.
   *
   * A workflow has always been able to contain agents (its steps call them); an agent could not
   * Reach a workflow at all, so "look this up, and if it needs the full onboarding pipeline, kick
   * It off" was not expressible. Each name becomes a `workflow_<name>` tool. The nested workflow
   * Runs DURABLY on the same journal under a runId derived from the tool call
   * (`wf:<toolCallId>`), so a parent resume does not start it twice — the same exactly-once
   * Contract `agents` already has.
   */
  workflows?: string[];
  /** C4 runtime scorers: automatic, journal-memoized (exactly-once) scoring when a run completes. */
  scorers?: ScorerLike[];
  /**
   * P1.2 opt-in sampling for `scorers` — without this, EVERY completed run pays
   * For every scorer (can be llmJudge, i.e. a full extra model call per scorer per run). `rate` is the
   * Fraction of runs scored, 0..1 (0 = never, 1 = always/default-equivalent). Invalid values (NaN,
   * <0, >1, non-number) are treated as 1 (score everything) with a ONE-TIME console.warn — never throw,
   * A misconfigured sampling rate must not take an agent down.
   *
   * DETERMINISTIC BY DESIGN — derived from a stable hash of `runId`, NOT `Math.random()`:
   * replay consistency: `run()` can be called again for the SAME runId (resume, at-least-once
   *    Delivery, a retried HTTP call) — a coin-flip sampler would risk scoring once and skipping the
   *    Next time (or vice versa) for the identical run, which is both confusing (the same run "flips")
   *    And breaks the exactly-once memoization contract scorers otherwise have (see ScorerLike).
   * uniform sampling: a hash of runId spreads pseudo-randomly across the bucket space regardless of
   *    How runIds are minted (sequential, UUID, timestamp-prefixed, ...), so the sampled subset doesn't
   *    Silently skew toward (or away from) any run-id pattern.
   * cost rationale: scorers (especially LLM-judge ones) are a per-run cost multiplier; sampling lets
   *    An agent get a statistically representative quality signal at a fraction of the spend.
   */
  scorerSampling?: { rate: number };
  /**
   * The orgs this agent belongs to. IF NOT GIVEN, the agent is GLOBAL (every org + operator
   * Sees/runs it — existing behavior). If given, only identities whose orgId is in the list (plus
   * Operator=orgless) see/run it. Visibility logic is SHARED via `agentVisibleToOrg` (server + studio
   * Use the same helper).
   */
  orgs?: string[];
}

/**
 * Org-scoped agent visibility decision (SHARED helper for server + studio). Opt-in:
 * agent didn't GIVE `orgs` → GLOBAL, everyone sees it (existing behavior, backward-compatible).
 * caller is NOT org-bound (operator / auth off → undefined) → sees everything.
 * otherwise: visible only if the caller's org is in the agent's `orgs` list.
 */
export function agentVisibleToOrg(cfg: { orgs?: string[] }, callerOrgId: string | undefined): boolean {
  if (!cfg.orgs?.length) return true; // global agent
  if (!callerOrgId) return true; // operator (orgless) / auth off
  return cfg.orgs.includes(callerOrgId);
}

/**
 * Structural type for the workflow registry — to AVOID CREATING a dependency on @gnldev/workflow
 * (workflow→durable already exists; a reverse import would be circular). @gnldev/workflow's `Workflow`
 * Class structurally satisfies this.
 */
export interface WorkflowLike {
  build(): { id: string }[];
  run(input: any, ctx: { runId: string; journal: Journal }): Promise<any>;
  runResumable?(
    input: any,
    ctx: { runId: string; journal: Journal },
    // P0.4 resume delivers typed HITL payloads (consumed via ctx.resumeData/
    // WaitForResume); signal is the in-process cancel/disconnect path, checked between steps.
    // FLOW-08: workflowName is mirrored into the `wfrun:` status record (see @gnldev/workflow's
    // RunResumable) so the run registry can show which workflow a run belongs to.
    opts?: { maxSteps?: number; resume?: Record<string, unknown>; signal?: AbortSignal; workflowName?: string },
  ): Promise<
    | { status: 'completed'; output: any }
    | { status: 'suspended'; stepId: string; reason?: unknown }
    | { status: 'paused'; stepId: string; partial?: unknown }
    // P0.4: a durable cancel (cancelWorkflowRun) or an aborted signal — terminal, resuming stays canceled.
    | { status: 'canceled'; stepId?: string; reason?: unknown }
  >;
}

/** Introspection of a workflow (studio Workflows view). */
export interface WorkflowMeta {
  name: string;
  steps: { id: string; kind: string }[];
}

/** Result of a workflow run (with step outputs). */
export interface WorkflowRunResult {
  runId: string;
  output?: unknown;
  suspended?: boolean;
  /** Step-through: the maxSteps limit was reached — stepId is the next (not-yet-run) step. */
  paused?: boolean;
  /** P0.4 the run was durably canceled (cancelWorkflowRun) or its signal aborted. */
  canceled?: boolean;
  stepId?: string;
  reason?: unknown;
  /**
   * `fallback` is present only when the step's `output` came from a `retry(..., { fallback })`
   * Substitute rather than from the step itself. Without it the two are indistinguishable in the
   * Record — a "charged via provider A" step reads identically whether it worked first time or blew
   * Up twice and landed on provider B, which is the reading an operator is most likely to get wrong.
   *
   * `stepId` is the load-bearing half. `attempts` is the number CONSUMED before the substitution, and
   * Since a fallback is only reached once the budget is spent it normally equals `policy.attempts` —
   * Which the workflow definition already states. It differs only when a resumed run meets a policy
   * That has since been lowered, so read it as "attempts consumed", not as this run's failure count.
   *
   * TOP-LEVEL steps only. A `retry` inside a nested `asStep` workflow writes its marker under the
   * Inner step's prefixed key, and this list does not enumerate inner steps at all — so a substitution
   * There is invisible here, exactly as the inner step's output already is.
   */
  steps: { id: string; kind: string; output: unknown; fallback?: { attempts: number; stepId: string } }[];
}

export interface CreateGnlConfig {
  /** Storage (RunJournal + optional MemoryStore/...). Preferred over `journal` (composite + memory). */
  storage?: Storage;
  /** Low-level journal (if no storage). runDurable works with this; `storage` is required for memory. */
  journal?: Journal;
  agents?: Record<string, AgentConfig>;
  /** Common tools added to all agents. */
  tools?: ToolSet;
  /** Conversation memory. `false` = explicitly off. If not given, derived via `memoryFactory` (if any). */
  memory?: Memory | false;
  /** If `memory` isn't given, derives a Memory from the storage source (Storage if present, otherwise Journal). */
  memoryFactory?: (storage: Storage | Journal) => Memory;
  /** Common processors added to all agents (run before the agent's own). */
  processors?: Processor[];
  /** Named workflow registry (studio Workflows view: list + run). */
  workflows?: Record<string, WorkflowLike>;
  /** Named dynamic agent networks (parity with Supervisor/`.network()`) — run via `runNetwork(name, ...)`. */
  networks?: Record<string, NetworkConfig>;
  /**
   * Task 3 (opt-in): validates that INSTALLED sibling @gnldev/* packages (memory/server/studio/...) share
   * @gnldev/durable's OWN version — catches a `--force`/overrides-installed incompatible suite that the
   * Package manager's caret range would normally prevent (see suite-consistency.ts
   * `assertSuiteConsistent`). `true` → warn on mismatch (default), `'throw'` → hard error at
   * `createGnl()` time. Default: `undefined` (OFF) — existing behavior byte-for-byte unchanged; this is
   * A new opt-in check, not a new implicit requirement.
   */
  checkSuiteConsistency?: boolean | 'throw';
  /**
   * Provider-specific tool-schema compatibility, same meaning as runDurable's option: `true` for the
   * Default rule set, or an explicit list. Applies to every agent this registry runs.
   *
   * It is declared here because @gnldev/tool-schema's README documents exactly this call —
   * `createGnl({ ...config, schemaCompat: defaultRules })` — and until now the registry forwarded a
   * Fixed allowlist of options to runDurable that did not include it, so the package's only
   * Documented integration was silently doing nothing.
   */
  schemaCompat?: boolean | ToolSchemaRuleLike[];
}

/**
 * Dynamic network definition: the router-LLM picks one from the `agents` list each turn, or writes
 * The final answer. Determinism: routing decisions freeze into `<runId>:net:route:<i>` via CAS
 * (see network.ts) → the router isn't called again on resume; the router model's fallback chain
 * (materializeModel) also freezes into `<runId>:cfg:model`. The loop is bounded by `maxIterations`
 * (default 6).
 */
export interface NetworkConfig {
  /** Router model — same shapes as AgentConfig.model (spec/object/fallback chain/dynamic). */
  router: DynamicArg<ModelInput | ModelInput[]>;
  /** Names of registered agents that can be routed to (AgentConfig.description serves as the router's introduction). */
  agents: string[];
  /** Extra instruction for the router. */
  system?: DynamicArg<string>;
  /** Routing turn cap (default 6); once reached, the router is forced to finalize. */
  maxIterations?: number;
}

/** Derives a kind from a composite step id (parallel(a+b) / branch(..) / foreach(..) / loop(..) → kind). */
/**
 * A retry's fallback marker, as written by @gnldev/workflow. Structural rather than imported — the
 * Dependency only runs one way (see the WorkflowLike note above) — and checked field by field,
 * Because a truthy-only test once let an ordinary step output stand in for one.
 */
function isFallbackMarker(v: unknown): v is { __gnlFallback: true; attempts: number; stepId: string } {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.__gnlFallback === true && typeof m.attempts === 'number' && typeof m.stepId === 'string';
}

function workflowStepKind(id: string): string {
  return id.startsWith('parallel(') ? 'parallel'
    : id.startsWith('branch(') ? 'branch'
    : id.startsWith('foreach(') ? 'foreach'
    : id.startsWith('loop(') ? 'loop'
    : 'step';
}

export interface RunOptions {
  runId: string;
  prompt?: string;
  messages?: any;
  /**
   * P1.7: PRECEDENCE — if `context` carries a server-sealed identity (see sealRequestContext /
   * GNL_THREAD_ID_KEY), that value ALWAYS wins over this field. Chosen deliberately: `context` is where
   * A server-side caller (e.g. @gnldev/server after auth) seals the AUTHENTICATED identity, so it must not
   * Be overridable by a plain top-level RunOptions field a less-trusted caller could also set.
   */
  threadId?: string;
  /** P1.7: same precedence as `threadId` above — a server-sealed `context` resourceId wins. */
  resourceId?: string;
  approvals?: Record<string, boolean>;
  /** Request context: passed to dynamic model/system/tools functions (organization/role/user…). */
  context?: RequestContext;
  /** Playground session overrides (agent definition is used if not given). */
  model?: string;
  temperature?: number;
  topP?: number;
  system?: string;
  /** Playground tool allow-list: if given, only these tool NAMES are exposed to the model this run
   *  (a subset of the agent's resolved tools). Names not in the resolved set are ignored. */
  tools?: string[];
  /** W1 (opt-in): per-run cost cap + loop detection — INHERITED by sub-agents. */
  limits?: RunLimits;
  /**
   * Run-lock for multiple workers
   * Running the SAME runId concurrently. `runDurable` supported this, but the registry (createGnl/
   * Gnl.run) did NOT forward it → the lock was silently dropped in the high-level API. Without the lock,
   * Different workers' distinct toolCallIds bypass the toolCallId-keyed tool-claim (two LIVE runs of the
   * Same runId) → only tools marked `idempotency: 'args'` get deduped. The lock SERIALIZES the run: only
   * One runs, the other gets RunBusyError. (Not needed for single-worker usage.)
   */
  lock?: { owner: string; ttlMs: number };
  /**
   * These protections lived only on the low-level runDurable args and were unreachable through
   * CreateGnl — the documented main path could not enable strict tool-policy, strict replay, timeouts, or
   * Model-step exclusivity. Opt-in; forwarded to runDurable/streamDurable (toolPolicy also to sub-agents).
   */
  toolPolicy?: 'strict' | 'strict-critical';
  replay?: 'strict' | 'lenient';
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * (b) — `stream()` only (run() already THROWS on a block, so there is nothing extra to
   * Surface there): invoked once at stream finish when a loop/maxToolCalls/duplicate/tainted block or
   * A durable-tool block sentinel fired, with the RAW structured breach `{ kind, message, detail }`.
   * Advisory — a throw from it is swallowed with a console.warn. See StreamDurableArgs.onBlocked.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
  /**
   * P0.2 thread a request's AbortSignal into generation — forwarded AS-IS to
   * RunDurable/streamDurable, which don't destructure it (see the `...rest` spread ~run.ts:650/885) so it
   * Lands directly in `generateText`/`streamText`'s own `abortSignal` option. Lets a caller (e.g.
   * @gnldev/chat-adapter's chat route, wired to `c.req.raw.signal`) stop token generation on client disconnect
   * WITHOUT touching the resumable-SSE replay story: an abort just ends generation early — the journal
   * Keeps whatever prefix already completed, and a later call with the SAME runId resumes/replays exactly
   * As it would have without an abort ever happening.
   */
  abortSignal?: AbortSignal;
}

export function createGnl(config: CreateGnlConfig) {
  // Task 3 (opt-in): run BEFORE anything else — a version-skewed suite should be caught up front, not
  // After agents/tools are already wired against a possibly-incompatible sibling package.
  if (config.checkSuiteConsistency) {
    assertSuiteConsistent({ onMismatch: config.checkSuiteConsistency === 'throw' ? 'throw' : 'warn' });
  }
  // Resolve memory once: explicit `false` → off; if not given, memoryFactory (if any) derives it from the journal.
  const journal: Journal = config.storage ? config.storage.runs : config.journal!;
  if (!journal) throw new Error('createGnl: `storage` or `journal` is required');
  const memSource: Storage | Journal = config.storage ?? config.journal!;
  const resolvedMemory: Memory | undefined =
    config.memory === false
      ? undefined
      : config.memory ?? (config.memoryFactory ? config.memoryFactory(memSource) : undefined);
  function agent(name: string): AgentConfig {
    const a = config.agents?.[name];
    if (!a) throw new Error(`agent '${name}' is not registered`);
    return a;
  }

  /**
   * Model chain → single model: string specs are resolved via the router; multiple candidates enter
   * The deterministic fallback wrapper (the winner is written to `<runId>:cfg:model` via CAS, sticks
   * On resume). Object models are tracked with the '#<index>' label (chain order must be stable).
   */
  async function materializeModel(spec: ModelInput | ModelInput[], runId: string) {
    const chain = Array.isArray(spec) ? spec : [spec];
    if (chain.length === 0) throw new Error('model chain is empty');
    const candidates: FallbackCandidate[] = [];
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i]!;
      candidates.push(typeof m === 'string' ? { spec: m, model: await resolveModel(m) } : { spec: `#${i}`, model: m });
    }
    return withModelFallback(candidates, journal, runId);
  }

  /**
   * Converts `a.workflows` names into `workflow_<name>` tools.
   *
   * Mirrors `buildSubAgentTools` deliberately, contract for contract: the child runId comes from
   * The toolCallId, so the SAME parent step always maps to the SAME workflow run — replaying the
   * Parent skips a completed workflow instead of launching a second one. A suspended workflow is
   * Returned as data (`suspended`, `stepId`, `reason`), not thrown: the agent asked a question and
   * "it is waiting on a human" is an answer.
   */
  function buildWorkflowTools(names: string[] | undefined): ToolSet {
    const out: ToolSet = {};
    for (const wfName of names ?? []) {
      if (!config.workflows?.[wfName]) {
        // The same early, clear refusal `agent()` gives for an unknown sub-agent: at wiring time,
        // Naming what exists — not a mid-run "not registered" from inside a tool call.
        throw new Error(
          `agent config names workflow '${wfName}', but it is not registered. `
          + `Registered workflows: ${Object.keys(config.workflows ?? {}).join(', ') || '(none)'}`,
        );
      }
      out[`workflow_${wfName}`] = Object.assign(aiTool({
        description: `Start the '${wfName}' workflow and return its output`,
        // Declared as JSON Schema, not zod, and deliberately. `@ai-sdk/provider-utils` forces
        // `additionalProperties: false` on every object it converts through its ZOD 4 path
        // (addAdditionalPropertiesToJsonSchema, reached from zod4Schema but not zod3Schema), so on
        // zod 4 this schema told the provider the input accepts NO properties at all. Measured:
        //   zod 3.25.76 → {"type":"object","additionalProperties":{}}
        //   zod 4.4.3   → {"type":"object","propertyNames":{...},"additionalProperties":false}
        // It is not specific to z.record — `z.looseObject({})` and `z.object({}).passthrough()` are
        // clobbered identically, so no zod spelling survives. A workflow takes an arbitrary input
        // object by definition, and jsonSchema() bypasses the converter, which also makes this
        // independent of whichever zod major the host installs.
        inputSchema: jsonSchema<{ input?: Record<string, unknown> }>({
          type: 'object',
          properties: {
            input: {
              type: 'object',
              additionalProperties: true,
              description: 'input object handed to the workflow',
            },
          },
        }),
        execute: async ({ input }: { input?: Record<string, unknown> }, options: any) => {
          // Parent-scoped, for the same reason as agent-tool's nested runId above: a toolCallId is
          // unique within a completion, not across runs.
          const r = await runWorkflow(wfName, input ?? {}, { runId: nestedAgentRunId(options?.parentRunId, options?.toolCallId, 'wf') });
          return r.suspended
            ? { suspended: true, stepId: r.stepId, reason: r.reason, runId: r.runId }
            : { output: r.output, runId: r.runId };
        },
      }), { idempotent: true });
    }
    return out;
  }

  /** C5: converts `a.agents` names into `agent_<name>` tools (model factory that freezes fallback into the nested runId).
   * If `limits` is given (the parent's RunOptions.limits), it's inherited by the sub-agent AS-IS. */
  async function buildSubAgentTools(names: string[] | undefined, rc: RequestContext, limits?: RunLimits): Promise<ToolSet> {
    const out: ToolSet = {};
    for (const subName of names ?? []) {
      const sub = agent(subName); // early, clear error if not registered
      out[`agent_${subName}`] = createAgentTool(
        {
          journal,
          model: async (nestedRunId) => materializeModel(await resolveDyn(sub.model, rc), nestedRunId),
          tools: sub.tools ? await resolveDyn(sub.tools, rc) : undefined,
          system: sub.system ? await resolveDyn(sub.system, rc) : undefined,
          guard: sub.guard,
          maxSteps: sub.maxSteps,
          limits,
        },
        // The description field flows to both the network router and the agent-as-tool introduction (single source).
        { description: sub.description ?? `Delegate a task to the '${subName}' agent` },
      );
    }
    return out;
  }

  async function run(name: string, opts: RunOptions) {
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: a server-sealed resourceId/threadId (sealRequestContext) ALWAYS wins over opts.resourceId/
    // Opts.threadId when present — see the RunOptions.resourceId/threadId precedence note below.
    const serverIdentity = serverIdentityOf(rc);
    const effectiveResourceId = serverIdentity.resourceId ?? opts.resourceId;
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), opts.runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    const subTools = await buildSubAgentTools(a.agents, rc, opts.limits);
    const wfTools = buildWorkflowTools(a.workflows);
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    // Playground tool allow-list: expose only the requested subset to the model (agent tools unchanged).
    const runTools = opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools;
    const result = await runDurable({
      runId: opts.runId,
      journal: journal,
      agentName: name,
      model,
      tools: runTools,
      system,
      guard: a.guard,
      memory: resolvedMemory,
      threadId: effectiveThreadId,
      resourceId: effectiveResourceId,
      approvals: opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.lock ? { lock: opts.lock } : {}), // : forward the distributed run-lock to runDurable (see the RunOptions.lock note)
      // Forward the protections that were previously runDurable-only.
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      ...(config.schemaCompat ? { schemaCompat: config.schemaCompat } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any);

    // C4 runtime scoring: only on a COMPLETED run (not suspended). Each scorer is memoized to the
    // Journal → doesn't rerun on resume/repeat calls (exactly-once), returns the same score.
    // P1.2: opt-in sampling (AgentConfig.scorerSampling) gates the WHOLE block — a skipped run writes
    // NOTHING (durableProcessorStep, and hence the `proc:eval:*` journal key, is never reached), and the
    // Decision is deterministic per runId so resume/replay can't flip it (see shouldSampleScorers).
    if (a.scorers?.length && result.interrupts.length === 0 && shouldSampleScorers(opts.runId, effectiveScorerRate(a))) {
      const scores: Record<string, unknown> = {};
      // Input = the run prompt (if a string): so question-requiring scorers like answerRelevancy/completeness
      // Can also work in the registry (otherwise they'd silently always return 0). RAG context isn't available here — see ScorerLike.
      const sample: { output: string; input?: string } = { output: (result as any).text ?? '' };
      if (typeof opts.prompt === 'string' && opts.prompt) sample.input = opts.prompt;
      for (const s of a.scorers) {
        scores[s.name] = await durableProcessorStep(journal, opts.runId, `eval:${s.name}`, () => s.score(sample));
      }
      (result as any).scores = scores;
      // P2-skor a SECOND, ADDITIVE metrics pass — recordRunMetrics (run.ts's
      // Completion choke points) already ran and cannot see `scores` (computed HERE, after it runs —
      // See the comment on that call below). Best-effort/non-blocking: a scoring bug or a journal
      // Without incrBy/applyBatch must never fail an otherwise-successful run. Only reached on the
      // Sampled-IN path (shouldSampleScorers above) — see recordRunScores's JSDoc for the resulting bias.
      recordRunScores(journal, opts.runId, name, scores as Record<string, number | { score: number }>).catch(() => {});
    }

    // P1.6b: materialized metrics recording moved from here DOWN into run.ts's completion choke points
    // (next to recordRunUsage in runDurableInner AND in streamDurable's onFinish) — ONE source covers
    // Run()/stream()/resume/bare-runDurable alike; no registry-level hook needed. See metrics.ts.
    return result;
  }

  // The streaming counterpart of run: resolves model/tools/system/guard/memory/processors the SAME way.
  // The only difference (per streamDurable's docs): output processors only apply to messages that get
  // Persisted — streamed text-deltas can't be retroactively transformed.
  // (a): streamDurable now ENFORCES the run-lock (acquire at start, release on stream finish) →
  // Opts.lock is forwarded. NOTE the documented difference from run(): a streamed lock does NOT
  // Self-renew (no heartbeat — see StreamDurableArgs.lock), so a stream outliving ttlMs can be taken
  // Over. Use a generous ttlMs, or run() if you need the mid-run heartbeat guarantee.
  // P1.6b: streamed runs' materialized-metrics recording lives in streamDurable's onFinish (run.ts,
  // Next to recordRunUsage) — the former TODO here is closed; no backfill dependency remains.
  async function stream(name: string, opts: RunOptions) {
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: same server-identity precedence as run() above — see RunOptions.threadId/resourceId JSDoc.
    const serverIdentity = serverIdentityOf(rc);
    const effectiveResourceId = serverIdentity.resourceId ?? opts.resourceId;
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), opts.runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    const subTools = await buildSubAgentTools(a.agents, rc, opts.limits);
    const wfTools = buildWorkflowTools(a.workflows);
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    const runTools = opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools;
    return streamDurable({
      runId: opts.runId,
      journal: journal,
      agentName: name,
      model,
      tools: runTools,
      system,
      guard: a.guard,
      memory: resolvedMemory,
      threadId: effectiveThreadId,
      resourceId: effectiveResourceId,
      approvals: opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      // + B3(a): same protection forwards as run(), now INCLUDING lock (streamDurable enforces
      // It — see the stream lock note above; the only difference is no self-renew heartbeat).
      ...(opts.lock ? { lock: opts.lock } : {}),
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      // (b): stream-only visibility callback (run() throws instead — see RunOptions.onBlocked).
      ...(opts.onBlocked ? { onBlocked: opts.onBlocked } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any);
  }

  /**
   * Runs a dynamic network: the router assigns a task to one of the registered agents each turn
   * (nested durable run, runId = `net:<runId>:<i>`) or writes the final answer. Sub-agent semantics
   * Are the SAME as agent-tool (model fallback freezes into the nested runId, limits inherited AS-IS,
   * NO memory) — the only difference is that the selection comes from the router-LLM instead of a
   * Static `agent_<name>` tool, and CAS-freeze is applied to the decision.
   */
  async function runNetwork(
    name: string,
    opts: { runId: string; task: string; context?: RequestContext; limits?: RunLimits; approvals?: Record<string, boolean> },
  ): Promise<NetworkResult> {
    const net = config.networks?.[name];
    if (!net) throw new Error(`network '${name}' is not registered`);
    const rc = opts.context ?? {};
    // Targets are set up BEFORE the router model → an unregistered agent gives a clear error before model resolution.
    // Sub-agent call semantics are CENTRALIZED in runSubAgent (same path as agent-tool; interrupts propagate upward).
    const targets: Record<string, NetworkTarget> = {};
    for (const subName of net.agents) {
      const sub = agent(subName); // early, clear error if not registered
      targets[subName] = {
        description: sub.description,
        run: async (task, nestedRunId) =>
          runSubAgent(
            {
              journal,
              model: async (rid) => materializeModel(await resolveDyn(sub.model, rc), rid),
              tools: sub.tools ? await resolveDyn(sub.tools, rc) : undefined,
              system: sub.system ? await resolveDyn(sub.system, rc) : undefined,
              guard: sub.guard,
              maxSteps: sub.maxSteps,
              limits: opts.limits,
              approvals: opts.approvals,
              // The network router runs under opts.runId — carry its taint into each sub-agent.
              parentRunId: opts.runId,
            },
            task,
            nestedRunId,
          ),
      };
    }
    const routerModel = await materializeModel(await resolveDyn(net.router, rc), opts.runId);
    return runNetworkCore({
      runId: opts.runId,
      journal,
      routerModel,
      agents: targets,
      task: opts.task,
      system: net.system ? await resolveDyn(net.system, rc) : undefined,
      maxIterations: net.maxIterations,
    });
  }

  /** Introspect registered networks (studio Networks view: name + target agents). */
  function listNetworks(): { name: string; agents: string[]; maxIterations: number }[] {
    return Object.entries(config.networks ?? {}).map(([name, n]) => ({
      name,
      agents: n.agents,
      maxIterations: n.maxIterations ?? 6,
    }));
  }

  /** Introspect registered workflows (name + steps + kind). */
  function listWorkflows(): WorkflowMeta[] {
    return Object.entries(config.workflows ?? {}).map(([name, wf]) => ({
      name,
      steps: wf.build().map((s) => ({ id: s.id, kind: workflowStepKind(s.id) })),
    }));
  }

  /** Runs a workflow durably; collects step outputs from the journal and returns them. Suspend-safe.
   * Step-through: opts.maxSteps only applies to workflows with runResumable (returns paused).
   * P0.4 opts.resume/opts.signal are forwarded to runResumable AS-IS (only
   *  Workflows with runResumable can use them — a plain `run()`-only WorkflowLike has no suspend/cancel
   *  Story to attach them to); a `{status:'canceled'}` result maps into `WorkflowRunResult.canceled`
   *  The SAME way `suspended`/`paused` already do. */
  async function runWorkflow(name: string, input: unknown, opts?: { runId?: string; maxSteps?: number; resume?: Record<string, unknown>; signal?: AbortSignal }): Promise<WorkflowRunResult> {
    const wf = config.workflows?.[name];
    if (!wf) throw new Error(`workflow '${name}' is not registered`);
    const runId = opts?.runId ?? `wf-${name}-${Date.now()}`;
    const ctx = { runId, journal: journal };
    let output: unknown;
    let suspended = false;
    let paused = false;
    let canceled = false;
    let stepId: string | undefined;
    let reason: unknown;
    if (wf.runResumable) {
      const rOpts = {
        ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
        ...(opts?.resume ? { resume: opts.resume } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        // FLOW-08: `name` is known here (the registry key) — mirrored into the `wfrun:` status
        // Record so the run registry/studio can display the workflow's name.
        workflowName: name,
      };
      const r = await wf.runResumable(input, ctx, Object.keys(rOpts).length ? rOpts : undefined);
      if (r.status === 'suspended') { suspended = true; stepId = r.stepId; reason = r.reason; }
      else if (r.status === 'paused') { paused = true; stepId = r.stepId; }
      else if (r.status === 'canceled') { canceled = true; stepId = r.stepId; reason = r.reason; }
      else output = r.output;
    } else {
      if (opts?.maxSteps != null) throw new Error(`workflow '${name}' does not support step-through (no runResumable)`);
      try {
        output = await wf.run(input, ctx);
      } catch (e: any) {
        if (e?.name === 'WorkflowSuspended') { suspended = true; reason = e?.reason; }
        else throw e;
      }
    }
    const steps: WorkflowRunResult['steps'] = [];
    for (const s of wf.build()) {
      // A plain `get`, deliberately: @gnldev/workflow writes this marker with a plain `put` for
      // Exactly this reason. Its retry COUNTER cannot be read here — on a backend with `incrBy` it
      // Lives in a counter map rather than the field, so a naive read would return nothing on
      // Postgres/Redis while looking correct in memory, and the reader that knows the difference is
      // In @gnldev/workflow, which this file must not import (see the structural-type note above).
      //
      // The `_` is that package's reserved-control-key prefix, and the brand is checked rather than
      // Trusted: an unprefixed key was ALSO the key of a nested step named `fallback`, whose ordinary
      // Output then came back as a substitution marker and made a step that never failed report that
      // It had. The prefix stops that collision; the brand stops any other value from posing as one,
      // Since what is read here is a journal a host also writes to.
      const raw = await journal.get<unknown>(`${runId}:wf:${s.id}:_fallback`);
      const fallback = isFallbackMarker(raw) ? { attempts: raw.attempts, stepId: raw.stepId } : undefined;
      steps.push({
        id: s.id,
        kind: workflowStepKind(s.id),
        output: await journal.get(`${runId}:wf:${s.id}`),
        ...(fallback ? { fallback } : {}),
      });
    }
    return { runId, output, suspended, paused, canceled, stepId, reason, steps };
  }

  /**
   * The RESOLVED conversation store, exposed because nothing else could reach it.
   *
   * `memory` is resolved here — `config.memory`, else `config.memoryFactory(storage)`, else none — and
   * a host that passes the FACTORY (which is what an organization-scoped deployment must pass: one
   * shared object cannot carry an org boundary) never sees the instance that was built for a given
   * organization. @gnldev/server needs exactly that instance to serve a thread read, and was otherwise
   * left with a store it could write through `run()` but never read back.
   *
   * `undefined` when memory is off (`memory: false`, or neither option given), which is the same
   * answer a caller gets for a deployment that keeps no conversations.
   */
  return { agent, run, stream, listWorkflows, runWorkflow, runNetwork, listNetworks, memory: resolvedMemory };
}
