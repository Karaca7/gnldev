import { nestedAgentRunId } from './journal.js';
import { randomUUID } from 'node:crypto';

let wfAnonCounter = 0; // runWorkflow's anon-fallback uniqueness within a process — see the warn below
import type { ToolSchemaRuleLike } from './types.js';
import { stepCountIs, tool as aiTool, jsonSchema } from 'ai';
import { runDurable, streamDurable, assertRunIdSafe } from './run.js';
import type { StreamBreach } from './run.js';
import { resolveModel, withModelFallback, type FallbackCandidate } from './model-router.js';
import { createAgentTool, runSubAgent } from './agent-tool.js';
import { runNetwork as runNetworkCore, type NetworkResult, type NetworkTarget } from './network.js';
import { acquireRunLock } from './run-lock.js';
import { claim as journalClaim, claimIdentityInput, runKeys } from './journal.js';
import { argsHash, derivedRunId, isDerivedRunId, DEPLOYMENT_SCOPE, type WorkScope, type WorkScopeKind } from './hash.js';
import { RunBusyError, runBusyMessage, RunSweptError, RunInputMismatchError, RunOwnerMismatchError, ThreadOwnerMismatchError } from './errors.js';
import { recordIdemConflict } from './idem-ledger.js';
import { durableProcessorStep } from './processor.js';
import { recordRunScores } from './metrics.js';
import { assertSuiteConsistent } from './suite-consistency.js';
import { createSuggestions, validateSuggestionsConfig } from './suggestions.js';
import { PRESET_MATRIX, PRESET_DEFAULT } from './policy-matrix.js';
import type { SuggestionsApi, SuggestionsConfig } from './suggestions.js';

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
 * fill in (see sealRequestContext below) — mirror of the common "reserved resource-id key" convention,
 * where a reserved requestContext key carries the AUTHENTICATED resourceId so a client-supplied value
 * in the request body can never impersonate another organization/user.
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
 * client-supplied `context.__gnl_resourceId`/`__gnl_orgId`/`__gnl_threadId` in the request body would
 * otherwise be indistinguishable from a value the SERVER derived from the authenticated identity — a
 * client could smuggle `{ context: { __gnl_resourceId: 'victim-user' } }` and have it silently win
 * downstream (memory lookup, dynamic model/system resolution), reading/writing another organization's data.
 * Mirrors the common "reserved resource-id key" design: a reserved requestContext key that only server code
 * writes, so a client can never override its own identity through the request body.
 *
 * ALWAYS overwrites the three reserved keys — even a key `server` has NO value for is stripped from the
 * client-supplied context (deleted, never left as `undefined` either): a spoofed key must not survive by
 * omission just because the server didn't happen to supply that particular field this call.
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
 *  context doesn't carry are simply ABSENT from the result (never `undefined`-valued properties). */
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
 * the resolved model (string spec) freezes into `:cfg:model` → same model on resume even if the agent
 * definition changes.
 */
export type DynamicArg<T> = T | ((ctx: RequestContext) => T | Promise<T>);

async function resolveDyn<T>(v: DynamicArg<T>, ctx: RequestContext): Promise<T> {
  return typeof v === 'function' ? await (v as (c: RequestContext) => T | Promise<T>)(ctx) : v;
}

/** P1.2: FNV-1a (32-bit) — a cheap, dependency-free, stable string hash (same algorithm across Node
 *  versions/platforms, unlike relying on iteration order or object hashing). Used ONLY to bucket runIds
 *  for scorer sampling — not a security hash, no collision-resistance requirement here. */
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
 *  invalid-value/warn-once contract. No `scorerSampling` at all → 1 (existing behavior: score every run). */
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
 *  is a runId hash and not Math.random(). Bucket space is 0..9999 (four-digit resolution is plenty for a
 *  sampling *rate*, and keeps the hash→bucket math exact in floating point). */
function shouldSampleScorers(runId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = fnv1a32(runId) % 10000;
  return bucket < rate * 10000;
}

/**
 * Structural compatibility with @gnldev/evals's Scorer (a reverse import would be circular). Runtime
 * scoring: when a run completes, each scorer is memoized under `${runId}:proc:eval:${name}` →
 * EXACTLY-ONCE (even llmJudge doesn't rerun on resume/repeat calls, the same score is returned).
 * Same key schema as scoreRun — studio /runs/:id/score sees the same records.
 */
export interface ScorerLike {
  name: string;
  /**
   * Runtime scoring sample: `output` = the agent's final text, `input` = the run prompt (if given as a string).
   * NOTE: RAG context (`context`) is NOT AVAILABLE here — scorers that require context (faithfulness,
   * hallucination, contextPrecision) always return 0 in registry scorers; use them with `scoreRun`,
   * which builds a custom sample.
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
   * sub-agent is fully skipped on parent resume).
   */
  agents?: string[];
  /**
   * Workflows this agent may START, by registry name — the missing direction of composition.
   *
   * A workflow has always been able to contain agents (its steps call them); an agent could not
   * reach a workflow at all, so "look this up, and if it needs the full onboarding pipeline, kick
   * it off" was not expressible. Each name becomes a `workflow_<name>` tool. The nested workflow
   * runs DURABLY on the same journal under a runId derived from the tool call
   * (`wf:<toolCallId>`), so a parent resume does not start it twice — the same exactly-once
   * contract `agents` already has.
   */
  workflows?: string[];
  /** C4 runtime scorers: automatic, journal-memoized (exactly-once) scoring when a run completes. */
  scorers?: ScorerLike[];
  /**
   * P1.2 opt-in sampling for `scorers` — without this, EVERY completed run pays
   * for every scorer (can be llmJudge, i.e. a full extra model call per scorer per run). `rate` is the
   * fraction of runs scored, 0..1 (0 = never, 1 = always/default-equivalent). Invalid values (NaN,
   * <0, >1, non-number) are treated as 1 (score everything) with a ONE-TIME console.warn — never throw,
   * a misconfigured sampling rate must not take an agent down.
   *
   * DETERMINISTIC BY DESIGN — derived from a stable hash of `runId`, NOT `Math.random()`:
   * replay consistency: `run()` can be called again for the SAME runId (resume, at-least-once
   *    delivery, a retried HTTP call) — a coin-flip sampler would risk scoring once and skipping the
   *    next time (or vice versa) for the identical run, which is both confusing (the same run "flips")
   *    and breaks the exactly-once memoization contract scorers otherwise have (see ScorerLike).
   * uniform sampling: a hash of runId spreads pseudo-randomly across the bucket space regardless of
   *    how runIds are minted (sequential, UUID, timestamp-prefixed, ...), so the sampled subset doesn't
   *    silently skew toward (or away from) any run-id pattern.
   * cost rationale: scorers (especially LLM-judge ones) are a per-run cost multiplier; sampling lets
   *    an agent get a statistically representative quality signal at a fraction of the spend.
   */
  scorerSampling?: { rate: number };
  /**
   * WHICH ADDRESS A `workKey` IS UNIQUE WITHIN, for this agent. Default `'resource'`.
   *
   * `'resource'` — the job belongs to a PERSON. Ayşe's `invoice-4471` and Mehmet's `invoice-4471`
   * are two jobs, because the subject is hashed into the run identity alongside the name.
   * `'org'` — the job belongs to the INSTALLATION (or the organization): tonight's reconciliation,
   * the nightly sweep, the cron that must run once no matter which of six workers woke up first.
   *
   * THE COST OF PICKING THE WRONG ONE IS NOT SYMMETRIC, and that asymmetry is why this is a
   * per-agent declaration instead of a per-call convenience (§6):
   *
   *   wrong `'resource'` → NOISY AND CHEAP. Work that should have been shared runs twice. Somebody
   *     sees two runs in Studio, or pays two invoices' worth of tokens, and fixes it that afternoon.
   *   wrong `'org'`      → SILENT AND DANGEROUS. Two tenants derive ONE id, so the second caller is
   *     handed the FIRST caller's answer — a cross-customer leak that looks, from every log line, like
   *     an ordinary cache hit. The counter-advocate's measured scenario had three separate gates
   *     watching this happen and none of them able to see it: the request was well-formed, the id
   *     existed, and the reply was a legitimate replay of a run that really was under that id.
   *
   * So the engine does not treat the two as equal choices. `'resource'` is the default, a `'resource'`
   * agent called with no subject is REFUSED rather than quietly widened (fail-closed — a missing
   * address is an unanswered question, not a bigger scope), and an `'org'` run's actual scope value is
   * written into its `:input` record where an operator can read it back. On an installation with no
   * organizations configured, `'org'` means the deployment as a whole and carries the `'~deployment'`
   * sentinel as its address (§10.2) — deliberate, single-tenant deployments are a legitimate main
   * case, and the value is visible rather than invented in silence.
   *
   * Renaming the agent changes the identity of its unfinished work: the name is in the hash (§3), so
   * half-done jobs under the old name keep the old id and a retry under the new name starts a new run.
   * That is the honest price of "the same workKey from two agents is two jobs".
   */
  workScope?: WorkScopeKind;
  /**
   * The orgs this agent belongs to. IF NOT GIVEN, the agent is GLOBAL (every org + operator
   * sees/runs it — existing behavior). If given, only identities whose orgId is in the list (plus
   * operator=orgless) see/run it. Visibility logic is SHARED via `agentVisibleToOrg` (server + studio
   * use the same helper).
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
 * class structurally satisfies this.
 */
export interface WorkflowLike {
  build(): { id: string }[];
  run(input: any, ctx: { runId: string; journal: Journal }): Promise<any>;
  runResumable?(
    input: any,
    ctx: { runId: string; journal: Journal },
    // P0.4 resume delivers typed HITL payloads (consumed via ctx.resumeData/
    // waitForResume); signal is the in-process cancel/disconnect path, checked between steps.
    // FLOW-08: workflowName is mirrored into the `wfrun:` status record (see @gnldev/workflow's
    // runResumable) so the run registry can show which workflow a run belongs to.
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

/**
 * What `runWorkflow` accepts. Written out as a named type because package #3 gave it a third way to
 * say which run this is, and an inline literal repeated on two functions is how the outer door and the
 * inner one drift apart.
 *
 * `runId` XOR `workKey`, like every other door (see resolveWorkIdentity) — with the one difference
 * this door has always had: passing NEITHER is still allowed, and still answered with the loud
 * generated id that tells the caller their retry will not dedupe.
 *
 * `workScope` is per-call here, unlike the agent doors where it is declared once on the agent. A
 * workflow has no config object of its own to carry the declaration, and `runWorkflow` is where
 * installation-wide work actually lives (the nightly reconciliation is a workflow, not a chat turn).
 * Default `'resource'`, for the same fail-closed reason: read AgentConfig.workScope's note before
 * reaching for `'org'` — the two mistakes do not cost the same.
 */
export interface WorkflowRunOpts {
  runId?: string;
  /** Your name for this unit of work; the engine derives the run id from it. See RunOptions.workKey. */
  workKey?: string;
  /** Which address that name is unique within. Default `'resource'`. */
  workScope?: WorkScopeKind;
  maxSteps?: number;
  resume?: Record<string, unknown>;
  signal?: AbortSignal;
  resourceId?: string;
  actor?: string;
  threadId?: string;
  context?: RequestContext;
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
   * substitute rather than from the step itself. Without it the two are indistinguishable in the
   * record — a "charged via provider A" step reads identically whether it worked first time or blew
   * up twice and landed on provider B, which is the reading an operator is most likely to get wrong.
   *
   * `stepId` is the load-bearing half. `attempts` is the number CONSUMED before the substitution, and
   * since a fallback is only reached once the budget is spent it normally equals `policy.attempts` —
   * which the workflow definition already states. It differs only when a resumed run meets a policy
   * that has since been lowered, so read it as "attempts consumed", not as this run's failure count.
   *
   * TOP-LEVEL steps only. A `retry` inside a nested `asStep` workflow writes its marker under the
   * inner step's prefixed key, and this list does not enumerate inner steps at all — so a substitution
   * there is invisible here, exactly as the inner step's output already is.
   */
  steps: { id: string; kind: string; output: unknown; fallback?: { attempts: number; stepId: string } }[];
}

/**
 * WHO a request acts for, WHICH ORGANIZATION it belongs to, and WHICH CONVERSATION — the three
 * things an HTTP surface knows and this engine cannot work out for itself.
 *
 * It lives here rather than in each adapter because it was living in each adapter, twice, under
 * different names: @gnldev/chat-adapter had `resolveResourceId` + `resolveThreadId` and @gnldev/agui had
 * `resolveResourceId` + `resolveThreadId` with a different signature for the same question. Two
 * hooks per route meant a host wired one, shipped, and found the other still reading the body —
 * measured on agui, whose `resolveThreadId` result reached the SSE envelope and never the run.
 *
 * `orgId` IS THE THIRD FIELD BECAUSE THE DERIVATION NEEDS IT. `AgentConfig.workScope: 'org'` says a
 * workKey is unique within an organization, and with no org to name, `resolveWorkIdentity` falls
 * back to the deployment sentinel (§10.2). @gnldev/server's REST route has always passed the org
 * through; the two adapters could not, because this type had nowhere to put it. That is not a 400 —
 * it is worse, because it succeeds: the same org's same named work derives one id through REST and a
 * different one through the chat or AG-UI surface, so one job becomes two runs and two charges, and
 * the surface the request happened to arrive through is the only thing that decided which.
 *
 * Takes a web `Request`, not a framework context, for the reason already written on
 * `OrgOptions.resolve` in @gnldev/server: a host binding these routes from Express or Fastify has a
 * Request and no Context.
 *
 * HONEST BOUND, and it decides what every ownership guarantee downstream is worth: a resolver
 * reading an UNAUTHENTICATED request asserts a subject nobody verified. Read it from a session
 * cookie, a verified JWT, `principalOf(req)?.id` — never from the body. Put auth in front of the
 * route, or the subject is only as trustworthy as the caller. The same goes double for `orgId`: it
 * is an isolation boundary, and a caller who can choose their own org has none.
 */
// May return a Promise: real token verification (WebCrypto, a JWKS fetch) is async, and a resolver
// that cannot await is a resolver that reads claims nobody verified. Widened before first release —
// after it, the same widening would have been a breaking change for every synchronous caller.
export type GnlIdentity = (req: Request) =>
  | { resourceId?: string; orgId?: string; threadId?: string }
  | undefined
  | Promise<{ resourceId?: string; orgId?: string; threadId?: string } | undefined>;

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
   * package manager's caret range would normally prevent (see suite-consistency.ts
   * `assertSuiteConsistent`). `true` → warn on mismatch (default), `'throw'` → hard error at
   * `createGnl()` time. Default: `undefined` (OFF) — existing behavior byte-for-byte unchanged; this is
   * a new opt-in check, not a new implicit requirement.
   */
  checkSuiteConsistency?: boolean | 'throw';
  /**
   * Provider-specific tool-schema compatibility, same meaning as runDurable's option: `true` for the
   * default rule set, or an explicit list. Applies to every agent this registry runs.
   *
   * It is declared here because @gnldev/tool-schema's README documents exactly this call —
   * `createGnl({ ...config, schemaCompat: defaultRules })` — and until now the registry forwarded a
   * fixed allowlist of options to runDurable that did not include it, so the package's only
   * documented integration was silently doing nothing.
   */
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  /**
   * FAZ-4 — the banking/defense/medical bundle, as ONE opt-in switch. `'critical'` applies, for
   * every run()/stream() call (explicit opts still win, field by field):
   *   toolPolicy 'strict-critical'          (side-effect tools must answer the crash window)
   *   limits.sideEffectDuplicates { action:'suspend', scope:'thread' } — the repeat becomes a
   *     human question EVERY time, across the whole conversation (a deliberate second identical
   *     job is approved into existence, an accidental one is refused; threadId-less runs fall back
   *     to run scope with a loud warn — the F3 contract)
   *   exclusiveModelStep on                 (closes the concurrent same-runId model-claim gap)
   *   lock on                               (auto owner, ttl 300s — a concurrent duplicate 409s)
   *   strictInput + actor binding on        (one runId = one request, one owner)
   *   conflictLedger on                     (every refusal leaves a PII-free trace)
   *   tombstonePolicy 'reject'              (a swept runId's late retry is refused, not re-run)
   * JOURNAL GUIDANCE (documented, not enforced): prefer Postgres. If Redis is a hard requirement,
   * configure `waitReplicas: { replicas: 1, timeoutMs: 1000, onTimeout: 'throw' }` — and know the
   * honest bound: the throw fires AFTER the write, so an unacknowledged claim becomes VISIBLE, not
   * undone; treat thrown claims as a reconciliation suspect list.
   * SINGLE-HOME BOUND (the guarantee's edge, restated where the guarantee is SOLD — full statement
   * on the Journal interface JSDoc): every exactly-once promise here — locks, fingerprints,
   * ledger, tombstones, dedup windows — holds for any number of workers sharing ONE journal store.
   * Two regions with independent journals are two independent dedup windows; a runId must always be
   * ROUTED to its home journal (per-run ownership). This is a routing contract, not a consensus
   * feature, and a multi-region deployment that ignores it silently halves every guarantee above.
   * SCOPE, stated honestly (denetçi K6): the overlay wraps run() and stream() — the agent entry
   * points. runNetwork() inherits the two protections that MAP to nested delegations (toolPolicy
   * 'strict-critical' + sideEffectDuplicates 'suspend'); locks/fingerprints stay per-entry-point.
   * RunWorkflow() (FAZ-8) is covered with the protections that MAP to workflows: required runId,
   * SideEffect-steps-must-carry-recover, tombstone reject, input fingerprint and a heartbeated
   * run-lock — step-level exactly-once stays FAZ-1's claim protocol, which workflows already carry.
   */
  preset?: 'critical' | 'assistant' | 'headless';
  /*
   * 'assistant' ve 'headless' (heyet matrisi, 7 Eyl 2026): critical'ın sertlik paketini AÇMADAN,
   * yalnız sınıf-bazlı tekrar politikasını basarlar (policy-matrix.ts):
   *   assistant → para/bildirim sorar, delete "zaten yapılmıştı" notu, upsert sessiz;
   *               replayDisclosure default 'explain' (ekranda insan var, dürüst anlatım açık).
   *   headless  → soracak insan yok: para tekrarı typed-RED (DLQ'ya düşer), bildirim/delete atlar
   *               + iz; hiçbir hücre suspend üretmez. Zarf/iz her hücrede tam (görünmezlik yasağı).
   * Workflow/lock/strictInput kapıları bu ikisine GELMEZ — onlar critical'ın kimliğidir.
   */
  /**
   * HERMES v1 — onay-kapılı öneri/öğrenme katmanı (see suggestions.ts for the full contract).
   * Two independent switches: `generate` (may the system PROPOSE memory-lessons after completed
   * runs?) and `apply` (may APPROVED lessons be injected into system prompts?). Nothing is ever
   * applied without a human decision (`gnl.suggestions.decide`), approved lessons outlive the
   * switches, and the org-promotion code path exists only when the `promotion` block is present.
   * Config contradictions THROW at createGnl time (validateSuggestionsConfig).
   * SCOPE, stated honestly (K6'nın preset dersi): injection and learning cover run() and stream() —
   * the agent entry points. Sub-agents (`agents`), network delegations and workflow agent steps do
   * NOT see lessons; extending them is a deliberate future decision, not an oversight to paper over.
   */
  suggestions?: SuggestionsConfig;
  /**
   * Replay-disclosure policy, forwarded to every run()/stream() (per-call RunOptions wins).
   * 'explain' lets the model narrate honestly when a tool result came from the journal instead of
   * executing ("the operation was not performed again") — via a TRANSIENT per-step note that never
   * persists. Default 'silent' (existing behavior). See RunDurableArgs.replayDisclosure.
   */
  replayDisclosure?: 'explain' | 'silent';
}

/**
 * Dynamic network definition: the router-LLM picks one from the `agents` list each turn, or writes
 * the final answer. Determinism: routing decisions freeze into `<runId>:net:route:<i>` via CAS
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
 * dependency only runs one way (see the WorkflowLike note above) — and checked field by field,
 * because a truthy-only test once let an ordinary step output stand in for one.
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
  /**
   * The RAW run id — still accepted, still exactly what it always was, and now one of TWO ways to say
   * which run this call belongs to (the other is `workKey` below). Pass this one when you are holding
   * an id the engine already issued (resuming derived work, following a `result.runId`) or when your
   * own system already owns a stable identifier for the job.
   *
   * Optional, not gone: exactly one of `runId` / `workKey` is required on the agent doors. Passing
   * NEITHER is refused for the same reason it always was — a run with no stable name cannot be
   * retried, resumed or deduped, and silently generating one would hand the caller a promise the
   * framework then cannot keep.
   */
  runId?: string;
  /**
   * YOUR NAME FOR THIS UNIT OF WORK. The engine derives the run id from it (§1), so you never handle
   * the id at all unless you want to.
   *
   * A `workKey` is a BUSINESS NAME — the invoice being issued, the document being published, the
   * firmware rollout for device 7742, tonight's reconciliation batch. It is not a random retry token
   * and it is not a conversation id: coming from `thread_id`, note that the same key there means
   * "continue this conversation" and here means "this is the same job". Reuse a workKey to RETRY work,
   * never to add a turn — a conversation is `threadId`, a different field, and both can be set at once.
   *
   * WHAT THE ENGINE DOES WITH IT. `runId = derive(agent, workScope, subject, workKey)` — a 128-bit
   * digest behind the `run1_` prefix. The name itself is stored in the run's record (queryable,
   * shown on operator screens); the id is opaque and is a stable PSEUDONYM of your key, not an
   * anonymisation of it (a low-entropy key is recoverable by dictionary). Keep sensitive data out of
   * it: a workKey is echoed in error details and displayed in Studio.
   *
   * WHAT HAPPENS ON THE SECOND CALL — the two axes, whose names are fixed even though v1 gives each
   * exactly one behaviour and therefore no field to set (adding a single-valued enum would be
   * furniture; the names live here so tomorrow's second value is an addition, not a break):
   *
   *   onConflict: 'reject'  — the work is RUNNING right now → `409 run_busy` (+ Retry-After).
   *   onReuse:    'replay'  — the work already FINISHED → the recorded answer comes back, nothing
   *                           re-runs, no side effect fires twice.
   *
   * And the asymmetry that is a rule rather than a footnote: a run that ended in FAILURE has no
   * answer to replay, so the same workKey is free to run again. Retrying failed work is the normal
   * case, not an escape hatch.
   *
   * HOW LONG A workKey STAYS UNIQUE: as long as the run record lives — not a minute longer.
   * Recognition is a property of the stored run, not of the text. Size your retention window so it is
   * at least as long as the longest retry your clients can produce, or turn on tombstones
   * (`tombstones: true` + `tombstonePolicy: 'reject'`) so a late retry is refused with `409 run_swept`
   * instead of silently starting the job over.
   *
   * Mutually exclusive with `runId` — passing both is refused at the call, because two identities for
   * one call is a question the engine would have to answer by guessing.
   */
  workKey?: string;
  prompt?: string;
  messages?: any;
  /**
   * P1.7: PRECEDENCE — if `context` carries a server-sealed identity (see sealRequestContext /
   * GNL_THREAD_ID_KEY), that value ALWAYS wins over this field. Chosen deliberately: `context` is where
   * a server-side caller (e.g. @gnldev/server after auth) seals the AUTHENTICATED identity, so it must not
   * be overridable by a plain top-level RunOptions field a less-trusted caller could also set.
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
   * running the SAME runId concurrently. `runDurable` supported this, but the registry (createGnl/
   * gnl.run) did NOT forward it → the lock was silently dropped in the high-level API. Without the lock,
   * different workers' distinct toolCallIds bypass the toolCallId-keyed tool-claim (two LIVE runs of the
   * same runId) → only tools marked `idempotency: 'args'` get deduped. The lock SERIALIZES the run: only
   * one runs, the other gets RunBusyError. (Not needed for single-worker usage.)
   */
  lock?: { owner: string; ttlMs: number; /** FAZ-7 stream-only: renewal cap (default 60min) — the abandonment bound; test-injectable. */ maxHoldMs?: number };
  /**
   * These protections lived only on the low-level runDurable args and were unreachable through
   * createGnl — the documented main path could not enable strict tool-policy, strict replay, timeouts, or
   * model-step exclusivity. Opt-in; forwarded to runDurable/streamDurable (toolPolicy also to sub-agents).
   */
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile) — see run.ts RunOptions for full semantics; forwarded verbatim. */
  strictInput?: boolean;
  conflictLedger?: boolean;
  auditOnReject?: 'best-effort' | 'require';
  /** Replay-disclosure policy (see CreateGnlConfig.replayDisclosure); this per-call value wins. */
  replayDisclosure?: 'explain' | 'silent';
  /** Kanal etiketi ('chat' | 'api' | 'batch:<id>'...) — XID origin'i; sorular "5 dk önce, sohbetten" diyebilsin. */
  channel?: string;
  tombstonePolicy?: 'ignore' | 'reject';
  actor?: string;
  replay?: 'strict' | 'lenient';
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * (b) — `stream()` only (run() already THROWS on a block, so there is nothing extra to
   * surface there): invoked once at stream finish when a loop/maxToolCalls/duplicate/tainted block or
   * a durable-tool block sentinel fired, with the RAW structured breach `{ kind, message, detail }`.
   * Advisory — a throw from it is swallowed with a console.warn. See StreamDurableArgs.onBlocked.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
  /**
   * P0.2 thread a request's AbortSignal into generation — forwarded AS-IS to
   * runDurable/streamDurable, which don't destructure it (see the `...rest` spread ~run.ts:650/885) so it
   * lands directly in `generateText`/`streamText`'s own `abortSignal` option. Lets a caller (e.g.
   * @gnldev/chat-adapter's chat route, wired to `c.req.raw.signal`) stop token generation on client disconnect
   * WITHOUT touching the resumable-SSE replay story: an abort just ends generation early — the journal
   * keeps whatever prefix already completed, and a later call with the SAME runId resumes/replays exactly
   * as it would have without an abort ever happening.
   */
  abortSignal?: AbortSignal;
}

/**
 * THE GATE (package #3 of docs/RUNID-WORKKEY-HEYET-KARARI.md). One function, four doors.
 *
 * `run`, `stream`, `runWorkflow` and `runNetwork` each mint a run id, and each of them now accepts a
 * `workKey` instead. Writing the rule four times is how three of them end up subtly different — the
 * measured history of this file is a list of gates that existed on the agent path and not on the
 * workflow one — so the rule lives here and the doors pass their differences in as arguments.
 *
 * THE RULE, in the order a caller meets it:
 *
 *   BOTH → refuse. Two identities for one call is a question with no honest answer: obey the runId
 *     and the declared name is a lie; obey the workKey and the id the caller passed goes nowhere.
 *   NEITHER → refuse on the agent/network doors (today's required-runId behaviour, unchanged), allow
 *     on `runWorkflow`, which has its own loud anonymous fallback and keeps it.
 *   ONLY runId → today's path, byte for byte. `assertRunIdSafe` still judges it downstream.
 *   ONLY workKey → derive. `derivedRunId(entity, scopeKind, scopeValue, workKey)`.
 *
 * WHY THE ENTITY NAME IS TYPE-PREFIXED — a micro-decision this package makes on top of §3, flagged
 * here because it is not in the decision's text. §3 requires the agent name in the tuple so two
 * agents cannot collide on one workKey. A registry can hold an agent AND a workflow under the same
 * name (`pay` the agent, `pay` the pipeline), and a bare name would collide THOSE: one digest, two
 * completely different kinds of run, and whichever started first would answer for the other. The
 * prefixes are the ones the engine already writes into its composite ids (§7's exception row):
 * `agent:`, `wf:`, `net:`.
 *
 * WHY A MISSING SUBJECT THROWS (§6). `'resource'` scope with nothing to scope to is not a wider
 * scope; it is an unanswered question. XID's fail-open posture does not transfer here: losing a
 * question costs a question, while losing the address delivers the work to the wrong door — and the
 * wrong door is another customer's. So the refusal is at the gate, before a key is written.
 *
 * WHY IT IS EXPORTED (package #5). An HTTP route needs the id BEFORE it calls the door: the
 * ownership gate reads `<runId>:input`, the cancel registry is keyed by it, and `X-Gnl-Run-Id` has
 * to say which run answered. A route that derived it with its own copy of these four lines would be
 * the fifth copy of a rule this function exists to keep at one — and the copy that drifts is the one
 * that echoes an id nothing was written under. So the surfaces call THIS, then hand the door the
 * `workKey` (not the id they just computed), and the door resolves the same tuple to the same
 * answer: one rule, two readers, no second implementation to keep honest.
 */
export type WorkIdentityRequest = {
  runId?: string;
  workKey?: string;
  /** The scope in force: the agent's declaration, or the caller's on the workflow/network doors. */
  scopeKind: WorkScopeKind;
  /** The EFFECTIVE subject (sealed identity wins — the caller works that out before asking). */
  resourceId?: string;
  /** The EFFECTIVE organization, when the deployment has one. */
  orgId?: string;
  /** What a call with neither half means on this door: 'refuse' everywhere but `runWorkflow`. */
  anonymous: 'refuse' | 'allow';
  /** How the door reads in an error message, e.g. `run('pay')`. */
  surface: string;
};

/** What the doors get back: an id to run under (absent only on the anonymous workflow path) and, when
 *  the id was derived, the declaration to freeze into the run's record so it can be read back. */
export type ResolvedWorkIdentity = { runId?: string; work?: { workKey: string; workScope: WorkScope } };

export function resolveWorkIdentity(entityName: string, req: WorkIdentityRequest): ResolvedWorkIdentity {
  const { runId, workKey, surface } = req;
  if (runId !== undefined && workKey !== undefined) {
    throw new Error(
      `@gnldev/durable: ${surface} was given BOTH a runId and a workKey — one identity, one declaration. ` +
        'A workKey is your name for the work and the engine derives the id from it; a runId IS the id. ' +
        'Pass the half you own: workKey if you are naming a job, runId if you are holding an id the engine ' +
        'already issued (a resume, a fork, an id you stored).',
    );
  }
  if (workKey === undefined) {
    if (runId !== undefined) return { runId };
    if (req.anonymous === 'allow') return {};
    throw new Error(
      `@gnldev/durable: ${surface} needs an identity — pass a workKey (your name for this unit of work; the ` +
        'engine derives the run id from it) or a runId (a raw id you already hold). Without one there is nothing ' +
        'for a retry to find, so the call could only ever run the work again.',
    );
  }
  let scopeValue: string;
  if (req.scopeKind === 'resource') {
    if (!req.resourceId) {
      throw new Error(
        `@gnldev/durable: ${surface} declared workKey '${workKey}' in a 'resource' workScope, and the call names no ` +
          'resourceId — the address the name is unique within is missing, so the engine cannot tell whose job this is. ' +
          'Pass resourceId (or seal an authenticated one onto the request context). If this job belongs to the ' +
          "installation rather than to a person — a nightly reconciliation, a scheduled sweep — declare workScope: 'org', " +
          'and read that field\'s note first: the two mistakes do not cost the same.',
      );
    }
    scopeValue = req.resourceId;
  } else {
    // An org-less installation runs org-scoped work under the deployment sentinel (§10.2). Visible,
    // not silent: the value travels into `:input.workScope.value`.
    scopeValue = req.orgId ?? DEPLOYMENT_SCOPE;
  }
  return {
    runId: derivedRunId(entityName, req.scopeKind, scopeValue, workKey),
    work: { workKey, workScope: { kind: req.scopeKind, value: scopeValue } },
  };
}

/**
 * Tool names carrying an `effectClass`, across the shared toolset and every agent's own.
 *
 * STATIC ONLY, deliberately. `AgentConfig.tools` may be a `DynamicArg` — a function resolved per
 * request with the RequestContext — and calling one here would mean inventing a context at
 * construction time to answer a diagnostic question. A dynamic toolset is simply not scanned, so the
 * warning below can miss; it never fires wrongly, which is the direction a startup warning has to
 * err in if anyone is to keep reading them.
 */
function toolsDeclaringEffectClass(config: CreateGnlConfig): string[] {
  const found = new Set<string>();
  const scan = (tools: unknown) => {
    if (!tools || typeof tools !== 'object') return;
    for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
      if (tool && typeof tool === 'object' && (tool as { effectClass?: unknown }).effectClass !== undefined) found.add(name);
    }
  };
  scan(config.tools);
  for (const a of Object.values(config.agents ?? {})) scan(a.tools);
  return [...found].sort();
}

export function createGnl(config: CreateGnlConfig) {
  // Task 3 (opt-in): run BEFORE anything else — a version-skewed suite should be caught up front, not
  // after agents/tools are already wired against a possibly-incompatible sibling package.
  if (config.checkSuiteConsistency) {
    assertSuiteConsistent({ onMismatch: config.checkSuiteConsistency === 'throw' ? 'throw' : 'warn' });
  }
  // Resolve memory once: explicit `false` → off; if not given, memoryFactory (if any) derives it from the journal.
  const journal: Journal = config.storage ? config.storage.runs : config.journal!;
  if (!journal) throw new Error('createGnl: `storage` or `journal` is required');
  const memSource: Storage | Journal = config.storage ?? config.journal!;
  // FAZ-4 journal guidance (best-effort detection, warn-only): the critical profile's claims should
  // not ride async replication — see CreateGnlConfig.preset's JOURNAL GUIDANCE note.
  if (config.preset === 'critical' && /redis/i.test(journal?.constructor?.name ?? '')) {
    console.warn(
      "@gnldev/durable: preset 'critical' is running on a Redis journal — prefer Postgres for the critical profile, " +
      "or configure waitReplicas { replicas: 1, timeoutMs: 1000, onTimeout: 'throw' } and treat thrown claims as a reconciliation suspect list.",
    );
  }
  // A declaration nothing reads. `effectClass` is the tool's half of the policy matrix — it says what
  // a REPEAT of this tool costs — and the only thing that ever reads it is a profile
  // (`limits.sideEffectDuplicates.byClass`, which `preset` fills in; see policy-matrix.ts and
  // durable-tool.ts's dupConfigOf). Without one, `byClass` is absent, `dupConfigOf` falls through to
  // the plain default, and a tool that carefully declared itself `transactional` is treated exactly
  // like one that declared nothing. The author has done the hard half and gets none of the benefit,
  // with nothing on screen to say so — which is the shape of a silent misconfiguration rather than a
  // missing feature.
  //
  // Warn, not throw, and config-time rather than per-call: a per-call `opts.limits.sideEffectDuplicates
  // .byClass` ALSO activates these declarations, and this function cannot see one. So the message says
  // both remedies and does not pretend the declarations are certainly dead — a caller who passes
  // limits per run is doing it right and should be able to read that from the sentence.
  if (!config.preset) {
    const declared = toolsDeclaringEffectClass(config);
    if (declared.length) {
      console.warn(
        `@gnldev/durable: ${declared.length} tool(s) declare \`effectClass\` but no profile reads it: ${declared.join(', ')}. ` +
        "A declaration is only consulted through `limits.sideEffectDuplicates.byClass`, which `preset` writes — " +
        "add `preset: 'assistant'` (or 'headless' / 'critical') to createGnl's config, or pass `limits.sideEffectDuplicates.byClass` " +
        'on every run(). Until then these tools dedup exactly like undeclared ones.',
      );
    }
  }
  const resolvedMemory: Memory | undefined =
    config.memory === false
      ? undefined
      : config.memory ?? (config.memoryFactory ? config.memoryFactory(memSource) : undefined);
  /**
   * The same resolution, with the ONE distinction the engine needs and the public surface does not:
   * whether "no memory" was DECLARED or merely never configured.
   *
   * run.ts warns once when a `threadId` arrives with nothing to put it in (warnThreadIgnored), and
   * `memory: false` is how a project says it meant that. Keeping the public `gnl.memory` at
   * `Memory | undefined` matters more than reusing one variable here: callers destructure it and
   * check it for truthiness, and widening it to `false` would change a documented return type to buy
   * nothing on that side.
   */
  const memoryArg: Memory | false | undefined = config.memory === false ? false : resolvedMemory;
  // HERMES v1: validated LOUDLY at construction (semantic layer's precedent — a static contradiction
  // must be impossible to ship), then built once; run()/stream() consult it per call.
  let suggestionsApi: SuggestionsApi | undefined;
  if (config.suggestions) {
    validateSuggestionsConfig(config.suggestions, journal);
    suggestionsApi = createSuggestions(journal, config.suggestions);
  }
  function agent(name: string): AgentConfig {
    const a = config.agents?.[name];
    if (!a) throw new Error(`agent '${name}' is not registered`);
    return a;
  }

  /**
   * Model chain → single model: string specs are resolved via the router; multiple candidates enter
   * the deterministic fallback wrapper (the winner is written to `<runId>:cfg:model` via CAS, sticks
   * on resume). Object models are tracked with the '#<index>' label (chain order must be stable).
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
   * the toolCallId, so the SAME parent step always maps to the SAME workflow run — replaying the
   * parent skips a completed workflow instead of launching a second one. A suspended workflow is
   * returned as data (`suspended`, `stepId`, `reason`), not thrown: the agent asked a question and
   * "it is waiting on a human" is an answer.
   */
  /** `identity` — buildSubAgentTools ile aynı gerekçe: devretmek sahibi düşürmek değildir. */
  function buildWorkflowTools(names: string[] | undefined, identity?: { resourceId?: string; threadId?: string; actor?: string }): ToolSet {
    const out: ToolSet = {};
    for (const wfName of names ?? []) {
      if (!config.workflows?.[wfName]) {
        // The same early, clear refusal `agent()` gives for an unknown sub-agent: at wiring time,
        // naming what exists — not a mid-run "not registered" from inside a tool call.
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
          // Ajan İÇİNDEN doğan iş akışı: ebeveynin kimliğini devralır. "Org düzeyi iş, öznesi yok"
          // muafiyeti bu doğum yolu için yanlış — bu, belli bir kullanıcının koşumundan çıkıyor.
          const r = await runWorkflow(wfName, input ?? {}, {
            runId: nestedAgentRunId(options?.parentRunId, options?.toolCallId, 'wf'),
            ...(identity?.resourceId ? { resourceId: identity.resourceId } : {}),
            ...(identity?.threadId ? { threadId: identity.threadId } : {}),
            ...(identity?.actor ? { actor: identity.actor } : {}),
          });
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
  /**
   * `identity` — devredilen işin SAHİBİ. Taint, limits ve toolPolicy bu sınırı yıllardır geçiyordu;
   * kimlik geçmiyordu, yani "devret" sessizce "koruma katmanını kapat" anlamına geliyordu. Alt koşum
   * sahipsiz doğunca ownershipDenied `!owner` dalında geçiyor, actor kilidi ateşlemiyor ve
   * purgeResource o koşumu kişi silme talebinde hiç bulamıyor.
   */
  async function buildSubAgentTools(names: string[] | undefined, rc: RequestContext, limits?: RunLimits, toolPolicy?: 'strict' | 'strict-critical', identity?: { resourceId?: string; threadId?: string; actor?: string; channel?: string }): Promise<ToolSet> {
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
          ...(identity?.resourceId ? { resourceId: identity.resourceId } : {}),
          ...(identity?.threadId ? { threadId: identity.threadId } : {}),
          ...(identity?.actor ? { actor: identity.actor } : {}),
          ...(identity?.channel ? { channel: identity.channel } : {}),
          ...(toolPolicy ? { toolPolicy } : {}), // FAZ-4 K12: the JSDoc's 'toolPolicy also to sub-agents' is now true
        },
        // The description field flows to both the network router and the agent-as-tool introduction (single source).
        { description: sub.description ?? `Delegate a task to the '${subName}' agent` },
      );
    }
    return out;
  }

  async function run(name: string, opts: RunOptions) {
    if (config.preset === 'critical') {
      opts = {
        ...opts,
        toolPolicy: opts.toolPolicy ?? 'strict-critical',
        lock: opts.lock ?? { owner: `critical-${randomUUID()}`, ttlMs: 300_000 },
        exclusiveModelStep: opts.exclusiveModelStep ?? {},
        // Sınıf-bazlı matris (heyet): beyansız araç default hücresiyle BUGÜNKÜ davranışta kalır
        // (thread-suspend); beyanlı araç kendi hücresini alır (idempotent-write'ta soru sorulmaz vb.).
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX.critical, default: PRESET_DEFAULT.critical }, ...(opts.limits ?? {}) },
        strictInput: opts.strictInput ?? true,
        conflictLedger: opts.conflictLedger ?? true,
        tombstonePolicy: opts.tombstonePolicy ?? 'reject',
      };
    } else if (config.preset === 'assistant' || config.preset === 'headless') {
      // Hafif profiller: YALNIZ tekrar-politikası matrisi (+ assistant'ta dürüst anlatım default'u).
      // critical'ın kilit/fingerprint/ledger paketi bilinçli olarak gelmez.
      opts = {
        ...opts,
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX[config.preset], default: PRESET_DEFAULT[config.preset] }, ...(opts.limits ?? {}) },
        ...(config.preset === 'assistant' ? { replayDisclosure: opts.replayDisclosure ?? 'explain' } : {}),
      };
    }
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: a server-sealed resourceId/threadId (sealRequestContext) ALWAYS wins over opts.resourceId/
    // opts.threadId when present — see the RunOptions.resourceId/threadId precedence note below.
    const serverIdentity = serverIdentityOf(rc);
    const effectiveResourceId = serverIdentity.resourceId ?? opts.resourceId;
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    // THE GATE (package #3), before the model is resolved and therefore before anything touches the
    // journal: from here on `runId` is the run's id — either the raw one the caller passed or the one
    // the engine derived from their workKey. The scope comes from the AGENT, not from the call: which
    // address a name is unique within is a property of the work an agent does, and a per-call override
    // would put the dangerous half ('org', see AgentConfig.workScope) within reach of a request body.
    const identity = resolveWorkIdentity(`agent:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: a.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `run('${name}')`,
    });
    const runId = identity.runId!;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    const subTools = await buildSubAgentTools(a.agents, rc, opts.limits, opts.toolPolicy, {
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
    });
    const wfTools = buildWorkflowTools(a.workflows, {
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    // Playground tool allow-list: expose only the requested subset to the model (agent tools unchanged).
    const runTools = opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools;
    // HERMES apply: the lesson block is FROZEN per runId (claim, empty included) BEFORE composing the
    // system prompt — a retry of the same runId sees the identical prompt even if a lesson was
    // approved in between (strictInput's fingerprint stays honest). See suggestions.ts.
    let effectiveSystem = system;
    if (suggestionsApi) {
      const inj = await suggestionsApi.prepareInjection(runId, effectiveResourceId);
      if (inj.text) effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${inj.text}` : inj.text;
    }
    const result = await runDurable({
      runId,
      journal: journal,
      agentName: name,
      model,
      tools: runTools,
      system: effectiveSystem,
      guard: a.guard,
      memory: memoryArg,
      threadId: effectiveThreadId,
      resourceId: effectiveResourceId,
      // SAHİPLİK DAMGASI — ÖNCELİK BURADA KURULUR: mühürlü kimlik kazanır, çağıranın beyanı değil.
      // Bu satır eklendiğinde aşağıda ayrıca `...(opts.actor ? { actor: opts.actor } : {})` vardı ve
      // object-literal'de SON yazan kazandığı için damgayı EZİYORDU. Sonuç sessizdi: doğrulanmış
      // kimlikten basılan damganın üzerine isteğin gövdesinden gelen bir değer geçiyordu — yani
      // sahiplik kilidi kendi kendine verilebilir hale geliyordu, ki o zaman kilit değildir.
      // opts.actor SİLİNMEDİ, geri plana alındı: mühür kurmayan hostlar (kendi rotasını yazan
      // uygulamalar, CLI, testler) için tek kimlik kanalı odur — ama yalnız mühürlü kimlik YOKKEN.
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      approvals: opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.lock ? { lock: opts.lock } : {}), // : forward the distributed run-lock to runDurable (see the RunOptions.lock note)
      // Forward the protections that were previously runDurable-only.
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      // FAZ-4 critical-profile forwards (no-ops unless set — see RunOptions).
      ...(opts.strictInput !== undefined ? { strictInput: opts.strictInput } : {}),
      ...(opts.conflictLedger !== undefined ? { conflictLedger: opts.conflictLedger } : {}),
      ...(opts.auditOnReject ? { auditOnReject: opts.auditOnReject } : {}),
      ...((opts.replayDisclosure ?? config.replayDisclosure) ? { replayDisclosure: opts.replayDisclosure ?? config.replayDisclosure } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.tombstonePolicy ? { tombstonePolicy: opts.tombstonePolicy } : {}),
      ...(config.schemaCompat ? { schemaCompat: config.schemaCompat } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal
      // The declaration travels with the run so package #2's writer can freeze it into `:input`:
      // the id is opaque, and the answer to "which run was the invoice job?" has to live somewhere
      // a person can read. Only present when the id was DERIVED — a raw runId declared nothing.
      ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any);

    // C4 runtime scoring: only on a COMPLETED run (not suspended). Each scorer is memoized to the
    // journal → doesn't rerun on resume/repeat calls (exactly-once), returns the same score.
    // P1.2: opt-in sampling (AgentConfig.scorerSampling) gates the WHOLE block — a skipped run writes
    // NOTHING (durableProcessorStep, and hence the `proc:eval:*` journal key, is never reached), and the
    // decision is deterministic per runId so resume/replay can't flip it (see shouldSampleScorers).
    if (a.scorers?.length && result.interrupts.length === 0 && shouldSampleScorers(runId, effectiveScorerRate(a))) {
      const scores: Record<string, unknown> = {};
      // input = the run prompt (if a string): so question-requiring scorers like answerRelevancy/completeness
      // can also work in the registry (otherwise they'd silently always return 0). RAG context isn't available here — see ScorerLike.
      const sample: { output: string; input?: string } = { output: (result as any).text ?? '' };
      if (typeof opts.prompt === 'string' && opts.prompt) sample.input = opts.prompt;
      for (const s of a.scorers) {
        scores[s.name] = await durableProcessorStep(journal, runId, `eval:${s.name}`, () => s.score(sample));
      }
      (result as any).scores = scores;
      // P2-skor a SECOND, ADDITIVE metrics pass — recordRunMetrics (run.ts's
      // completion choke points) already ran and cannot see `scores` (computed HERE, after it runs —
      // see the comment on that call below). Best-effort/non-blocking: a scoring bug or a journal
      // without incrBy/applyBatch must never fail an otherwise-successful run. Only reached on the
      // sampled-IN path (shouldSampleScorers above) — see recordRunScores's JSDoc for the resulting bias.
      recordRunScores(journal, runId, name, scores as Record<string, number | { score: number }>).catch(() => {});
    }

    // HERMES generate: the learning pass runs only on a COMPLETED run (an interrupted run is an
    // unfinished story — no lesson yet), memoized AT-MOST-ONCE per runId inside generateFor, and
    // best-effort by contract: a learning failure must never fail an otherwise-successful run.
    // stream() has no auto-pass (a stream returns before completion); hosts call
    // gnl.suggestions.generateFor from their finish hook when they want streamed runs to learn.
    if (suggestionsApi && config.suggestions?.generate && result.interrupts.length === 0) {
      try {
        await suggestionsApi.generateFor({
          runId,
          resourceId: effectiveResourceId,
          threadId: effectiveThreadId,
          ...(typeof opts.prompt === 'string' && opts.prompt ? { prompt: opts.prompt } : {}),
          output: (result as any).text ?? '',
        });
      } catch { /* best-effort — see the contract above */ }
    }

    // P1.6b: materialized metrics recording moved from here DOWN into run.ts's completion choke points
    // (next to recordRunUsage in runDurableInner AND in streamDurable's onFinish) — ONE source covers
    // run()/stream()/resume/bare-runDurable alike; no registry-level hook needed. See metrics.ts.
    return result;
  }

  // The streaming counterpart of run: resolves model/tools/system/guard/memory/processors the SAME way.
  // The only difference (per streamDurable's docs): output processors only apply to messages that get
  // persisted — streamed text-deltas can't be retroactively transformed.
  // (a): streamDurable now ENFORCES the run-lock (acquire at start, release on stream finish) →
  // opts.lock is forwarded. FAZ-7: the streamed lock now SELF-RENEWS on a ttl/2 heartbeat (parity
  // with run()) — the old "no heartbeat, use a generous ttl" bound is closed; ttlMs is back to being
  // the crash-takeover window, not a worst-case-duration estimate.
  // P1.6b: streamed runs' materialized-metrics recording lives in streamDurable's onFinish (run.ts,
  // next to recordRunUsage) — the former TODO here is closed; no backfill dependency remains.
  async function stream(name: string, opts: RunOptions) {
    if (config.preset === 'critical') {
      opts = {
        ...opts,
        toolPolicy: opts.toolPolicy ?? 'strict-critical',
        lock: opts.lock ?? { owner: `critical-${randomUUID()}`, ttlMs: 300_000 },
        exclusiveModelStep: opts.exclusiveModelStep ?? {},
        // Sınıf-bazlı matris (heyet): beyansız araç default hücresiyle BUGÜNKÜ davranışta kalır
        // (thread-suspend); beyanlı araç kendi hücresini alır (idempotent-write'ta soru sorulmaz vb.).
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX.critical, default: PRESET_DEFAULT.critical }, ...(opts.limits ?? {}) },
        strictInput: opts.strictInput ?? true,
        conflictLedger: opts.conflictLedger ?? true,
        tombstonePolicy: opts.tombstonePolicy ?? 'reject',
      };
    } else if (config.preset === 'assistant' || config.preset === 'headless') {
      // Hafif profiller: YALNIZ tekrar-politikası matrisi (+ assistant'ta dürüst anlatım default'u).
      // critical'ın kilit/fingerprint/ledger paketi bilinçli olarak gelmez.
      opts = {
        ...opts,
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX[config.preset], default: PRESET_DEFAULT[config.preset] }, ...(opts.limits ?? {}) },
        ...(config.preset === 'assistant' ? { replayDisclosure: opts.replayDisclosure ?? 'explain' } : {}),
      };
    }
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: same server-identity precedence as run() above — see RunOptions.threadId/resourceId JSDoc.
    const serverIdentity = serverIdentityOf(rc);
    const effectiveResourceId = serverIdentity.resourceId ?? opts.resourceId;
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    // THE GATE, the same call run() makes and deliberately not a variation of it (see
    // resolveWorkIdentity): chat-adapter and agui stream, so a rule that held only on the generate
    // path would be a rule missing from the two doors most requests actually arrive through.
    const identity = resolveWorkIdentity(`agent:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: a.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `stream('${name}')`,
    });
    const runId = identity.runId!;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    const subTools = await buildSubAgentTools(a.agents, rc, opts.limits, opts.toolPolicy, {
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
    });
    const wfTools = buildWorkflowTools(a.workflows, {
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    const runTools = opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools;
    // HERMES apply: same frozen-injection contract as run() — see the note there.
    let effectiveSystem = system;
    if (suggestionsApi) {
      const inj = await suggestionsApi.prepareInjection(runId, effectiveResourceId);
      if (inj.text) effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${inj.text}` : inj.text;
    }
    return streamDurable({
      runId,
      journal: journal,
      agentName: name,
      model,
      tools: runTools,
      system: effectiveSystem,
      guard: a.guard,
      memory: memoryArg,
      threadId: effectiveThreadId,
      resourceId: effectiveResourceId,
      // SAHİPLİK DAMGASI — ÖNCELİK BURADA KURULUR: mühürlü kimlik kazanır, çağıranın beyanı değil.
      // Bu satır eklendiğinde aşağıda ayrıca `...(opts.actor ? { actor: opts.actor } : {})` vardı ve
      // object-literal'de SON yazan kazandığı için damgayı EZİYORDU. Sonuç sessizdi: doğrulanmış
      // kimlikten basılan damganın üzerine isteğin gövdesinden gelen bir değer geçiyordu — yani
      // sahiplik kilidi kendi kendine verilebilir hale geliyordu, ki o zaman kilit değildir.
      // opts.actor SİLİNMEDİ, geri plana alındı: mühür kurmayan hostlar (kendi rotasını yazan
      // uygulamalar, CLI, testler) için tek kimlik kanalı odur — ama yalnız mühürlü kimlik YOKKEN.
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      approvals: opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      // + B3(a): same protection forwards as run(), now INCLUDING lock (streamDurable enforces
      // it — see the stream lock note above; FAZ-7: heartbeat parity with run() included).
      ...(opts.lock ? { lock: opts.lock } : {}),
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      // FAZ-4 critical-profile forwards (no-ops unless set — see RunOptions).
      ...(opts.strictInput !== undefined ? { strictInput: opts.strictInput } : {}),
      ...(opts.conflictLedger !== undefined ? { conflictLedger: opts.conflictLedger } : {}),
      ...(opts.auditOnReject ? { auditOnReject: opts.auditOnReject } : {}),
      ...((opts.replayDisclosure ?? config.replayDisclosure) ? { replayDisclosure: opts.replayDisclosure ?? config.replayDisclosure } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.tombstonePolicy ? { tombstonePolicy: opts.tombstonePolicy } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      // (b): stream-only visibility callback (run() throws instead — see RunOptions.onBlocked).
      ...(opts.onBlocked ? { onBlocked: opts.onBlocked } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal
      // The declaration travels with the run so package #2's writer can freeze it into `:input`:
      // the id is opaque, and the answer to "which run was the invoice job?" has to live somewhere
      // a person can read. Only present when the id was DERIVED — a raw runId declared nothing.
      ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any);
  }

  /**
   * Runs a dynamic network: the router assigns a task to one of the registered agents each turn
   * (nested durable run, runId = `net:<runId>:<i>`) or writes the final answer. Sub-agent semantics
   * are the SAME as agent-tool (model fallback freezes into the nested runId, limits inherited AS-IS,
   * NO memory) — the only difference is that the selection comes from the router-LLM instead of a
   * static `agent_<name>` tool, and CAS-freeze is applied to the decision.
   */
  async function runNetwork(
    name: string,
    // `resourceId`/`threadId`/`actor`/`channel` — kimlik alanları BURADA YOKTU, yani ağ yolu bir
    // özneyi taşıyamıyordu bile: host vermek istese verecek yeri yoktu. Ajan yollarıyla (`run`,
    // `stream`) aynı şekil; yönlendirme bir kimlik değişimi değildir.
    // `runId`/`workKey`/`workScope` — the network's half of the package #3 gate. `runId` is optional
    // now because a caller may name the WORK instead (`workKey`), exactly as on the agent doors; the
    // scope is per-call here rather than per-agent, since a network has no AgentConfig of its own to
    // declare one on. Its default is the same conservative `'resource'`.
    opts: { runId?: string; workKey?: string; workScope?: WorkScopeKind; task: string; context?: RequestContext; limits?: RunLimits; approvals?: Record<string, boolean>; resourceId?: string; threadId?: string; actor?: string; channel?: string },
  ): Promise<NetworkResult> {
    const net = config.networks?.[name];
    if (!net) throw new Error(`network '${name}' is not registered`);
    const rc = opts.context ?? {};
    // Ajan yollarıyla AYNI öncelik: mühürlü kimlik kazanır, gövdeden gelen ancak mühür yokken.
    const serverIdentity = serverIdentityOf(rc);
    const effectiveResourceId = serverIdentity.resourceId ?? opts.resourceId;
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    const effectiveActor = serverIdentity.resourceId ?? opts.actor;
    // THE GATE (package #3) — the same one the agent doors call. It sits above `assertRunIdSafe`
    // because the id being judged may not exist yet: a caller who declared a workKey has no id until
    // this line mints one.
    const identity = resolveWorkIdentity(`net:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: opts.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `runNetwork('${name}')`,
    });
    const runId = identity.runId!;
    // AYNI SINIF AÇIK, aynı kapı: `runNetworkCore` bu runId'yi anahtar öneki olarak kullanıyor
    // (`netKeys`), yani ağ yolu da rezerve bir aileyi ele geçirebiliyordu. İç içe alt-ajan id'leri
    // (`net:<runId>:<i>`) kendi köklerini `net:` yaptığı için oradan sızmıyor — sızan, router'ın
    // KENDİ koşum kimliği. Süzgeç model çözümlemesinden ve her journal I/O'sundan önce — türetilmiş
    // id de buradan geçer, ama geçeceği baştan bellidir: `run1_<32 hex>` rezervasyonun kabul ettiği
    // TEK şekil. Süzgecin işi hâlâ ham, çağıran seçimi bir adın başkasının ailesini sahiplenmesi.
    assertRunIdSafe(runId);
    // THREAD SAHİPLİĞİ — iş akışı yoluna kurulan kapının (runWorkflow, yukarıda) aynısı, aynı gerekçeyle.
    // Ağ yolu da gövdeden `threadId` + `resourceId` alıyor, yani `{resourceId:'mallory',
    // threadId:'t-ayse'}` burada da yazılabiliyordu: `net-x:input` mallory'yi sahip, Ayşe'nin thread'ini
    // konu yazar ve `purgeResource('mallory')` o koşumdan `purgeThread('t-ayse')`e ulaşır.
    //
    // Kapı MÜHÜRLENMİŞ çift üstünde: `serverIdentityOf` zaten gövdeyi eziyor, kapının başka bir çifte
    // bakması iki yönlü bir kaçak olurdu.
    //
    // SINIR: memory yoksa ya da `getThreadResource` yoksa kapı KURULMAZ (ajan ve iş akışı yollarıyla
    // kelimesi kelimesine aynı koşul) — sahibi doğrulayacak bilgi yokken reddetmek, doğrulanamayan bir
    // iddiayı suç saymak olurdu. Sahibi HENÜZ olmayan thread de geçer: ilk tur bir thread yaratır.
    //
    // Ama OKUNAMAYAN sahip DÜŞÜRÜR — bkz. runWorkflow'daki kardeş kapının yorumu. Burada `.catch`
    // yok, bilerek: bir okuma hatası "sahibi yok" gibi okunursa kapı tam da deposu arızalıyken
    // devre dışı kalır.
    if (resolvedMemory && effectiveThreadId && effectiveResourceId && typeof resolvedMemory.getThreadResource === 'function') {
      const owner = await resolvedMemory.getThreadResource(effectiveThreadId);
      if (owner && owner !== effectiveResourceId) {
        throw new ThreadOwnerMismatchError(
          `@gnldev/durable: thread "${effectiveThreadId}" belongs to a different resourceId — this network run names "${effectiveResourceId}".`,
          { threadId: effectiveThreadId, owner, requested: effectiveResourceId },
        );
      }
    }
    // SAHİP KAYDI — iş akışındakiyle AYNI desen, aynı anahtar, aynı ilk-yazan-kazanır.
    //
    // Alt-ajanlar kimliği zaten devralıyordu (aşağıda runSubAgent'a iniyor); sahipsiz kalan ROUTER'IN
    // KENDİ koşumuydu — ve `<runId>:net:route/step` kayıtları görev metnini ve alt-ajan çıktılarını
    // taşıyor, yani kişisel veri. Sahibi yazılmayınca `purgeResource` o koşumu hiç saymıyor ve
    // `ownershipDenied` sahibi bulamayıp sessizce geçiyordu.
    //
    // `<runId>:input`'a, ağın kendi `net:` anahtarlarına değil: sahiplik kapısı,
    // `listRunsPaged({resourceId})` süzgeci ve `purgeResource` üçü de O anahtarı okuyor.
    // Beyan edilmezse hiçbir şey yazılmaz — "org düzeyi iş, öznesi yok" muafiyeti korunuyor.
    //
    // Package #3 adds the declared name to the same record and to the same condition: a DERIVED run
    // always has something to write down (its id was minted from that name), so a workKey alone is
    // now reason enough to claim the identity entry. Otherwise an org-scoped network job — the exact
    // case the exemption above protects — would hold an opaque id that nothing on earth can map back
    // to the job it was.
    if (effectiveResourceId || effectiveActor || effectiveThreadId || identity.work) {
      await claimIdentityInput(journal, runId, {
        at: Date.now(),
        ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
        ...(effectiveActor ? { actor: effectiveActor } : {}),
        ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
        ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
        network: name,
      });
    }
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
              // FAZ-7: the critical preset now reaches the network path's sub-agents with the two
              // protections that MAP here (tool policy + the duplicate ladder). Locks/fingerprints
              // are per-run concerns of the CALLER's entry point, not of nested delegations.
              // Matris sub-agent'a da iner (denetçi K6 — F7'nin 'ladder maps to sub-agents' emsali):
              // assistant'ın 'para sorar' vaadi delegasyonda warn'a düşemez, headless'ın DLQ reddi kaybolamaz.
              limits: config.preset
                ? { sideEffectDuplicates: { byClass: PRESET_MATRIX[config.preset], default: PRESET_DEFAULT[config.preset] }, ...(opts.limits ?? {}) }
                : opts.limits,
              ...(config.preset === 'critical' ? { toolPolicy: 'strict-critical' as const } : {}),
              // ONAY KANALI — ve BİLİNEN SINIRI. Bu kanal insanın yüzeye çıkan sorularına verdiği
              // cevaptır: askıya düşen alt ajanın interrupt'ı ÇOCUĞUN kendi toolCallId'siyle
              // yüzeye çıkar, insan onu cevaplar, cevap buradan geri iner. Sorun tek haritanın
              // PAYLAŞILAN id uzayında: iki alt ajanın sağlayıcı-id'leri çakışabilir (ikisi de
              // `call_0` üretebilir), yani bir alt ajana verilen onay ötekinin aynı adlı çağrısını
              // da açabilir.
              // durable-tool'daki kardeş kanal bunu kesişimle daraltıyor (nestedApprovalsFor:
              // haritadan yalnız ÇOCUĞUN sentinel'inde listelenen id'ler iner). Burada aynısı
              // uygulanamıyor, çünkü ağ kaydı çocuk interrupt listesi TUTMUYOR — daraltmanın
              // dayanacağı liste yok. Davranış bilerek değiştirilmedi; sınır burada yazılı dursun.
              approvals: opts.approvals,
              // KİMLİK, taint ile aynı sınırdan. Ağ yolu, agent-as-tool'un kardeşi ve aynı boşluğu
              // taşıyordu: yönlendirilen iş sahipsiz doğuyordu. Yönlendirme bir kimlik değişimi
              // değil — router hangi ajanı seçerse seçsin, iş hâlâ aynı kişinin işi.
              ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
              ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
              ...(effectiveActor ? { actor: effectiveActor } : {}),
              ...(opts.channel ? { channel: opts.channel } : {}),
              // The network router runs under this run's id — carry its taint into each sub-agent.
              parentRunId: runId,
            },
            task,
            nestedRunId,
          ),
      };
    }
    const routerModel = await materializeModel(await resolveDyn(net.router, rc), runId);
    return runNetworkCore({
      runId,
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
   *  workflows with runResumable can use them — a plain `run()`-only WorkflowLike has no suspend/cancel
   *  story to attach them to); a `{status:'canceled'}` result maps into `WorkflowRunResult.canceled`
   *  the SAME way `suspended`/`paused` already do. */
  /**
   * `resourceId`/`actor`/`threadId` — iş akışı koşumlarının SAHİBİ.
   *
   * Bu alanlar yoktu ve sonucu yalnız "eksik alan" değildi: `POST /workflows/runs/:id/cancel`
   * sahiplik kapısını ÇAĞIRIYOR ama kapı sahibi `<runId>:input`'tan okuyor, iş akışı ise
   * `<runId>:wf:_input`'a yazıyor — farklı anahtar, yani kontrol HİÇ ateşlemiyordu. Çağrılan ama
   * hiçbir zaman iş görmeyen bir kapı, olmayan kapıdan daha kötüdür: okuyan onu bir koruma sanır.
   *
   * Kimlik `<runId>:input`'a yazılıyor — iş akışının kendi `:wf:_input`'una değil. Sebebi tek bir
   * alan eklemekten fazlası: sahiplik kapısı, `listRuns({resourceId})` süzgeci ve `purgeResource`
   * hepsi O anahtarı okuyor. Kimliği başka bir yere koymak, üç yüzeyi de yeniden yazmak demekti.
   */
  /**
   * The workflow door's admissibility gate — `run.ts`'s `assertRunAdmissible`, in the shape this path
   * can actually wear. Order is the same, and deliberately: tombstone → owner → input fingerprint.
   *
   * IT USED TO LIVE INSIDE `if (preset === 'critical')`, all three checks, and that was the finding.
   * The agent doors stopped keying these two on a profile flag in package #3: once the engine MINTS
   * the id from a workKey (`run1_…`), the id is no longer a name the caller invented — it is a claim
   * about whose work this is and what the work is, and the engine has to keep the promise it made
   * itself. The workflow door mints exactly the same ids through exactly the same
   * `resolveWorkIdentity` and kept none of it. Measured shape of the hole: `workScope: 'org'`, one
   * workKey, two different subjects — both compute the SAME `run1_` id, the second call inherits the
   * first one's journaled steps, and on any profile but `critical` nothing objects.
   *
   * SO THE CONDITION IS THE ID, NOT THE PROFILE. `critical` still calls this for RAW ids too (that
   * profile's whole bargain is that a named run is a promise), and the owner row below is the one
   * check that stays derived-only — on a raw id, handing a run between subjects is a host's own
   * business and always has been. A raw id under any other profile never reaches here.
   *
   * TOMBSTONE IS UNCONDITIONAL HERE, with no `tombstonePolicy` to soften it, because
   * `WorkflowRunOpts` has no such field to read: the choice is refuse-or-ignore with nobody to ask,
   * and a swept derived run whose steps would silently re-fire is the wrong side to guess on.
   */
  async function assertWorkflowAdmissible(wfRunId: string, input: unknown, opts: WorkflowRunOpts | undefined): Promise<void> {
    const derived = isDerivedRunId(wfRunId);
    // Which sentence the refusal ends with. A derived id was minted by us and the caller cannot
    // simply "use a fresh runId" — they would have to name different work — so the two cases do not
    // get one blurred message.
    const because = derived
      ? 'this id was DERIVED from a workKey, so the engine vouches for it on every profile'
      : "the 'critical' profile vouches for a named run";
    if ((await journal.get(`${wfRunId}:swept`)) !== undefined) {
      await recordIdemConflict(journal, { runId: wfRunId, code: 'run_swept' });
      throw new RunSweptError(
        `@gnldev/durable: workflow run '${wfRunId}' was retention-swept — its dedup window is gone; a late retry must not silently re-run the steps (${because}). ` +
          (derived ? 'Name the work differently, or verify the external system first.' : 'Use a fresh runId.'),
        { runId: wfRunId },
      );
    }
    // THE OWNER OF A DERIVED WORKFLOW RUN — `assertRunAdmissible`'s §6 row, same both-sides-present
    // rule and same reason. A call with no subject is the org/operator case the ownership rule
    // exempts (the nightly reconciliation names nobody on purpose), and a run with no frozen subject
    // never claimed one; refusing either would be inventing an owner in order to enforce ownership.
    //
    // Read from `<runId>:input` and not `<runId>:wf:_input`: the identity claim lives on the first
    // key (workflow-identity.test.ts pins that, and `listRuns`/`purgeResource`/the cancel gate all
    // read it), while the second holds this door's input fingerprint. Two keys, two questions.
    if (derived) {
      const wfSeal = serverIdentityOf(opts?.context ?? {});
      const asking = wfSeal.resourceId ?? opts?.resourceId;
      const frozenOwner = (await journal.get<{ resourceId?: string }>(runKeys.input(wfRunId)))?.resourceId;
      if (frozenOwner && asking && frozenOwner !== asking) {
        await recordIdemConflict(journal, { runId: wfRunId, code: 'run_owner_mismatch', detail: { owner: frozenOwner, requested: asking } });
        throw new RunOwnerMismatchError(
          `@gnldev/durable: workflow run '${wfRunId}' belongs to a different subject — this call names '${asking}'. ` +
            'An engine-derived id is a hash of a scope and a workKey, so two callers inside the same org scope compute ' +
            'the same id; the run itself is still one person\'s. If this work really is shared, it is the installation\'s ' +
            'work — run it without a subject.',
          { runId: wfRunId, owner: frozenOwner, requested: asking },
        );
      }
    }
    const inputHash = argsHash(input);
    const frozen = await journal.get<{ hash?: string }>(`${wfRunId}:wf:_input`);
    // RESUME ESCAPES (denetçi blokeri — F7'nin K6 dersi, workflow'a taşınmış hali): the REAL resume
    // surfaces (Studio inbox, @gnldev/server's resume route) re-send NO input — `input` arrives
    // undefined and `opts.resume` carries the HITL payload. Both are journal-anchored resume
    // intents, not new content: admit them instead of 409'ing the approval path to death.
    const resumeIntent = frozen !== undefined && (input === undefined || opts?.resume !== undefined);
    if (frozen === undefined) {
      // K4: the claim's boolean IS decision data — a same-instant twin with DIFFERENT input can
      // lose the claim silently and then run as if ITS input were the frozen one. The loser
      // re-reads and holds itself to the winner's fingerprint.
      const won = await journalClaim(journal, `${wfRunId}:wf:_input`, { hash: inputHash, at: Date.now() });
      if (!won) {
        const winner = await journal.get<{ hash?: string }>(`${wfRunId}:wf:_input`);
        if (winner?.hash !== undefined && winner.hash !== inputHash) {
          await recordIdemConflict(journal, { runId: wfRunId, code: 'run_input_mismatch', detail: { expectedHash: winner.hash, actualHash: inputHash } });
          throw new RunInputMismatchError(
            `@gnldev/durable: workflow run '${wfRunId}' was concurrently started with DIFFERENT input (fingerprint ${winner.hash} != ${inputHash}) — one runId carries one request.`,
            { runId: wfRunId, expectedHash: winner.hash, actualHash: inputHash },
          );
        }
      }
    } else if (!resumeIntent && frozen.hash !== undefined && frozen.hash !== inputHash) {
      await recordIdemConflict(journal, { runId: wfRunId, code: 'run_input_mismatch', detail: { expectedHash: frozen.hash, actualHash: inputHash } });
      throw new RunInputMismatchError(
        `@gnldev/durable: workflow run '${wfRunId}' was started with DIFFERENT input (fingerprint ${frozen.hash} != ${inputHash}) — one runId carries one request; use a fresh runId for new content.`,
        { runId: wfRunId, expectedHash: frozen.hash, actualHash: inputHash },
      );
    }
  }

  async function runWorkflow(name: string, input: unknown, opts?: WorkflowRunOpts): Promise<WorkflowRunResult> {
    const wf = config.workflows?.[name];
    if (!wf) throw new Error(`workflow '${name}' is not registered`);
    // THE GATE (package #3), and the one door whose "neither half" answer is ALLOW: `runWorkflow` has
    // always accepted a call with no id and answered it with a loud generated one (see the warn in
    // runWorkflowInner). That fallback is not a promise this package can improve on — it says out loud
    // that the call has no dedup — so it stays exactly as it was. What changes is that there is now a
    // third thing a caller can pass instead: a name for the job.
    //
    // Note the type prefix (`wf:`): a workflow and an agent may share a registry name, and without it
    // `pay` the pipeline and `pay` the agent would derive ONE id from one workKey.
    const wfSeal = serverIdentityOf(opts?.context ?? {});
    const wfIdentityGate = resolveWorkIdentity(`wf:${name}`, {
      ...(opts?.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts?.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: opts?.workScope ?? 'resource',
      ...((wfSeal.resourceId ?? opts?.resourceId) ? { resourceId: wfSeal.resourceId ?? opts?.resourceId } : {}),
      ...(wfSeal.orgId ? { orgId: wfSeal.orgId } : {}),
      anonymous: 'allow',
      surface: `runWorkflow('${name}')`,
    });
    // The derived id becomes THIS call's runId for everything below — the critical profile's
    // required-runId check included, which is the intended reading: declaring a workKey IS naming the
    // work, so a critical deployment is satisfied by it.
    if (wfIdentityGate.runId !== undefined) opts = { ...(opts ?? {}), runId: wfIdentityGate.runId };
    // runId SÜZGECİ — journal'a HERHANGİ bir yazımdan önce. Ajan yolları (`runDurable`/`resumeRun`/
    // `streamDurable`) bunu girişte çağırıyordu; iş akışı yolu hiç çağırmıyordu ve bu, iş akışı
    // koşumları `<runId>:input`'a sahip kaydı yazmaya başladığı anda ölçülebilir bir silme silahına
    // dönüştü: `{runId:'mem', resourceId:'mallory'}` ile `mem:input` doğuyor, o kayıt artık
    // mallory'nin bir koşumu sayılıyor, `purgeResource('mallory')` onu geziyor, `purgeRun('mem')`
    // `del('mem:')` yapıyor — `mem:` ise TÜM kullanıcıların thread hafızasının kökü. Kendi verisini
    // silme hakkı, herkesin verisini silme yetkisine dönüşüyor. `thread`, `om`, `xid` ... aynı sınıf.
    //
    // Kontrol BURADA, `critical` bloğundan da önce: o blok `<runId>:swept` okuyor ve
    // `<runId>:wf:_input` claim'liyor — reddedilecek bir ad, reddedilmeden önce anahtar yaratamaz.
    // Anonim üretilen `wf-<ad>-<ms>-...` id'leri (runWorkflowInner) süzgeçten doğal geçer: kökleri
    // rezerve ailelerin hiçbiri değil. Beyan edilmemiş runId burada sorgulanmaz — o yol henüz bir ad
    // seçmedi; üretilen ad zaten güvenli aileden. workKey'den TÜRETİLEN id ise (bir üstteki kapı) bu
    // satıra bir runId olarak gelir ve sorgulanır: motorun kendi bastığı ad da süzgeçten geçsin, çünkü
    // "bizim bastığımız güvenlidir" varsayımı tam olarak yeni bir ailenin fark edilmeden doğduğu yerdir.
    if (opts?.runId !== undefined) assertRunIdSafe(opts.runId);
    // THREAD SAHİPLİĞİ — ajan yolundaki kapının (run.ts, ThreadOwnerMismatchError) iş akışı hali.
    // Ajan yollarında bu kapı vardı, iş akışı yolunda YOKTU ve sahip kaydı `wfThread`'i sorgusuz
    // yazıyordu. Ölçülen sonuç: `{runId:'x', resourceId:'mallory', threadId:'t-ayse'}` → `x:input`
    // mallory'yi sahip, Ayşe'nin thread'ini konu yazar; `purgeResource('mallory')` o koşumdan
    // `purgeThread('t-ayse')`e ulaşır ve Ayşe'nin hafızası mallory'nin silme hakkıyla silinir.
    //
    // Kapı, MÜHÜRLENMİŞ (etkili) çift üstünde çalışır — beyan edilen değil: `serverIdentityOf` zaten
    // gövdeyi eziyor, kapının başka bir çifte bakması iki yönlü bir kaçak olurdu.
    //
    // SINIR, dürüstçe: memory yoksa ya da `getThreadResource` yoksa kapı KURULMAZ. Ajan yolu da tam
    // olarak bu koşulla susuyor (run.ts:2463 ile kelimesi kelimesine aynı koşul) — parite kasıtlı.
    // Sahibi doğrulayacak bilgi yokken reddetmek, doğrulanamayan bir iddiayı suç saymak olurdu; ve
    // sahibi HENÜZ olmayan bir thread (ilk tur) de geçer, yoksa her yeni konuşma reddedilirdi.
    //
    // BİLİNMEYEN sahip geçer, OKUNAMAYAN sahip DÜŞÜRÜR. İlk yazışta burada `.catch(() => undefined)`
    // vardı ve ikisini aynı cevaba indiriyordu: bir okuma hatası "sahibi yok" gibi okunuyor, kapı da
    // tam deposu arızalıyken — yani en çok gerektiği anda — sessizce devre dışı kalıyordu. İkisi aynı
    // şey değil: biri masumiyet ("bu thread henüz kimsenin"), diğeri bilgisizlik ("kimin olduğunu
    // soramadım"). Bilgisizlik geçiş hakkı değildir; hata yayılsın, koşum başlamasın.
    {
      const gateIdentity = serverIdentityOf(opts?.context ?? {});
      const gateResource = gateIdentity.resourceId ?? opts?.resourceId;
      const gateThread = gateIdentity.threadId ?? opts?.threadId;
      if (resolvedMemory && gateThread && gateResource && typeof resolvedMemory.getThreadResource === 'function') {
        const owner = await resolvedMemory.getThreadResource(gateThread);
        if (owner && owner !== gateResource) {
          throw new ThreadOwnerMismatchError(
            `@gnldev/durable: thread "${gateThread}" belongs to a different resourceId — this workflow run names "${gateResource}".`,
            { threadId: gateThread, owner, requested: gateResource },
          );
        }
      }
    }
    // FAZ-8: the critical preset now covers the WORKFLOW entry path with the protections that MAP
    // to it (the old honest-scope note said "apply them explicitly" — this is that, done once here):
    //   runId REQUIRED            (exactly-once without a stable key is a contradiction)
    //   step policy               (a declared sideEffect step must carry recover — strict-critical's analog)
    //   tombstone reject          (a swept id's late retry is refused, not silently re-run)
    //   input fingerprint         (one runId = one input; frozen first-wins at `<runId>:wf:_input`)
    //   run-lock + heartbeat      (a concurrent duplicate of the same workflow run gets RunBusyError)
    // Refusals land in the conflict ledger (best-effort — workflow opts carry no auditOnReject yet).
    if (config.preset === 'critical') {
      if (!opts?.runId) {
        throw new Error(
          `@gnldev/durable: preset 'critical' requires an explicit runId for runWorkflow('${name}') — the generated fallback gives a retry ZERO dedup, which the critical profile exists to forbid.`,
        );
      }
      // FAST-FAIL half: top-level build() steps refuse before the run starts. Combinator legs and
      // nested (asStep) children carry their durability inside closures build() cannot see — THOSE
      // are caught by the RUNTIME net (ctx.strictSideEffects → the workflow engine refuses the step
      // before its claim; denetçi K6). Two layers on purpose: early where possible, airtight where not.
      for (const st of wf.build()) {
        const d = (st as { durability?: { sideEffect?: boolean; recover?: unknown } }).durability;
        if (d?.sideEffect === true && typeof d.recover !== 'function') {
          throw new Error(
            `@gnldev/durable: preset 'critical' — workflow '${name}' step '${st.id}' declares sideEffect without recover(); the crash window must be answered before the run starts (strict-critical's workflow analog).`,
          );
        }
      }
      const wfRunId = opts.runId;
      await assertWorkflowAdmissible(wfRunId, input, opts);
      const lockTtl = 300_000;
      const lockHandle = await acquireRunLock(journal, wfRunId, `critical-wf-${randomUUID()}`, lockTtl);
      if (!lockHandle) {
        await recordIdemConflict(journal, { runId: wfRunId, code: 'run_busy' });
        throw Object.assign(new RunBusyError(runBusyMessage(`workflow run '${wfRunId}' is already running — it is locked by another process`)), { atLockAcquisition: true });
      }
      let hbInflight: Promise<unknown> = Promise.resolve();
      const beat = setInterval(() => { hbInflight = lockHandle.renew(lockTtl).catch(() => false); }, Math.floor(lockTtl / 2));
      (beat as { unref?: () => void }).unref?.();
      try {
        return await runWorkflowInner(name, wf, input, opts, true, wfIdentityGate.work);
      } finally {
        clearInterval(beat);
        try { await hbInflight; } catch { /* a failed renew changes nothing about release */ }
        await lockHandle.release();
      }
    }
    // THE SAME GATE, WITHOUT THE PROFILE — see assertWorkflowAdmissible's note. An id the engine
    // derived carries the engine's own promise, so the three checks follow the ID here, not the
    // preset. A raw runId falls straight through, exactly as it always has: it is the caller's own
    // name for their own key and nothing was ever vouched for it on this path.
    if (opts?.runId !== undefined && isDerivedRunId(opts.runId)) {
      await assertWorkflowAdmissible(opts.runId, input, opts);
    }
    return runWorkflowInner(name, wf, input, opts, undefined, wfIdentityGate.work);
  }

  async function runWorkflowInner(name: string, wf: WorkflowLike, input: unknown, opts?: WorkflowRunOpts, strictSideEffects?: boolean, work?: { workKey: string; workScope: WorkScope }): Promise<WorkflowRunResult> {
    // The generated fallback is the SAME contract as the chat route's anon fallback: LOUD, never
    // silent — a fresh id per call means a retry of this exact call re-runs every step (zero dedup),
    // which is the framework breaking its own rule quietly. The id is returned on the result
    // (WorkflowRunResult.runId) so the caller can retry against it. The counter closes the same-ms
    // collision WITHIN one process; across replicas it cannot — see the id's construction below.
    let runId = opts?.runId;
    if (!runId) {
      // Süreç-içi sayaç TEK BAŞINA yetmiyor: modül düzeyinde yaşıyor, yani her replika kendi
      // sıfırından sayıyor. Ortak bir journal üstünde iki süreç aynı milisaniyede `wf-<ad>-<ms>-0`
      // üretir ve İKİ FARKLI çağrı tek koşuma düşer — exactly-once sessizce ihlal edilir. Bu yorum
      // eskiden "sayaç aynı-ms çarpışmasını kapatır" diye açık bir vaat yazıyordu; kapattığı şey
      // yalnız TEK süreç içindeki çarpışmaydı. Süreçler-arası olanı ancak süreç-dışı bir entropi
      // kaynağı kapatır. (Doğru çözüm hâlâ istikrarlı bir runId GÖNDERMEK — aşağıdaki uyarı bunu
      // söylüyor; bu satır yalnız "kötüden daha kötüye" düşmeyi engelliyor.)
      runId = `wf-${name}-${Date.now()}-${wfAnonCounter++}-${randomUUID().slice(0, 8)}`;
      console.warn(
        `@gnldev/durable: runWorkflow('${name}') called without a runId — generated '${runId}'. A retry of ` +
        `this call will NOT dedupe (every step re-runs). Pass a stable runId (it is echoed on result.runId) for exactly-once.`,
      );
    }
    // SAHİP KAYDI — ilk yazan kazanır (koşum kimliği devir boyunca değişmez). `wfrun:` durum
    // kütüğüyle karışmasın diye ayrı: o "iş akışı nerede", bu "kimin işi".
    {
      const wfIdentity = serverIdentityOf(opts?.context ?? {});
      const owner = wfIdentity.resourceId ?? opts?.resourceId;
      const wfActor = wfIdentity.resourceId ?? opts?.actor;
      const wfThread = wfIdentity.threadId ?? opts?.threadId;
      // `work` (package #3): the declared name joins the record, and joins the condition too — a
      // derived run always has something worth writing, even when nobody owns it. Tonight's
      // reconciliation is precisely that run: org-scoped, subject-less, and useless to an operator if
      // its opaque id maps back to nothing.
      if (owner || wfActor || wfThread || work) {
        await claimIdentityInput(journal, runId, {
          at: Date.now(),
          ...(owner ? { resourceId: owner } : {}),
          ...(wfActor ? { actor: wfActor } : {}),
          ...(wfThread ? { threadId: wfThread } : {}),
          ...(work ? { workKey: work.workKey, workScope: work.workScope } : {}),
          workflow: name,
        });
      }
    }
    const ctx = { runId, journal: journal, ...(strictSideEffects ? { strictSideEffects: true } : {}) };
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
        // record so the run registry/studio can display the workflow's name.
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
      // exactly this reason. Its retry COUNTER cannot be read here — on a backend with `incrBy` it
      // lives in a counter map rather than the field, so a naive read would return nothing on
      // Postgres/Redis while looking correct in memory, and the reader that knows the difference is
      // in @gnldev/workflow, which this file must not import (see the structural-type note above).
      //
      // The `_` is that package's reserved-control-key prefix, and the brand is checked rather than
      // trusted: an unprefixed key was ALSO the key of a nested step named `fallback`, whose ordinary
      // output then came back as a substitution marker and made a step that never failed report that
      // it had. The prefix stops that collision; the brand stops any other value from posing as one,
      // since what is read here is a journal a host also writes to.
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
  // HERMES v1: `suggestions` is `undefined` when the config block is absent — the feature's very
  // handle is opt-in, matching the promotion block's own no-block-no-code-path rule.
  return { agent, run, stream, listWorkflows, runWorkflow, runNetwork, listNetworks, memory: resolvedMemory, suggestions: suggestionsApi };
}
