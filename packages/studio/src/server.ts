import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { Hono, type Context } from 'hono';
import { sseResponse } from './sse.js';

import { ORG_RECORD_PRE, asReaderJournal, reconstructState, forkRun, getRunCost, withOrg, appendLog, listLog, countLog, purgeRun, purgeOrganization, orgPurgedKey, sweepRuns, sweepLog, POLICY_KEY, PRICING_KEY, effectivePricingTable, DEFAULT_PRICING, readPricing, BUDGET_PRE, readBudget, replayRun, regressionReport, resolveModel, knownModelProviders, getNetworkTrace, RunLimitExceededError, ToolLoopDetectedError, RunThreadMismatchError, blockedErrorCode, upstreamFailure, readProcessorReports, readIncidents, agentVisibleToOrg, readMetricsSummary, metricsRunKey, cancelAgentRun, listAgentRegistry, approveAgent, blockAgent } from '@gnldev/durable';
import type { PolicyDoc, PolicyRule, BudgetLimit, PricingDoc } from '@gnldev/durable';
import type { JournalReader, Journal, WorkflowLike, MetricsRunRow } from '@gnldev/durable';
import { makeGate, normalizeAuth, bindsIdentity, principalOf, isPlatformAdmin, principalScope, assertAssignablePrivileges, CLIENT_ROLE, type AuthProvider, type Principal } from '@gnldev/auth';
import { listTriggers } from '@gnldev/scheduler';
import { mountSpa, notBuiltHtml } from './spa.js';
import { openapiSpec, swaggerHtml } from './swagger.js';
import { pipeAgentStream } from './sse.js';

/** Scheduler view trigger row (same shape as @gnldev/scheduler `listTriggers` — see GET /scheduler/triggers). */
export type { TriggerInfo } from '@gnldev/scheduler';

/**
 * `ctx.orgId` is the organization the CALLER is scoped to, when there is one.
 *
 * Studio's read surface is organization-scoped: `GET /runs` lists `r1`, not `org:acme:r1`, because the
 * scoped journal strips the prefix. The host's callback, however, holds the ROOT journal — so handing it
 * the bare `r1` sent it looking for a key that only exists as `org:acme:r1:input`, and the Approve
 * button answered 500 for exactly the multi-org administrator the feature is sold to. Measured:
 * `GET /runs` → [{runId:'r1'}], `POST /runs/r1/resume` → 500 "no recorded input for runId r1".
 *
 * Passing the physical id instead would have leaked the prefix into every host that has no organizations
 * and made the id the host sees depend on who called. The org travels separately, and a host that
 * ignores it behaves exactly as before — which is why this is a third parameter and not a changed one.
 */
export interface StudioCallbackCtx { orgId?: string }

export type StudioResume = (
  runId: string,
  approvals: Record<string, boolean>,
  ctx?: StudioCallbackCtx,
) => Promise<{ text?: string; interrupts?: unknown[]; finishReason?: string }>;

export type StudioChat = (
  message: string,
  opts?: { runId?: string },
  /** The calling organization — see StudioAgentRunner.run. */
  ctx?: StudioCallbackCtx,
) => Promise<{ runId?: string; text?: string; interrupts?: unknown[]; finishReason?: string }>;

/** Metadata for a single tool (for the Tools view + agent context panel). */
export interface ToolMeta {
  name: string;
  description?: string;
  /** JSON Schema (if the app supplied `toJsonSchema`); otherwise undefined. */
  inputSchema?: unknown;
  /** True if an agent using this tool has a guard (test-run respects the guard). */
  guarded?: boolean;
}

/** Flat tool list item: which agents use it + whether it's shared. */
export interface ToolListItem extends ToolMeta {
  agents: string[];
  shared: boolean;
}

/** Agent metadata (for the playground selector; the model object is hidden → string id / 'custom'). */
export interface AgentMeta {
  name: string;
  model: string;
  system?: string;
  hasTools: boolean;
  maxSteps: number;
  /** Tools this agent sees (shared + agent-specific); filled in by createStudioRunner. */
  tools?: ToolMeta[];
  /** Orgs this org-scoped agent belongs to (UI label + visibility filter); undefined for global agents. */
  orgs?: string[];
}

/**
 * Playground runner (duck-typed): lets studio run an agent from the browser. Produced from a createGnl
 * Instance via `createStudioRunner` — the studio core does not require createGnl at runtime.
 */
export interface StudioAgentRunner {
  listAgents (): Promise<AgentMeta[]> | AgentMeta[];
  /**
   * `ctx.orgId` is the organization the caller is acting for, supplied on every call.
   *
   * These four entry points — `run`, `stream`, `runTool`, `runWorkflow`, plus `StudioChat` and
   * `StudioDatasets.run` below — received NOTHING about the caller, unlike `queue.retry`,
   * `cache.invalidate` and the workflow store, which all take a `StudioCallbackCtx`. So a host runner
   * could not behave differently per organization even if it wanted to, and nothing could prove it had
   * been told which one it was acting for. The journal it writes through is already scoped, so this is
   * not where isolation comes from; it is what makes the runner's own behaviour attributable.
   *
   * Optional, so every existing host implementation stays valid — a function of fewer parameters is
   * assignable to one declaring more.
   */
  run (name: string, opts: { runId: string; prompt?: string; messages?: unknown; threadId?: string; resourceId?: string; approvals?: Record<string, boolean>; model?: string; temperature?: number; topP?: number; system?: string; tools?: string[] }, ctx?: StudioCallbackCtx): Promise<{ text?: string; interrupts?: unknown[]; finishReason?: string }>;
  stream?(name: string, opts: { runId: string; prompt?: string; messages?: unknown; threadId?: string; resourceId?: string; approvals?: Record<string, boolean>; model?: string; temperature?: number; topP?: number; system?: string; tools?: string[] }, ctx?: StudioCallbackCtx): Promise<any>;
  /** If given, the Tools view shows the tool list. */
  listTools?(): Promise<ToolListItem[]> | ToolListItem[];
  /** If given, tools can be run for TEST purposes (respects the guard; opts.durable → writes to the
   *  Journal; opts.approve → approve/deny and resume a suspended durable test). */
  runTool?(
    name: string,
    input: unknown,
    opts?: { durable?: boolean; approve?: { runId: string; toolCallId: string; approved: boolean } },
    ctx?: StudioCallbackCtx,
  ): Promise<{ result?: unknown; error?: string; blocked?: 'deny' | 'approval'; runId?: string }>;
  /** True when runTool's durable mode is supported (a journal exists). */
  toolExecDurable?: boolean;
  /** If given, the Workflows view lists workflow definitions. */
  listWorkflows?(): WorkflowMeta[] | Promise<WorkflowMeta[]>;
  /** If given, workflows can run durably; if opts.runId is given, RESUMES the SAME run.
   * P0.4 opts.resume delivers typed HITL payloads (see @gnldev/workflow's
   *  WaitForResume); a canceled run (durable cancel or an aborted signal upstream) reports `canceled`. */
  runWorkflow?(
    name: string,
    input: unknown,
    opts?: { runId?: string; maxSteps?: number; resume?: Record<string, unknown> },
    ctx?: StudioCallbackCtx,
  ): Promise<{ runId: string; output?: unknown; suspended?: boolean; paused?: boolean; canceled?: boolean; stepId?: string; reason?: unknown; steps: { id: string; kind: string; output: unknown }[] }>;
}

/**
 * For the Memory/Threads view (optional). The app wraps a @gnldev/memory (AgentMemory) instance in this interface.
 * `listThreads` takes a resourceId (threads are indexed by resource).
 */
export interface StudioMemory {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call.
   *
   * Studio cannot verify it and does not try: this is somebody else's object with its own storage
   * behind it. Without the claim, a caller acting as an organization is REFUSED on the routes that
   * reach this object (403 `org_scope_refused`), because serving them would hand one organization another
   * organization's data. An operator with no organization scope is unaffected either way.
   *
   * DECLARED here, not just read. Every refusal message tells the host to "set `orgScoped: true` on
   * it", and the field existed nowhere in the types — so a host following that instruction got
   * `TS2353: 'orgScoped' does not exist in type ...` and the documented fix could not be written down
   * in TypeScript at all. It was read through a cast in three places, which is what hid it.
   */
  orgScoped?: boolean;
  /**
   * ONE resource's threads. The OBJECT argument matters: this type used to read
   * `listThreads(resourceId?: string)` and the route below passed a bare string, while
   * @gnldev/memory's AgentMemory reads `opts.resourceId` — so the filter silently did nothing and the
   * route answered with EVERY user's threads. Declaring a shape for someone else's method is how that
   * survived; the contract now lives in @gnldev/durable's `Memory` and this mirrors it.
   */
  listThreads (opts: { resourceId: string }): Promise<unknown[]> | unknown[];
  /** EVERY thread — the operator/global view this page shows when no resource is named. */
  listAllThreads? (): Promise<unknown[]> | unknown[];
  getMessages (threadId: string): Promise<unknown[]> | unknown[];
  getWorkingMemory?(threadId: string): Promise<unknown> | unknown;
  /** Updates the thread's title/metadata (rename). Returns 501 from the route if the adapter doesn't support it. */
  updateThread?(threadId: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<unknown> | unknown;
  /** Deletes the thread (soft-delete). Returns 501 from the route if the adapter doesn't support it. */
  deleteThread?(threadId: string): Promise<void> | void;
  /** Truncates the thread: deletes the message at `afterIndex` and every message after it (index base:
   *  The `getMessages` list — i.e. matches the `/threads/:id/messages` response 1:1). `afterIndex === -1`
   *  Deletes every message. Returns the number of deleted messages, or `null` if the underlying store
   *  Doesn't support the capability. Returns 501 from the route if the adapter doesn't support it. */
  truncateMessages?(threadId: string, afterIndex: number): Promise<number | null> | number | null;
}

/** Introspection for a single workflow (Workflows view). */
export interface WorkflowMeta {
  name: string;
  steps: { id: string; kind?: string }[];
  /** INPUT metadata the workflow expects; the `/workflows` route fills this from the `workflowInputs` option. */
  input?: { schema?: unknown; example?: unknown; description?: string };
  /** 'code' = defined in code (read-only), 'managed' = managed via the Studio editor. */
  source?: 'code' | 'managed';
  description?: string;
}

/** For the Workflows view (optional). The app extracts its own workflows via `w.build()` and provides them. */
export interface StudioWorkflows {
  listWorkflows (): Promise<WorkflowMeta[]> | WorkflowMeta[];
}

/** A managed workflow step — created/edited via the Studio editor. */
export interface WorkflowStepDef {
  id: string;
  agentName: string;
  /** Prompt template: {{input}} = initial input, {{prev}} = previous step's output. */
  prompt?: string;
}
/** A managed workflow definition — stored persistently via Studio CRUD. */
export interface WorkflowDef {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
  createdAt?: number;
  updatedAt?: number;
}
/** A single (immutable) version of a managed agent — promote only moves the pointer. */
export interface AgentVersion {
  version: number;
  model: string;
  system?: string;
  maxSteps?: number;
  /** Version note (what changed). */
  note?: string;
  createdAt: number;
}
/** Managed agent record: version history + active (prod) version number (null = never promoted). */
export interface ManagedAgentRecord {
  name: string;
  active: number | null;
  versions: AgentVersion[];
}

/** Managed workflow store — if not given, a writable journal is used automatically. */
export interface StudioWorkflowStore {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call.
   *
   * Studio cannot verify it and does not try: this is somebody else's object with its own storage
   * behind it. Without the claim, a caller acting as an organization is REFUSED on the routes that
   * reach this object (403 `org_scope_refused`), because serving them would hand one organization another
   * organization's data. An operator with no organization scope is unaffected either way.
   *
   * DECLARED here, not just read. Every refusal message tells the host to "set `orgScoped: true` on
   * it", and the field existed nowhere in the types — so a host following that instruction got
   * `TS2353: 'orgScoped' does not exist in type ...` and the documented fix could not be written down
   * in TypeScript at all. It was read through a cast in three places, which is what hid it.
   */
  orgScoped?: boolean;
  /**
   * Every method takes the calling organization, and `createStudioApp` always supplies it (see
   * `wfStoreFor`). It had NO context parameter at all, which made the refusal's documented escape
   * hatch — declare `orgScoped: true` once your object honours the `orgId` it is handed — an
   * unkeepable promise here: a host that set the flag was never told who was asking, so it served
   * every organization from one store. Measured, with the flag set: `GET /workflows` returned another
   * organization's definition including its prompt template, and `GET /workflows/:name` its steps.
   *
   * Optional, so a host implementation that ignores it still satisfies the interface — a function of
   * fewer parameters is assignable to one declaring more. That keeps existing hosts compiling, and it
   * is also why the flag has to stay an explicit claim rather than something inferred: nothing here can
   * tell whether the argument was read.
   */
  list (ctx?: StudioCallbackCtx): Promise<WorkflowDef[]> | WorkflowDef[];
  get (name: string, ctx?: StudioCallbackCtx): Promise<WorkflowDef | undefined> | WorkflowDef | undefined;
  set (def: WorkflowDef, ctx?: StudioCallbackCtx): Promise<void> | void;
  delete (name: string, ctx?: StudioCallbackCtx): Promise<void> | void;
}

/**
 * Compiles a managed WorkflowDef into an executable WorkflowLike. The host passes `compileManagedWorkflow`
 * From `@gnldev/studio/workflow` (the @gnldev/workflow import is isolated there so the studio core stays decoupled).
 * If given, managed workflows run with the SAME engine as code workflows (each step is journaled → exactly-once,
 * Suspend/resume, poll-to-stream/history/inspector all work the same way).
 */
export type CompileWorkflowFn = (
  def: WorkflowDef,
  runAgent: (name: string, opts: { runId: string; prompt?: string }) => Promise<{ text?: string }>,
  input: unknown,
) => WorkflowLike;

/** A single score result (Scorers view). */
export interface ScoreRunResultLike {
  output?: string;
  scores: Record<string, { score: number; reason?: string }>;
}

/**
 * For the Scorers/Evals view (optional). The app supplies scorer names + a scoring function
 * (internally calls @gnldev/evals `scoreRun(reader, runId, scorers, {expected})` → studio has no dependency on evals).
 */
export interface StudioScorers {
  list (): Promise<string[]> | string[];
  score (runId: string, scorerNames: string[], opts?: { expected?: string }): Promise<ScoreRunResultLike> | ScoreRunResultLike;
}

/** Eval dataset info (for the Evals view list). */
export interface DatasetMeta { id: string; cases: number; description?: string }
/** A dataset eval suite result (structurally compatible with @gnldev/evals `evalDataset` output). */
export interface EvalDatasetResultLike {
  datasetId: string;
  cases: { caseId: string; output: string; scores: Record<string, { score: number; reason?: string }> }[];
  aggregate: Record<string, number>;
}
/**
 * For the Evals/datasets view (optional). The app supplies a dataset list + a runner (internally calls
 * @gnldev/evals `evalDataset(...)` → studio has no dependency on evals).
 */
export interface StudioDatasets {
  list (): Promise<DatasetMeta[]> | DatasetMeta[];
  /** `ctx.orgId` is the calling organization — see StudioAgentRunner.run. */
  run (id: string, opts?: { scorers?: string[] }, ctx?: StudioCallbackCtx): Promise<EvalDatasetResultLike> | EvalDatasetResultLike;
}

/** An MCP server's definition as given to studio (MCP Servers view). */
export interface StudioMcpServer {
  id: string;
  name?: string;
  client: { listTools (): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }> };
}

/** Queue/Jobs view: summary of background jobs (fed by @gnldev/queue listJobs). */
export interface StudioJob { id: string; type: string; status: string; attempts: number; }
export interface StudioQueue {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call.
   *
   * Studio cannot verify it and does not try: this is somebody else's object with its own storage
   * behind it. Without the claim, a caller acting as an organization is REFUSED on the routes that
   * reach this object (403 `org_scope_refused`), because serving them would hand one organization another
   * organization's data. An operator with no organization scope is unaffected either way.
   *
   * DECLARED here, not just read. Every refusal message tells the host to "set `orgScoped: true` on
   * it", and the field existed nowhere in the types — so a host following that instruction got
   * `TS2353: 'orgScoped' does not exist in type ...` and the documented fix could not be written down
   * in TypeScript at all. It was read through a cast in three places, which is what hid it.
   */
  orgScoped?: boolean;
  /** `ctx.orgId` is the calling organization — supplied on every call, so `orgScoped: true` on this
   *  object is a promise the host can actually keep. It used to be handed nothing at all. */
  listJobs (ctx?: StudioCallbackCtx): Promise<StudioJob[]> | StudioJob[];
  /**
   * If given, `POST /jobs/:id/retry` works (the host typically wraps @gnldev/queue's `retryJob(work, id)`):
   * Re-queues a failed (dead-letter/qfail) job as a NEW job with the original type/payload, and returns
   * The new job id. Returns `null` if the job isn't found OR isn't yet terminal-failed (pending/done — to
   * Prevent DOUBLE-RUNNING it); the server reflects this as a 409.
   */
  retry?(id: string, ctx?: StudioCallbackCtx): Promise<string | null> | string | null;
}

/**
 * Dead-letter view: one quarantined delivery, shaped exactly like @gnldev/events' `DeadEvent`.
 *
 * Addressed by the TRIPLE `(topic, consumer, id)`, not by an id — a queue hands one job to one
 * worker, but a topic FANS OUT, so the same event is quarantined separately for every consumer whose
 * handler failed on it. An id alone names N records, and releasing "the" one would be a guess.
 */
export interface StudioDeadEvent {
  id: string;
  topic: string;
  consumer: string;
  /**
   * `quarantined` = parked, not being delivered. `released` = handed back, awaiting the next poll.
   * `delivered` = it eventually succeeded; the record survives as history (dead-letter history is
   * permanent for audit, same choice as the queue's `qfail`).
   */
  status: 'quarantined' | 'released' | 'delivered';
  /**
   * The last handler error, as @gnldev/events stringified it — `String(err?.message ?? err)`, the
   * message and nothing else (no stack). NOT configuration: it is text the HOST's handler produced
   * while running on `payload`, so it carries whatever that code chose to say about the data.
   *
   * That is not a hypothetical. Every validation library in common use quotes the value it rejected,
   * and the measured end-to-end answer for a handler that did so was
   * `"ValidationError: ssn '123-45-6789' invalid for customer jane@customer.example"` — the payload,
   * in the field beside the one that withheld the payload. It therefore sits behind the same
   * permission (`payloads:read`); a caller without it gets `errorRestricted: true` instead.
   *
   * Optional on the wire, `string` for a host: the host always supplies it, the SERVER decides
   * whether it leaves the process.
   */
  error?: string;
  /**
   * Set when `error` was withheld for want of `payloads:read` (never present alongside `error`).
   *
   * Same reason `payloadRestricted` exists: an absent `error` on its own is ambiguous — it reads as
   * "no error was recorded", which for a quarantined event is a claim the API would be making up.
   */
  errorRestricted?: boolean;
  attempts: number;
  /** When it was quarantined (epoch ms). */
  at: number;
  /** Set once released — a release does NOT clear the record, it stamps it. */
  releasedAt?: number;
  /** How many times it has been handed back (quarantine → release → quarantine again). */
  releases?: number;
  /**
   * The event body, exactly as the producer emitted it — END-USER DATA, not configuration.
   *
   * The host hands it over because `listDeadEvents` returns it; whether it leaves this process is a
   * SEPARATE decision, taken per request in `GET /dead-events`. It is withheld unless the caller both
   * asks for it (`?payload=1`) and carries `payloads:read`, and it is never in the default response —
   * `catalog:read`, which is all the route itself requires, is the configuration permission and this
   * is not configuration.
   */
  payload?: unknown;
}

/** One `(topic, consumer)` pair the dead-letter view can be pointed at. */
export interface StudioEventTopic { topic: string; consumers: string[] }

/**
 * Events dead-letter view (fed by @gnldev/events `listDeadEvents` / `retryDeadEvent`). Studio has no
 * DEPENDENCY on @gnldev/events — the host wraps its own WorkStore, same pattern as Queue/Cache.
 */
export interface StudioEvents {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call. Same contract, and the same default refusal, as
   * `StudioQueue.orgScoped`: studio cannot verify it and will not serve an organization-scoped caller
   * a store that has no organization boundary.
   */
  orgScoped?: boolean;
  /**
   * Which topics and consumers exist. Optional, but without it the view has nothing to address:
   * `listDead` needs a topic AND a consumer, and an operator who has to remember both by heart is
   * back at the Node REPL this view exists to replace. Omit it and the view falls back to free text.
   */
  topics?(ctx?: StudioCallbackCtx): Promise<StudioEventTopic[]> | StudioEventTopic[];
  /**
   * Quarantined deliveries for ONE `(topic, consumer)` pair — the host typically wraps
   * `listDeadEvents(work, topic, consumer)`.
   *
   * EXPENSIVE by construction: it reads the whole topic log and does a `get` per event. It is a
   * management call, not a feed — studio never polls it, and neither should a host (see the UI's
   * explicit refresh action).
   *
   * `ctx.signal` is fired when Studio gives up waiting (`deadEventScan.timeoutMs`, default 30 s). It
   * is the ONLY member of this interface that gets one, because this is the only call whose failure
   * mode is "never answers": the slot it holds is deployment-wide, so a store that accepts the query
   * and goes quiet used to close the endpoint until a restart. Honouring it (pass it to your driver,
   * to `fetch`) makes the abandonment real instead of merely observed; ignoring it costs one wasted
   * query and nothing else — Studio stops waiting either way.
   */
  listDead(topic: string, consumer: string, ctx?: StudioCallbackCtx & { signal?: AbortSignal }): Promise<StudioDeadEvent[]> | StudioDeadEvent[];
  /**
   * If given, `POST /dead-events/release` works (the host typically wraps `retryDeadEvent(work, topic,
   * consumer, eventId)`): hands a quarantined event back for delivery to that ONE consumer, in place.
   *
   * NOT the queue's retry, and the difference is visible to the operator. `retry` re-enqueues a job
   * under a NEW id, so the list afterwards holds two rows; a release UPDATES the existing record
   * (`status: 'released'`, `releases` incremented) and the list still holds one. It is also
   * per-consumer on purpose — re-emitting the event would redeliver it to every healthy consumer too.
   *
   * Returns `false` when there is nothing to release: the event was never quarantined, or it has
   * since been DELIVERED. The server reflects that as a 409, exactly as it does `retry`'s `null`.
   */
  release?(topic: string, consumer: string, id: string, ctx?: StudioCallbackCtx): Promise<boolean> | boolean;
}

/** Cache view: hit/miss ratio + size (duck-type compatible with @gnldev/cache `stats()`). */
export interface StudioCacheStats { hits: number; misses: number; hitRate: number; size: number; }
/** Cache view contract — studio has no DEPENDENCY on @gnldev/cache; the host wraps its own cache instance
 *  (same pattern as Queue/Vectors: optional, duck-typed interface). */
export interface StudioCache {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call.
   *
   * Studio cannot verify it and does not try: this is somebody else's object with its own storage
   * behind it. Without the claim, a caller acting as an organization is REFUSED on the routes that
   * reach this object (403 `org_scope_refused`), because serving them would hand one organization another
   * organization's data. An operator with no organization scope is unaffected either way.
   *
   * DECLARED here, not just read. Every refusal message tells the host to "set `orgScoped: true` on
   * it", and the field existed nowhere in the types — so a host following that instruction got
   * `TS2353: 'orgScoped' does not exist in type ...` and the documented fix could not be written down
   * in TypeScript at all. It was read through a cast in three places, which is what hid it.
   */
  orgScoped?: boolean;
  /** `ctx.orgId` is the calling organization — supplied on every call, for the same reason as
   *  `StudioQueue.listJobs`: the sibling `invalidate()` was given one and this was not. */
  stats (ctx?: StudioCallbackCtx): Promise<StudioCacheStats> | StudioCacheStats;
  /**
   * If given, `POST /cache/invalidate` works: if `key` is given, only that key is removed; if not given
   * (best-effort — CacheStore doesn't offer key enumeration), all keys the host KNOWS ABOUT are removed
   * (see @gnldev/cache `invalidate()`). Returns the number of keys removed.
   */
  invalidate?(key?: unknown, ctx?: StudioCallbackCtx): Promise<number> | number;
}

/** Knowledge view: vector store search (the host app wraps its own embed+store). */
export interface StudioVectorMatch { id: string; text: string; score: number; metadata?: Record<string, unknown>; }
export interface StudioVectors {
  /**
   * The host's explicit claim that this object keeps its own organization boundary — that it honours
   * the `ctx.orgId` it is handed on every call.
   *
   * Studio cannot verify it and does not try: this is somebody else's object with its own storage
   * behind it. Without the claim, a caller acting as an organization is REFUSED on the routes that
   * reach this object (403 `org_scope_refused`), because serving them would hand one organization another
   * organization's data. An operator with no organization scope is unaffected either way.
   *
   * DECLARED here, not just read. Every refusal message tells the host to "set `orgScoped: true` on
   * it", and the field existed nowhere in the types — so a host following that instruction got
   * `TS2353: 'orgScoped' does not exist in type ...` and the documented fix could not be written down
   * in TypeScript at all. It was read through a cast in three places, which is what hid it.
   */
  orgScoped?: boolean;
  search (query: string, topK?: number, ctx?: StudioCallbackCtx): Promise<StudioVectorMatch[]> | StudioVectorMatch[];
}

/** Safe user view exposed to studio (no secrets/tokens). */
export interface StudioUser {
  id: string;
  email?: string;
  name?: string;
  roles: string[];
  /** EXPLICIT fine-grained permissions (overrides role grants). Undefined → permission comes from roles. */
  permissions?: string[];
  orgId?: string;
  createdAt?: number;
  /** The token's expiry (epoch ms). Never expires if not given. */
  expiresAt?: number;
  /** Last successful authenticate time (epoch ms, best-effort). */
  lastUsedAt?: number;
  /** true → the token is revoked (access is cut WITHOUT deleting the user). */
  revoked?: boolean;
}
/** User management contract (paid; implemented by @gnldev/auth-ee createJournalUserStore). */
export interface StudioUserStore {
  list(): Promise<StudioUser[]> | StudioUser[];
  create(input: { email?: string; name?: string; roles?: string[]; permissions?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number }): Promise<{ user: StudioUser; token: string }>;
  remove(id: string): Promise<void>;
  /** Revokes the user's token WITHOUT deleting the user (optional — backward compat). */
  revoke?: (id: string) => Promise<void>;
  /**
   * Updates a user's roles and/or explicit permissions in place (token unchanged). Optional — a host
   * Without it returns 501 from PATCH /users/:id. An empty `permissions` array clears the explicit override.
   */
  update?: (id: string, patch: { roles?: string[]; permissions?: string[] }) => Promise<StudioUser>;
}

/** A single fine-grained permission the customer admin can assign to a user (checkbox in the UI). */
export interface PermissionCatalogEntry {
  /** The permission id enforced by the backend (e.g. 'agents:run'). MUST match a real `allowP` call. */
  id: string;
  label: string;
  group?: string;
  description?: string;
}

/**
 * PERMISSION CATALOG — the GNL-team-owned, CODE-DEFINED source of truth for fine-grained permissions.
 * READ-ONLY on purpose: customers do NOT create permission TYPES from Studio. A permission only does
 * Anything if a GNL endpoint actually ENFORCES it (via gate.allowP) — so the definition belongs to GNL,
 * Not the customer. Extending the catalog = the GNL team adding a new entry HERE *plus* its enforcement
 * (an allowP call) in a release; it is never a runtime/customer action. The customer admin only ASSIGNS
 * These permissions to users (POST/PATCH /users). Exposed read-only at GET /permissions/catalog.
 */
export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { id: 'agents:run', label: 'Run agents', group: 'run', description: 'Execute / stream / resume agents' },
  /**
   * READ, split. `*:read` alone could say who may DO something but never who may SEE something: one
   * grant covered runs, conversation content, spend and the governance log alike, so "let support read
   * runs" and "let support read every customer's messages" were the same decision.
   *
   * `*:read` stays, first, and still grants all of these — `permissionMatches` treats a `*` resource as
   * matching any (@gnldev/auth-ee rbac.ts), so every existing grant keeps working unchanged. The free
   * tier is untouched by construction: the gate reduces anything ending in `:read` to `action: 'read'`,
   * which is exactly what these routes passed before they were named.
   */
  { id: '*:read', label: 'View everything', group: 'read', description: 'All read access (every permission below)' },
  { id: 'runs:read', label: 'View runs', group: 'read', description: 'Runs, traces, steps, approvals, metrics' },
  { id: 'threads:read', label: 'View conversations', group: 'read', description: 'Thread messages, working memory, injected context — end users\' own words' },
  { id: 'money:read', label: 'View spend', group: 'read', description: 'Usage, cost, price table, organization budgets' },
  { id: 'audit:read', label: 'View the audit log', group: 'read', description: 'Who did what, and when' },
  { id: 'users:read', label: 'View users', group: 'read', description: 'The organization\'s user list' },
  /**
   * "No customer data" was the description this permission carried, and it was NOT true.
   *
   * MEASURED with a grant of exactly `['runs:read','catalog:read']`, against a real @gnldev/events
   * quarantine (a handler that threw `ValidationError: ssn '123-45-6789' invalid for customer
   * jane@customer.example`), the DEFAULT `GET /dead-events` answer was:
   *
   *   [{"error":"ValidationError: ssn '123-45-6789' invalid for customer jane@customer.example",
   *     …,"payloadRestricted":true}]
   *
   * The same row that announced the body was withheld handed over the body's contents. The gate is
   * now on `payloads:read` (below) for that field and for the scheduler's.
   *
   * `POST /knowledge/search` was the last route that broke this description: it sat behind THIS
   * permission alone and returned indexed corpus text verbatim — measured, `[{"text":"globex private
   * doc"}]` reaching an acme-bound identity. It is closed the same way, but ROUTE-LEVEL rather than by
   * projection, because the whole response is the corpus and there is no field left to withhold. The
   * description below is now true of every route that reads it, which is the only state worth
   * shipping: it is what an admin makes the grant decision on.
   */
  { id: 'catalog:read', label: 'View configuration', group: 'read', description: 'Agents, tools, workflows, policy, providers, and the operational lists — not the data flowing through them' },
  /**
   * Split out of `catalog:read` rather than folded into `threads:read`, and neither was arbitrary.
   *
   * A quarantined event's PAYLOAD is whatever the producer emitted — an order, an invoice line, a
   * support ticket someone typed. That is customer data, so it cannot sit behind a permission whose
   * own description promises configuration. But it is not a conversation either: the checkbox
   * labelled "View conversations" controlling event bodies would surprise the admin who ticks it.
   *
   * IT IS NOT ONLY THE BODY, and that is why this is `payloads:read` rather than `events:read`. Three
   * fields on two `catalog:read` routes carry data that came from OUTSIDE the configuration, and
   * gating one of them is a patch rather than a rule:
   *   - `StudioDeadEvent.payload`   — the producer's event body.
   *   - `StudioDeadEvent.error`     — `String(err?.message ?? err)` from the host's handler, which ran
   *                                   ON that body. Validation libraries quote the value they
   *                                   rejected, so this field carries the payload by another route.
   *   - `TriggerInfo.input`/`.lastError` (`GET /scheduler/triggers`) — the scheduled workflow's own
   *                                   argument, and the same `String(err?.message ?? err)` about it
   *                                   (@gnldev/scheduler writes it at `sched:fail:`).
   * One permission covers all four because they are one thing: the payload a host's code was handed,
   * and the text that code produced from it. An admin who ticks "payloads and failure text" is not
   * surprised by either half.
   *
   * BACKWARD COMPATIBLE by construction: `*:read` matches `payloads:read` through the same wildcard
   * every other named read uses, so every existing grant — and every role preset, all of which start
   * from `*:read` — keeps seeing exactly what it saw. Only an admin who has deliberately narrowed a
   * user to a named subset can now be missing it, which is the point of naming it.
   */
  { id: 'payloads:read', label: 'View payloads and failure text', group: 'read', description: 'Event bodies, scheduled trigger inputs, indexed knowledge text, and the error text a handler produced from them' },
  { id: 'run:write', label: 'Fork/resume runs', group: 'run', description: 'Fork a run or resume an approval' },
  { id: 'run:delete', label: 'Delete/purge runs', group: 'run', description: 'Permanently purge a run (GDPR)' },
  { id: 'users:write', label: 'Manage users', group: 'admin', description: 'Create / update / delete / revoke users' },
  { id: 'budget:write', label: 'Manage budgets', group: 'admin', description: 'Set per-org budget / quota' },
  { id: 'org:write', label: 'Manage organizations', group: 'admin', description: 'Create / delete organizations' },
  { id: 'policy:write', label: 'Manage policy', group: 'admin', description: 'Edit the global tool policy' },
  { id: 'workflow:write', label: 'Manage workflows', group: 'workflow', description: 'Create / update / delete managed workflows' },
];

/**
 * Role → pre-checked permissions. MIRRORS the @gnldev/auth-ee rbac.ts default grants (both are code, kept in
 * Sync by the GNL team in one release). The UI seeds a role's checkboxes from this when a role is picked;
 * The customer admin can then tick/untick individual boxes and PATCH the user's explicit permissions.
 */
export const ROLE_PERMISSION_PRESETS: Record<string, string[]> = {
  // UNCHANGED on purpose. The named read permissions exist so a customer admin can UNTICK one — the
  // starting point for each role stays what it has always been, so picking a role never silently takes
  // away access someone had yesterday. The narrower sets are a choice, not a new default.
  viewer: ['*:read'],
  member: ['*:read', 'agents:run'],
  admin: ['*'],
};

/** Role-based access: `read` gates GET (viewer), `write` gates POST resume/fork/chat (admin). Open if not given. */
export interface StudioAuth {
  read?: (req: Request) => boolean | Promise<boolean>;
  write?: (req: Request) => boolean | Promise<boolean>;
}

export interface StudioApiOptions {
  reader: JournalReader;
  /** If given, approval/fork → resume works. */
  resume?: StudioResume;
  /**
   * If given, POST /runs/:id/compensate works — the operator's "unwind this abandoned
   * Run" action. The host wires it to @gnldev/durable compensateRun with ITS tool set (the compensate
   * Hooks live in code): `compensate: (runId, o) => compensateRun(runId, { journal, tools, ...o })`.
   * IRREVERSIBLE (a condemned run never resumes) → the endpoint is write-gated and audited.
   */
  compensate?: (runId: string, opts?: { dryRun?: boolean }, ctx?: StudioCallbackCtx) => Promise<unknown>;
  /** If given, live chat works. */
  chat?: StudioChat;
  /** If given, the Playground works: pick an agent from the browser + prompt + (streaming) response + approval. */
  gnl?: StudioAgentRunner;
  /** If given, the Memory/Threads view works. */
  memory?: StudioMemory;
  /** If `memory` isn't given and reader is a writable Journal, derives StudioMemory from it (CLI/dev default). */
  memoryFactory?: (reader: Journal) => StudioMemory;
  /** If given, the Workflows view works. */
  workflows?: StudioWorkflows;
  /** Per-workflow INPUT metadata (shows expected parameters + an example in the Workflows view). Key = workflow name. */
  workflowInputs?: Record<string, { schema?: unknown; example?: unknown; description?: string }>;
  /** If given, the Scorers view works (run scoring in the Inspector). */
  scorers?: StudioScorers;
  /** If given, the Evals view works (dataset list + run suite). */
  datasets?: StudioDatasets;
  /** If given, the MCP Servers view works. */
  mcp?: StudioMcpServer[];
  /** true → the A2A Networks view (agent-to-agent call edges are extracted from the journal). */
  a2a?: boolean;
  /** If given, the Queue/Jobs view works. */
  queue?: StudioQueue;
  /** If given, the Dead-letter view works (@gnldev/events quarantine list + release). */
  events?: StudioEvents;
  /**
   * Bounds on `GET /dead-events`, the most expensive read this API serves (a whole topic log, one
   * `get` per event — 1 470 ms for 20 000 events, measured on SQLite). Both have defaults; a host
   * only touches them if its topics are much larger or its store much slower than that.
   */
  deadEventScan?: {
    /**
     * How long the host's `listDead` may take before Studio stops waiting and answers 504 (default
     * 30 000). The scan runs one at a time deployment-wide, so a store that accepts the query and
     * never answers used to hold that slot — and therefore the endpoint — until the process
     * restarted. `ctx.signal` is fired at the same moment for a host that can cancel.
     */
    timeoutMs?: number;
    /**
     * How long a request WAITS for the single scan slot before it is refused with 429 + `Retry-After`
     * (default 5 000). Waiting rather than refusing is what keeps one caller from starving the
     * others; this is the bound on how long the waiting may last. It is also the `Retry-After` a
     * caller is given before this deployment has completed a scan it could quote instead.
     */
    queueWaitMs?: number;
    /**
     * How many requests may be waiting for that slot at once (default 64). Past it, 429 — the
     * deployment is saturated. Only a deployment with more than 64 operators refreshing the
     * dead-letter view within one scan ever reaches it.
     */
    queueDepth?: number;
    /**
     * How many scans that blew `timeoutMs` may still be running inside the host before this endpoint
     * refuses to start another (default 2, answered with 503 `dead_scan_store_wedged`).
     *
     * A timeout releases Studio's slot but cannot stop the host's query — `ctx.signal` is cooperative
     * — so without this a caller in a loop piles unwatched whole-log reads onto a store that is
     * already not answering (measured: eight sequential requests, eight concurrent host scans). The
     * count falls again as those scans settle, so a store that is merely slow recovers on its own.
     */
    maxAbandonedScans?: number;
  };
  /** If given, the Cache view works (@gnldev/cache hit/miss ratio + manual invalidate). */
  cache?: StudioCache;
  /** If given, the Knowledge (vector search) view works. */
  vectors?: StudioVectors;
  /** Managed workflow store — if not given, a writable journal is used (create/edit/delete). */
  workflowStore?: StudioWorkflowStore;
  /**
   * Optional user management (a PAID feature — the contract lives here, the implementation lives in
   * @gnldev/auth-ee `createJournalUserStore`). If given, the Studio "Users" view + /users endpoints are enabled.
   * The `token` returned on creation is shown in the UI ONCE (the server never stores it in plaintext).
   */
  users?: StudioUserStore;
  /** Compiler to run a managed workflow with the real engine (@gnldev/studio/workflow → compileManagedWorkflow). */
  compileWorkflow?: CompileWorkflowFn;
  /**
   * Optional auth (opt-in). If not given, all endpoints are open. Accepts either the backward-compatible
   * `StudioAuth` {read,write} or an `AuthProvider` (free @gnldev/auth `roleAuth` or paid @gnldev/auth-ee).
   */
  auth?: StudioAuth | AuthProvider;
  /**
   * DELIBERATE opt-in to run Studio without a provider in production. Auth stays opt-in; but calling
   * CreateStudioApi/createStudioApp without `auth` under NODE_ENV=production THROWS at setup — silent
   * Fail-open was removed (audit #2). Set this flag to true if open access is really intended.
   * Outside production: just a single console.warn on the first request.
   */
  allowOpenAccess?: boolean;
  /**
   * Opt-in multi-org support (v1 = READ-ONLY audit): if an org resolves (default: the `x-gnl-org`
   * Header), the entire read surface (runs/state/diff/trace/metrics/threads) is scoped to that org via
   * WithOrg. A request without an org runs in the shared space.
   *
   * WRITES depend on WHERE the org came from, which this comment used to flatten into "writes return
   * 403". Measured:
   *
   *   x-gnl-org HEADER + write        403 — a header is not an identity, and honouring it would let
   *                                          any caller act as any organization
   *   identity-bound org + own run    200 — the principal IS the authority; this is the normal path
   *   identity-bound org + other run  404 — the run is not in that scope, so there is nothing to act on
   *
   * The option name is KEPT for consistency with @gnldev/server, whose `org` option covers the write
   * path for a host that resolves organizations itself.
   */
  org?: {
    /**
     * Takes a web `Request`, not a Hono `Context` — the last place this package's public surface
     * Leaked its own HTTP library. A host that mounts the handler from Express or Fastify has a
     * Request, never a Context, so the old signature made this option unusable exactly where the
     * Fetch handler was supposed to open the door.
     */
    resolve?: (req: Request) => string | undefined | Promise<string | undefined>;
  };
  /**
   * Eval gate (governance): this dataset suite runs BEFORE an agent is promoted; if ANY aggregate score
   * Fails to clear minAvg (default 0.5), the promote is rejected with 412. The gate decision
   * (passed/failed + aggregate) is always logged to audit. Requires the `datasets` option.
   */
  evalGate?: { datasetId: string; minAvg?: number };
  /**
   * Retention policy (POST /retention/sweep defaults): runs whose last activity is older than
   * OlderThanMs are deleted. Suspended and timestamp-less runs are always preserved (keepSuspended=false
   * Includes suspended ones in the sweep too). Sweeping is only triggered on request (the host can wire it to cron).
   */
  retention?: {
    olderThanMs: number;
    keepSuspended?: boolean;
    /**
     * Also sweep `__audit__` records older than this (ms). OFF unless set.
     *
     * Separate from `olderThanMs`, and off by default, because how long an audit trail is kept is a
     * compliance decision and not a storage one — deleting it on the same schedule as run data would
     * be an answer nobody asked for. But the log has no sweeper wired anywhere today, so it only ever
     * grows: every organization's writes land in the single root log, and nothing removes them.
     */
    auditOlderThanMs?: number;
  };
  /**
   * Org budgets (GET /organizations): an org's limit is `perOrg[id] ?? default`; exceeded =
   * (if usdLimit is set, costUsd>usdLimit) || (if tokenLimit is set, tokens>tokenLimit).
   */
  budgets?: { default?: { usdLimit?: number; tokenLimit?: number }; perOrg?: Record<string, { usdLimit?: number; tokenLimit?: number }> };
  /**
   * Alert webhook: if defined, a SINGLE POST is fired for (1) an org that exceeds its budget and
   * (2) each tool call awaiting approval (via a first-write-wins `__alert__` marker; webhook errors are
   * Swallowed — never breaks the main flow). Payload.type: 'budget-exceeded' | 'approval-pending'.
   */
  /**
   * Extra model ids for the Playground's model box, on top of what the journal already knows.
   *
   * A host wired to an OpenAI-compatible endpoint knows which ids are valid behind its prefix; the
   * router only knows the prefix. Config rather than a compiled-in list so adding one is the host's
   * deploy, not our release.
   */
  modelSuggestions?: string[];
  alerts?: {
    webhook?: string;
    /**
     * How long an alert POST may take before it is abandoned (ms, default 5000).
     *
     * Not a tuning knob so much as a bound. Both alert sites are `await`ed inside a GET handler, and
     * `fetch` has no default timeout, so an endpoint that accepts the connection and never answers —
     * a wedged receiver, a dropped route, a webhook host in the middle of an outage — held the request
     * open indefinitely. Measured: with a socket that accepts and never replies, `GET /approvals`
     * was still open after 20s and had no reason to ever close. `/approvals` is what the panel polls
     * every 5 seconds, so the operator's own inbox is the first thing to stop working, and it stops
     * because the ALERT is broken — the machinery that exists to tell them something is wrong.
     */
    timeoutMs?: number;
  };
  /**
   * W5 regression: converts POST /runs/:id/regression body.model (a 'provider/model' spec) to a real
   * Model. If not given, @gnldev/durable's `resolveModel` is used (dynamically imports the relevant provider
   * Package → a real API call). Provide this on hosts with a test/mock model store.
   */
  regressionModel?: (spec: string) => Promise<unknown> | unknown;
  /**
   * OTEL export (host-provided): the UI/client NEVER sends data to an arbitrary endpoint — the host
   * Itself CALLS @gnldev/otel's `exportRunToOtlp` with its configured target (Langfuse/Honeycomb/Datadog/
   * Collector) + auth (API key); Studio only TRIGGERS it (POST /runs/:id/otel-export). If not given,
   * The route returns 501 and the button (capabilities.otelExport) is hidden.
   */
  otelExport?: (runId: string) => Promise<{ ok: boolean; target?: string; error?: string }>;
}

/** createStudioApp additionally takes the admin HTML's API base (apiBase). */
export interface StudioAppOptions extends StudioApiOptions {
  /** API prefix the admin HTML fetches against. Depending on mount location: '' (same-origin) or '/studio'. */
  apiBase?: string;
}

function isReader (x: any): x is JournalReader {
  return typeof x?.listRuns === 'function' && typeof x?.readRun === 'function';
}

/**
 * **Studio API** (JSON only, no UI). Mount it on your own app — `app.mount('/studio/api', createStudioApi(...))`
 * On Hono, `toNodeHandler(...)` anywhere else — auth-gate it (viewer/admin), use it programmatically.
 * NOT `app.route()`: that takes a Hono sub-app and unpacks its routes, and what comes out of here is a
 * Fetch handler. Routes are prefix-independent: /capabilities, /runs, /runs/:id, ...
 */
function studioApiApp (input: JournalReader | StudioApiOptions): Hono {
  const opts: StudioApiOptions = isReader(input) ? { reader: input } : input;
  const { reader: rawReaderIn, resume, compensate, chat, gnl, memory, workflows, scorers, datasets, mcp, a2a, queue, events, cache, vectors, workflowInputs, workflowStore: _wfStoreOpt, compileWorkflow, auth } = opts;
  // The host may hand back `storage.runs` (a RunJournal → Page) rather than a bridged reader — the
  // README's quickstart does exactly that. Every listRuns consumer below expects the array contract.
  const rawReader = asReaderJournal(rawReaderIn as object) as typeof rawReaderIn;
  const app = new Hono();

  // Opt-in auth: an AuthProvider (free roleAuth / paid @gnldev/auth-ee) or the backward-compatible {read,write}.
  // If there's no provider, endpoints are open; in production that's only possible with allowOpenAccess: true
  // (otherwise makeGate throws at setup), and outside production it's warned once. Since the org middleware
  // Needs the identity-bound org (Principal.orgId), the gate is set up HERE, before the middleware.
  const authProvider = normalizeAuth(auth);
  const { allow, allowP, deny } = makeGate(authProvider, { allowOpenAccess: opts.allowOpenAccess });
  // RBAC (fine-grained permissions) is a PAID capability. When ON, allowP matches the exact permission
  // Against the principal's effective permissions; the permission catalog surface is also gated on this.
  // When OFF (free tier), allowP transparently reduces to read/write → the coarse legacy behavior.
  const rbacEnabled = authProvider?.capabilities?.().rbac === true;
  // STRICT multi-org model = PAID gate: ON only when the auth provider (paid @gnldev/auth-ee, valid
  // License) reports the `multiOrganization` capability. When ON, an org-less identity is NO LONGER the
  // All-seeing operator by default — it must carry the EXPLICIT `platform-admin` grant (scope:
  // 'platform'); otherwise it is fail-closed (403 on org data + org management). When OFF (free tier /
  // Host-provided `opts.org` without a paid license / no auth) behavior is preserved EXACTLY: an
  // Org-less identity is the legacy operator that sees & manages everything. NOTE: this is deliberately
  // NARROWER than `multiOrganizationEnabled` below (which also turns on for a bare `opts.org`) — the
  // Strict fail-closed is a paid-only behavior change, gated on the license capability alone.
  const strictMultiOrg = authProvider?.capabilities?.().multiOrganization === true;
  /**
   * Whether this deployment has organizations at all. See the twin in @gnldev/server for the
   * measurement: with `org` configured but no paid capability declared, an unbound admin read EVERY
   * organization's runs (200); declaring the paid capability refused it (403). A security default that
   * turns on when you pay is the wrong shape, and `capabilities()` is caller-supplied, so it can state
   * an intent but never prove one — a configured `org` option does.
   *
   * Deliberately NOT the same as `multiOrganizationEnabled` further down: that one gates the org
   * MANAGEMENT surface (create/delete/budget), which is a commercial line. This one gates the
   * fail-closed rules, which are a correctness line. They used to be tangled; the difference is the
   * whole point.
   *
   * The `authProvider` term is load-bearing and belongs HERE rather than at each call site. An ABSENT
   * provider is the deliberate no-auth single-operator mode: there is no identity to isolate ON, so
   * every caller is the operator and there is nothing to fail closed about. Written without this term,
   * a bare `org: {}` with no auth locked the operator out of its own deployment — measured as 403 on
   * `/organizations` and on every capability the same deployment advertised as available. `strictMultiOrg`
   * already implies a provider (it reads one), so this only widens the `opts.org` branch back to correct.
   */
  const orgIsolationActive = !!authProvider && (strictMultiOrg || !!opts.org);
  /**
   * Strict-model "operator" check for PLATFORM (cross-org) actions. Returns a 403 Response if the
   * Caller may NOT act platform-wide, else undefined.
   *  • org-bound identity → NEVER a platform actor (its own `orgBoundMsg` is preserved for back-compat).
   *  • strict mode + org-less WITHOUT the platform-admin grant → fail-closed 403.
   *  • free mode + org-less → allowed (legacy operator).  • platform-admin → allowed.
   */
  /** Whether this caller may manage a ROOT-level document (policy, pricing, organizations). */
  const isPlatformOperator = (c: Context): boolean => {
    const p = principalOf(c.req.raw);
    if (p?.orgId) return false;
    return !orgIsolationActive || isPlatformAdmin(p);
  };
  /**
   * Refuses a thread request from an org-bound caller when thread storage cannot be scoped.
   *
   * Serving it would hand one organization another organization's conversations. Refusing is the only honest
   * answer available: the host's `memory` object owns its own store, and nothing here can put an
   * organization boundary inside it. The message names the fix, because the fix is a one-line config
   * change (`memoryFactory` instead of `memory`) and the alternative is a leak nobody sees.
   */
  const requireScopedMemory = (c: Context): Response | undefined => {
    if (memoryIsOrgScoped) return undefined;
    const org = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    if (!org) return undefined; // single-org / operator: nothing to isolate from
    // Said once here as well as at boot: the boot warning fires on `multiOrganizationEnabled`, which a
    // `roleAuth` provider binding `orgId` to an identity does NOT set — so the config most likely to hit
    // this refusal was the one least likely to be warned about it.
    warnRefusal('memory', 'pass `memoryFactory` instead — it receives the org-scoped journal — or set '
      + '`orgScoped: true` on your `memory` object if it already keeps its own organization boundary');
    return c.json({
      code: 'org_scope_refused', // see requireScopedHost — a scope refusal is not a bad token
      error: 'this request reaches the conversation store, which has no organization boundary in this ' +
        'deployment because `memory` was passed directly. Pass `memoryFactory` ' +
        'instead — it receives the org-scoped journal — or use an unscoped operator identity.',
    }, 403);
  };

  /**
   * `memory` is not the only host object with this problem, and treating it as if it were is what left
   * the others open.
   *
   * `vectors`, `cache`, `queue` and a host-supplied `workflowStore` are all somebody else's objects
   * with their own storage behind them. Studio hands EVERY entry point on all four an `{ orgId }`
   * argument, but that is ADVISORY — nothing obliges a host to read it. Measured from an acme-bound
   * admin against hosts that ignore the argument:
   *
   *   POST /knowledge/search   -> 200 [{"text":"globex private doc"}]
   *   POST /cache/invalidate {} -> 200 {"removed":9}      every organization's cache, one call
   *   POST /jobs/globex-job/retry -> 200
   *   GET  /workflows          -> 200, another org's definition INCLUDING its prompt template
   *   DELETE /workflows/secret -> 200, and the other org's definition is gone
   *
   * (The journal-derived workflow store is fine — measured, it isolates correctly, because it is built
   * from the ALS-aware reader. Only the host-supplied one is unscopeable.)
   *
   * Three of those entry points originally received nothing at all — `cache.stats()`, `queue.listJobs()`
   * and every method of `StudioWorkflowStore` — which made the opt-in below a promise the host could
   * not keep: it set the flag, was never told who was asking, and served every organization from one store.
   * They all take a `ctx` now, and `wfStoreFor` binds it so no call site can drop it. The flag itself
   * was also undeclared on the interfaces, so a host doing exactly what the refusal message says got
   * `TS2353` — it is a real field on all five now.
   *
   * If handing over a store that cannot be scoped is grounds to refuse threads, it is grounds to refuse
   * these. A host that HAS made its object org-aware says so by setting `orgScoped: true` on it — an
   * explicit claim, in the host's own code, the same shape as `allowOpenAccess`. Refusing by default is
   * the only side of this that fails safe: the cost of a wrong refusal is a config line, and the cost of
   * a wrong service is one organization reading another's data.
   */
  const unscopeableHosts: Array<{ what: string; obj: unknown; fix: string }> = [
    { what: 'vectors', obj: vectors, fix: 'set `orgScoped: true` on it once it honours the `orgId` it is handed' },
    { what: 'cache', obj: cache, fix: 'set `orgScoped: true` on it once it honours the `orgId` it is handed' },
    { what: 'queue', obj: queue, fix: 'set `orgScoped: true` on it once it honours the `orgId` it is handed' },
    // Same shape as `queue`, and the same reason: the host wraps its own WorkStore, and a released
    // dead-letter event is delivered by whatever consumer owns it — releasing another organization's
    // quarantined event re-runs that organization's handler.
    { what: 'events', obj: events, fix: 'set `orgScoped: true` on it once it honours the `orgId` it is handed' },
    { what: 'workflowStore', obj: _wfStoreOpt, fix: 'omit `workflowStore` to use the journal-derived store, which IS org-scoped, '
      + 'or set `orgScoped: true` on yours once it honours the `orgId` its methods are handed' },
  ];

  /** The organization this caller is acting as, if any. Identity first — a header is not an identity. */
  const callerOrgScope = (c: Context): string | undefined =>
    principalOf(c.req.raw)?.orgId ?? orgALS.getStore();

  /**
   * Can THIS caller reach `what`? A predicate, not a Response, because `GET /capabilities` has to answer
   * the same question and must not have to build a 403 to find out.
   *
   * Splitting it mattered. `/capabilities` is what the UI builds itself from, and it kept advertising
   * every surface that had just started refusing — measured, an org-bound admin got
   * `knowledge=true queueManage=true cacheManage=true workflowManage=true memory=true`, and then a 403
   * on every one. The consequences were not cosmetic: `App.tsx` polls Jobs on a 3s interval while
   * `caps.queue` is true, so it 403s every three seconds forever; and `Playground.tsx` ALWAYS sends a
   * threadId while `caps.memory` is true, which made the whole Playground unusable for that admin
   * rather than just its thread list. A capability the caller cannot use is not a capability.
   */
  const hostReachable = (c: Context, what: string): boolean => {
    const entry = unscopeableHosts.find((e) => e.what === what);
    if (!entry?.obj) return true; // not configured — the route answers its own way
    if ((entry.obj as { orgScoped?: boolean }).orgScoped === true) return true; // the host claims it
    return !callerOrgScope(c); // single-org / operator: nothing to isolate from
  };

  /**
   * Said once per object, at the moment a caller is actually refused.
   *
   * The boot warning cannot cover every deployment that needs it, and the gap is not hypothetical:
   * `roleAuth({ admin: { token, orgId } })` binds an organization to the identity — documented as
   * first-class, no `org` option required — and yet reports `multiOrganization: false`, because that
   * flag means "the paid multi-org product", not "identities may carry an org". Measured with exactly
   * that config: six endpoints started answering 403 and the boot warnings printed were ZERO. The
   * operator's only signal was the 403 itself.
   *
   * Warning here instead of only at boot also removes the opposite error — an EE licensee running
   * single-organization got three warnings claiming endpoints "are refused" while nothing was refused.
   * A warning tied to the refusal cannot be wrong in either direction.
   */
  const warnedRefusals = new Set<string>();
  const warnRefusal = (what: string, fix: string): void => {
    if (warnedRefusals.has(what)) return;
    warnedRefusals.add(what);
    console.warn(
      `@gnldev/studio: refused an organization-scoped identity on an endpoint that reaches \`${what}\`. ` +
      'That object owns its own store and cannot be given an organization boundary from here, so ' +
      `serving it would hand one organization another organization's data. To serve these endpoints, ${fix}.`,
    );
  };

  const requireScopedHost = (c: Context, what: string): Response | undefined => {
    if (hostReachable(c, what)) return undefined;
    const fix = unscopeableHosts.find((e) => e.what === what)!.fix;
    warnRefusal(what, fix);
    return c.json({
      // A CODE, not just prose. The UI treats an unlabelled 403 as "your token is bad": `isAuthError`
      // matches on status alone, so `shouldForceReauth` fires, the token is cleared and the cache is
      // flushed. Measured — and reachable today by typing a URL, because the nav row is hidden but the
      // route is still registered: an org-bound admin who opens /cache gets `GET /cache/stats` -> 403
      // -> signed out. `useCacheStats` polls every 5s and `useJobs` every 3s, so it repeats on every
      // login. This refusal is about SCOPE, and the caller's session is perfectly valid; saying so is
      // the difference between "you may not see this" and "log in again".
      code: 'org_scope_refused',
      error: `this request reaches \`${what}\`, which is a host-provided object with no organization ` +
        `boundary, so serving it would hand one organization another organization's data — ${fix}, or use an ` +
        'unscoped operator identity.',
    }, 403);
  };

  /** The same question for the conversation store, which has its own (older) refusal. */
  const threadsReachable = (c: Context): boolean => memoryIsOrgScoped || !callerOrgScope(c);

  /**
   * The same refusal, for the routes that reach the conversation store WITHOUT being thread endpoints.
   *
   * `/agents/:name/run` and `/agents/:name/stream` take a caller-supplied `threadId` and hand it
   * straight to the host's unscoped store, so the boundary that `requireScopedMemory` puts on
   * `/threads*` was walked around by naming the thread instead of fetching it. Measured against the
   * real stack: `GET /threads/<globex-thread>/messages` answered 403 while
   * `POST /agents/bot/run {threadId:'<globex-thread>'}` answered 200 with GLOBEX_PRIVATE_MESSAGE in the
   * model prompt and in the response body — and the run then WROTE to that thread. Read and write, on
   * the surface the sibling routes were closed to.
   *
   * Conditional on a thread actually being named: an agent run that uses no thread touches no
   * conversation store, and refusing it would break org-scoped Playground use for no reason.
   */
  // An empty string names no thread and reaches no store — `runDurable` gates every memory read and
  // write on `memory && threadId`, so a falsy id is inert. Refusing it was an over-refusal with a real
  // shape behind it: the Playground used to send `threadId: runId` even with memory off.
  const requireScopedThread = (c: Context, threadId: unknown): Response | undefined =>
    threadId ? requireScopedMemory(c) : undefined;

  const requirePlatformAdmin = (c: Context, orgBoundMsg: string): Response | undefined => {
    const p = principalOf(c.req.raw);
    if (p?.orgId) return c.json({ error: orgBoundMsg }, 403);
    if (orgIsolationActive && !isPlatformAdmin(p)) {
      return c.json({ error: 'platform-admin required (fail-closed: no org scope and no platform-admin grant)' }, 403);
    }
    return undefined;
  };

  /**
   * The request path with the mount prefix removed, so an exemption can name an EXACT route.
   *
   * The org fail-closed guards exempt `GET /me` and `GET /capabilities`, so a refused caller can still
   * learn its own scope and the auth mode. That exemption was written as `path.endsWith('/me')` because
   * this app carries no basePath of its own and a host may mount it anywhere — measured, an inner
   * middleware sees `/me` standalone and `/studio/me` under `app.route('/studio', …)`.
   *
   * Tested against the WHOLE path, it matched any route whose last segment a caller could choose, and
   * three of ours end in a free parameter: `/runs/:id`, `/workflows/run/:runId`, and
   * `/runs/:id/regression/:otherId`. Measured, with the legacy `{read,write}` pair + `org` — the exact
   * configuration the fail-closed guard exists for:
   *
   *   GET /runs                                x-gnl-org: globex -> 403
   *   GET /runs/me                             x-gnl-org: globex -> 200  another org's run
   *   GET /runs/r-globex/regression/me         x-gnl-org: globex -> 200  "textA":"GLOBEX-SECRET"
   *
   * and under the paid strict multi-org net, from an authenticated principal with no org binding:
   *
   *   GET /runs/org:acme:r-acme/regression/me  Bearer unbound   -> 200  "textA":"ACME-SECRET"
   *
   * — the physical `org:<id>:` key is addressable, so that reads ANY organization, not just root data.
   *
   * `c.req.routePath` inside this middleware is the middleware's own pattern, which is exactly the
   * mount prefix plus `/*` (measured: `/*` standalone, `/studio/*` mounted). Stripping it gives the
   * route as registered, so the exemption can be an equality test. A routePath that is not `*`-suffixed
   * leaves the path unchanged and the exemption simply does not apply — failing closed.
   */
  const mountedRouteOf = (c: Context): string => {
    const mount = c.req.routePath.replace(/\/\*$/, '');
    return mount && c.req.path.startsWith(mount) ? c.req.path.slice(mount.length) : c.req.path;
  };
  /** `/me` and `/capabilities` — what a REFUSED caller is still allowed to learn about itself. */
  const isSelfDescribingRoute = (c: Context): boolean => {
    const route = mountedRouteOf(c);
    return route === '/me' || route === '/capabilities';
  };

  // Multi-org (v1 read-only): the org middleware stores it in ALS; on every call `reader` delegates to
  // The view scoped to the current org. A request without an org uses the raw reader. ALS is ALWAYS set
  // Up (not ONLY gated by opts.org): the identity-bound org (Principal.orgId) must scope the read surface
  // Even if opts.org isn't given (a contract from types.ts — see the middleware below).
  const orgALS = new AsyncLocalStorage<string>();
  const orgViews = new Map<string, JournalReader>();
  function scopedNow (): JournalReader {
    const org = orgALS.getStore();
    if (!org) return rawReader;
    let v = orgViews.get(org);
    if (!v) {
      v = withOrg(rawReader as unknown as Journal, org) as unknown as JournalReader;
      orgViews.set(org, v);
    }
    return v;
  }
  const reader: JournalReader = {
    listRuns: () => scopedNow().listRuns(),
    readRun: (id: string) => scopedNow().readRun(id),
    // The writable surface is only bridged if the raw reader supports it (so writable detection stays intact).
    ...(typeof (rawReader as any).get === 'function' ? { get: (k: string) => (scopedNow() as any).get(k) } : {}),
    ...(typeof (rawReader as any).put === 'function' ? { put: (k: string, v: unknown) => (scopedNow() as any).put(k, v) } : {}),
    ...(typeof (rawReader as any).putIfAbsent === 'function' ? { putIfAbsent: (k: string, v: unknown) => (scopedNow() as any).putIfAbsent(k, v) } : {}),
    ...(typeof (rawReader as any).listKeys === 'function' ? { listKeys: (p: string) => (scopedNow() as any).listKeys(p) } : {}),
    // DeletePrefix is bridged too (purge/retention call it via `rw`); since ALS is never set up on the
    // Write path (see the middleware), scopedNow() always falls through to the raw journal — behavior unchanged.
    ...(typeof (rawReader as any).deletePrefix === 'function' ? { deletePrefix: (p: string) => (scopedNow() as any).deletePrefix(p) } : {}),
    // P1.6 getCounters bridged the same way — GET /metrics reads the materialized
    // Per-org metrics counters (readMetricsSummary) through this SAME org-scoped accessor, so the
    // Isolation guarantee (withOrg prefixing) automatically covers it, same as every other bridge here.
    ...(typeof (rawReader as any).getCounters === 'function' ? { getCounters: (k: string) => (scopedNow() as any).getCounters(k) } : {}),
    // P1.6b: getMany bridged the SAME way — withOrg mirrors it 1:1 with the underlying journal (every
    // Key inside is prefixed, just like get/put), so a plain delegation is safe here too.
    ...(typeof (rawReader as any).getMany === 'function' ? { getMany: (ks: string[]) => (scopedNow() as any).getMany(ks) } : {}),
    // P1.6b: countRunsByStatus is NOT bridged 1:1 in withOrg (see organization.ts — an org-scoped view
    // Would otherwise leak every organization's counts, since the engine-level aggregate has no per-org
    // Filter). So unlike every other bridge here, this one uses optional chaining on the DELEGATE call
    // (not just the setup-time typeof check) — under an active org, `scopedNow()` returns a view that
    // Genuinely lacks the method, and the call must resolve to `undefined` (→ GET /metrics falls back to
    // Its listRuns-based count) rather than throwing.
    ...(typeof (rawReader as any).countRunsByStatus === 'function'
      ? { countRunsByStatus: () => (scopedNow() as any).countRunsByStatus?.() }
      : {}),
    // API-01: listRunsPaged bridged the same way as every other optional capability above — withOrg
    // ALREADY handles org isolation for it (walks the underlying mixed-org pages and strips/filters by
    // Prefix, see organization.ts's own listRunsPaged bridge), so a plain delegation through
    // ScopedNow() is safe here too, same as listRuns/readRun.
    ...(typeof (rawReader as any).listRunsPaged === 'function'
      ? { listRunsPaged: (q: any) => (scopedNow() as any).listRunsPaged(q) }
      : {}),
  } as JournalReader;

  /**
   * Studio refuses APPLICATION credentials outright.
   *
   * This is an operator console — @gnldev/auth's README calls `admin` "the credential a PERSON
   * carries" and `client` "a customer's backend server". The two hosts share one `AuthProvider`, and
   * the scaffold the CLI writes passes the SAME provider to `createStudioApp` and `createRestApi`, so
   * a `client` entry added for the REST side lands here too — measured, before this existed: a client
   * token read `/runs` (every end user's, with their `resourceId` attached), `/runs/:id` with full
   * journal entries, `/metrics`, `/audit` and `/users`, none of which asked it to name a subject.
   * @gnldev/server requires one on every route that touches end-user data; this host had never heard
   * of the class.
   *
   * REFUSING is the fix rather than porting the subject rules across, and the asymmetry is the reason:
   * an operator legitimately works across the whole organization and names nobody, which is most of
   * what Studio does. Teaching this surface to serve a per-end-user credential would mean deciding,
   * route by route, which of ~46 reads an application may see — the same route-by-route reasoning that
   * left the write paths open on the other host. One boundary, stated once.
   *
   * Runs BEFORE the org middleware and independently of it: the exposure did not need `org` configured.
   */
  if (authProvider) {
    app.use('*', async (c, next) => {
      const principal = await authProvider!.authenticate(c.req.raw);
      if (principal?.roles?.includes(CLIENT_ROLE)) {
        return c.json({
          error: 'access denied: Studio is an operator console and does not accept an application '
            + '(client) credential. Use an admin or viewer credential here; a client credential belongs '
            + 'to your backend, against @gnldev/server.',
        }, 403);
      }
      await next();
    });
  }

  // The middleware is only set up if opts.org (header-based resolution) OR an auth provider (which can
  // Produce an identity-bound org) exists; if neither exists, no request is scoped (existing shared behavior).
  if (opts.org || authProvider) {
    // Header-based resolution: `x-gnl-org`.
    const resolveOrg = opts.org?.resolve ?? ((req: Request) => req.headers.get('x-gnl-org') ?? undefined);
    app.use('*', async (c, next) => {
      // Header-based org resolution only kicks in if opts.org is EXPLICITLY given (a header never implies
      // A non-opt-in org); the identity-bound org is always valid whenever an auth provider exists.
      const requested = opts.org ? await resolveOrg(c.req.raw) : undefined;
      // An identity-bound org (Cred.orgId → Principal.orgId) OVERRIDES the header: if the bound identity
      // Requests a different org, 403 — org scope is based on identity, not a spoofable header.
      const principal = authProvider ? await authProvider.authenticate(c.req.raw) : null;
      const bound = principal?.orgId;
      // FAIL-CLOSED, unconditional: `org` is configured, so this surface CLAIMS organization
      // isolation — but the auth provider has no principal model (the legacy {read,write} pair,
      // whose authenticate() is `return null` by construction). There is no identity to bind an org
      // to, so the only thing left to pick the scope is the x-gnl-org header, and a caller holding
      // any valid read token could then name whichever organization it liked. That is the isolation
      // claim inverted, and it is a property of the CONFIGURATION, not of the request — which is
      // why it is not license-gated like the strict net below, and why a missing token is a
      // different question (that one is still the per-endpoint gate's 401). The same combination is
      // rejected by @gnldev/server; Studio claimed the guarantee without carrying the guard.
      if (opts.org && authProvider && !bindsIdentity(authProvider) &&
          !isSelfDescribingRoute(c)) {
        return c.json({ error: 'access denied: org isolation is configured but this auth provider binds no identity to an org (fail-closed)' }, 403);
      }
      // STRICT (EE multi-org) FAIL-CLOSED NET: an AUTHENTICATED identity with no org binding AND no
      // Explicit platform-admin grant may NOT reach org data/management surfaces — without this, an
      // Unbound principal would fall through unscoped and read the whole root journal (the accidental
      // Super-admin bug). `/me` + `/capabilities` are exempt so a denied caller can still learn its own
      // Scope and the auth mode. principal === null (no token) is NOT touched here → the per-endpoint
      // Gate returns the correct 401 (unauthenticated) instead of a misleading 403. Free mode: skipped
      // Entirely (strictMultiOrg=false) → behavior unchanged.
      if (
        orgIsolationActive && principal && !bound && !isPlatformAdmin(principal) &&
        !isSelfDescribingRoute(c)
      ) {
        return c.json({ error: 'access denied: no org scope and no platform-admin grant (fail-closed)' }, 403);
      }
      if (bound && requested && requested !== bound) {
        return c.json({ error: `org mismatch: identity is bound to org '${bound}'` }, 403);
      }
      // An identity-bound org scopes BOTH surfaces. It used to scope only GET: on a write the org was
      // taken from the explicit header alone, so a bound admin sending no header fell through with an
      // empty ALS — and `scopedNow()` returns the RAW root journal when the ALS is empty. Since
      // withOrg's physical prefix is `org:<id>:`, that made another organization's keys directly
      // addressable: POST /runs/org:globex:victim/cancel from an acme-bound admin returned 200 and
      // cancelled it (terminally — every later resume is refused), and /fork copied that run's prompt
      // and model output into a key the caller could then read back through the legitimate org-scoped
      // GET surface. The reasoning for the old shape was that binding would otherwise "lock out all
      // Studio management", but the answer to that is to scope the write, not to drop the boundary:
      // a bound admin still manages its OWN organization, and another org's physical key now resolves
      // to `org:<self>:org:<other>:…`, which does not exist → the same 404 the endpoints already
      // document. An EXPLICIT org header on a write remains rejected (v1 read-only rule) — that is a
      // separate question from which org the caller is bound to.
      if (requested && c.req.method !== 'GET') {
        return c.json({ error: 'writes are not supported in an org context (v1 read-only audit) — use @gnldev/server\'s org option for writes' }, 403);
      }
      const org = bound ?? requested;
      if (!org) return next();
      if (org.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
      await orgALS.run(org, () => next());
    });
  }

  const rw = reader as Partial<Journal> & JournalReader;
  const writable = typeof rw.get === 'function' && typeof rw.put === 'function';

  /**
   * The one way this server talks to an alert webhook.
   *
   * Both alert sites already swallowed errors, which reads as "this cannot break the request" — and
   * that is exactly why the missing bound went unnoticed: a rejected POST was handled, a POST that
   * never settles was not, and `.catch()` says nothing about time. Written once because the two call
   * sites are identical in every respect that matters, and a third alert added later should not have
   * to rediscover that `fetch` waits forever by default.
   */
  async function postAlert (payload: unknown): Promise<void> {
    const webhook = opts.alerts?.webhook;
    if (!webhook) return;
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.alerts?.timeoutMs ?? 5_000),
    }).catch(() => { /* alerts are best-effort: a broken receiver must not break the endpoint */ });
  }

  // If memory isn't given and reader is a writable Journal, derive it from the factory (CLI/dev default).
  const resolvedMemory: StudioMemory | undefined =
    memory ?? (opts.memoryFactory && writable ? opts.memoryFactory(reader as unknown as Journal) : undefined);
  /**
   * Whether thread storage is organization-scoped.
   *
   * `memoryFactory` is handed the ALS-aware reader, so everything it writes lands under
   * `org:<id>:` — measured. A `memory` object the host passes DIRECTLY has no notion of an
   * organization and cannot be given one from out here: it is somebody else's object with its own
   * store behind it. So the same endpoints are isolated under one option and not under the other.
   *
   * Measured with a host-provided memory and an acme-bound identity: `GET /threads` listed globex's
   * thread and `GET /threads/globex-thread/messages` returned its contents. Writes were already
   * refused by the org-write guard; reads were not.
   *
   * `orgScoped: true` is the SAME opt-out its four siblings have, and its absence here was an
   * oversight rather than a decision. The rule was `!memory ` — the mere PRESENCE of the object — so a
   * host that had genuinely made its memory org-aware had no way to say so and its org-bound callers
   * were refused every thread route permanently. The only way out was `memoryFactory`, which is a
   * different object model, not a claim about the object you already have. Same shape as `vectors`,
   * `cache`, `queue` and `workflowStore`: refusing by default is the safe side, and an explicit claim
   * in the host's own code is how a host leaves it.
   */
  const memoryIsOrgScoped = !memory || (memory as { orgScoped?: boolean }).orgScoped === true;

  const WF_STORE_PRE = '__studio_wf__';
  const resolvedWfStore: StudioWorkflowStore | undefined = _wfStoreOpt ?? (
    writable && rw.listKeys && rw.get && rw.put
      ? {
        async list () {
          const keys = await rw.listKeys!(WF_STORE_PRE).catch(() => [] as string[]);
          return (await Promise.all(keys.map((k) => rw.get!(k).catch(() => null)))).filter(Boolean) as WorkflowDef[];
        },
        async get (name: string) {
          return ((await rw.get!(WF_STORE_PRE + name).catch(() => undefined)) ?? undefined) as WorkflowDef | undefined;
        },
        async set (def: WorkflowDef) { await rw.put!(WF_STORE_PRE + def.name, def); },
        async delete (name: string) { await rw.put!(WF_STORE_PRE + name, null); },
      }
      : undefined
  );

  // Can a managed workflow run with the REAL engine? (compiler + agent.run + writable journal)
  const canRunManaged = !!resolvedWfStore && !!compileWorkflow && !!gnl?.run && writable && !!rw.get;

  /**
   * The workflow store, for a REQUEST — `undefined` when this caller may not reach it.
   *
   * Every route-level use goes through here rather than touching `resolvedWfStore`, because gating the
   * sites I happened to be looking at is exactly how the hole stayed open. The refusal was added to
   * list/def/CRUD and missed the three routes that RUN a managed workflow, so an org-bound admin got
   * 403 on `GET /workflows/secret/def` and 200 on `POST /workflows/secret/run` — measured, returning
   * the other organization's prompt template verbatim in the dry-run output, and executing it for real
   * without `dryRun`. Reading the store now requires a request, and a request has to pass the gate.
   */
  /**
   * Binds the store to the caller's organization instead of asking ten call sites to remember.
   *
   * `StudioWorkflowStore` now takes a `ctx` on every method, and threading it by hand would have meant
   * editing `wf.get(name)` in ten places and every place added later — which is the exact shape of
   * every isolation defect this file has shipped: a rule applied to the call sites someone was looking
   * at. `wfStoreFor` is already the ONLY way to reach the store, so binding here means a call site
   * cannot drop the context even by writing the obvious thing.
   */
  const wfStoreFor = (c: Context): StudioWorkflowStore | undefined => {
    if (!resolvedWfStore || requireScopedHost(c, 'workflowStore')) return undefined;
    const store = resolvedWfStore;
    const ctx: StudioCallbackCtx = { orgId: callerOrgScope(c) };
    return {
      list: () => store.list(ctx),
      get: (name) => store.get(name, ctx),
      set: (def) => store.set(def, ctx),
      delete: (name) => store.delete(name, ctx),
    };
  };

  /**
   * The refusal, for the routes that would otherwise answer "not found".
   *
   * `wfStoreFor` returns `undefined` both when there is no store and when this caller may not reach
   * one — and the routes that RUN a workflow read that as "no such workflow" and answered 404. Nothing
   * leaked, but the two situations are not the same and a 404 hides the one the operator has to act on:
   * "this deployment's workflow store has no organization boundary" is a configuration fact, while
   * "no such workflow" is a fact about the request. The read routes already say so; these said the
   * opposite of the truth.
   *
   * It is also the only honest answer available. We could not look in the managed store, so we are not
   * in a position to report that the workflow is absent from it.
   */
  const wfStoreRefusal = (c: Context): Response | undefined =>
    resolvedWfStore ? requireScopedHost(c, 'workflowStore') : undefined;

  /** Compiles a managed WorkflowDef and runs it with the SAME engine as code workflows (parity with registry.runWorkflow).
   * P0.4 `resume` forwards typed HITL payloads to wf.runResumable (only meaningful
   *  When the compiled workflow supports it); a `{status:'canceled'}` result maps into `canceled` the
   * SAME way `suspended`/`paused` already do (mirrors registry.ts's runWorkflow mapping). */
  async function runManaged (store: StudioWorkflowStore, name: string, input: unknown, runId: string, maxSteps?: number, dryRun?: boolean, overridesFor?: (name: string) => Promise<{ model?: string; system?: string } | undefined>, resume?: Record<string, unknown>): Promise<{ runId: string; output?: unknown; suspended: boolean; paused?: boolean; canceled?: boolean; dryRun?: boolean; stepId?: string; reason?: unknown; steps: { id: string; kind: string; output: unknown }[] }> {
    const def = await store.get(name);
    if (!def) throw new Error(`workflow '${name}' not found`);
    // Dry-run: the real agent is NEVER CALLED (deterministic stub response) + the journal is TEMPORARY
    // Memory → zero LLM cost, zero persistent trace; validates flow/template/input wiring end-to-end.
    const runAgent = dryRun
      ? async (agentName: string, o: { prompt?: string }) => ({ text: `[dry-run] ${agentName}: ${String(o.prompt ?? '').slice(0, 120)}` })
      : async (n2: string, o: { runId: string; prompt?: string }) => {
          const mo = overridesFor ? await overridesFor(n2) : undefined; // workflow steps also use the promoted version (based on the caller's org)
          return gnl!.run!(n2, { ...o, ...(mo?.model ? { model: mo.model } : {}), ...(mo?.system != null ? { system: mo.system } : {}) });
        };
    const wf = compileWorkflow!(def, runAgent as any, input);
    const mem = dryRun ? new Map<string, unknown>() : null;
    const journal: Journal = mem
      ? ({ get: async (k: string) => mem.get(k), put: async (k: string, v: unknown) => { mem.set(k, v); } } as unknown as Journal)
      : (rw as unknown as Journal);
    const ctx = { runId, journal };
    let output: unknown; let suspended = false; let paused = false; let canceled = false; let stepId: string | undefined; let reason: unknown;
    if (wf.runResumable) {
      const rOpts = {
        ...(maxSteps != null ? { maxSteps } : {}),
        ...(resume ? { resume } : {}),
      };
      const r = await (wf.runResumable as any)(input, ctx, Object.keys(rOpts).length ? rOpts : undefined);
      if (r.status === 'suspended') { suspended = true; stepId = r.stepId; reason = r.reason; }
      else if (r.status === 'paused') { paused = true; stepId = r.stepId; }
      else if (r.status === 'canceled') { canceled = true; stepId = r.stepId; reason = r.reason; }
      else output = r.output;
    } else {
      output = await wf.run(input, ctx);
    }
    const steps: { id: string; kind: string; output: unknown }[] = [];
    for (const s of wf.build()) steps.push({ id: s.id, kind: 'agent', output: await ctx.journal.get(`${runId}:wf:${s.id}`) });
    return { runId, output, suspended, paused, canceled, ...(dryRun ? { dryRun: true } : {}), stepId, reason, steps };
  }

  // ── Governance: audit log ────────────────────────────────────────
  // Every successful WRITE action is logged to the journal as an `__audit__` entry (appendLog).
  // Best-effort: only on a writable journal; errors are SWALLOWED — never breaks the main flow.
  type AuditAction =
    | 'approve' | 'deny' | 'fork'
    | 'thread.rename' | 'thread.delete' | 'thread.truncate'
    | 'workflow.create' | 'workflow.update' | 'workflow.delete'
    | 'tool.exec' | 'agent.run'
    | 'agent.version' | 'agent.promote' | 'agent.gate' | 'agent.delete' | 'agent.version-delete'
    | 'run.purge' | 'run.regression' | 'run.compensate' | 'run.cancel' | 'retention.sweep' | 'policy.update' | 'pricing.update'
    | 'org.budget' | 'org.create' | 'org.delete'
    | 'user.create' | 'user.delete' | 'user.revoke' | 'user.update'
    | 'job.retry' | 'event.release' | 'cache.invalidate' | 'run.otel-export' | 'workflow.cancel'
    | 'agent.approve' | 'agent.block';
  /**
   * Actor attribution — priority: an authenticated principal.id (e.g. a basic-auth user) > the
   * X-gnl-actor header (the PERSON behind a shared token — cooperative attribution, like a git author) >
   * Role:<role> > anon. A token-only cred has no principal.id → the header is kept (so teams can keep a
   * Per-person trail); if there's no header either, it falls back to role:<role>. This makes spoofing
   * Pointless (token holders can already impersonate each other) while still preserving person-level
   * Info. Extracted so the agent-registry approve/block endpoints can pass it as approveAgent/blockAgent's
   * `by` argument without duplicating the derivation.
   */
  function actorOf (c: Context): string {
    const p = principalOf(c.req.raw);
    return p?.id ?? c.req.header('x-gnl-actor') ?? (p?.roles[0] ? `role:${p.roles[0]}` : 'anon');
  }
  async function audit (c: Context, action: AuditAction, target: string, detail?: unknown): Promise<void> {
    if (!writable) return;
    try {
      const actor = actorOf(c);
      const p = principalOf(c.req.raw);
      // Org context — the audit "org" column (see Audit.tsx it.org):
      //  (1) the bound identity's orgId (if any) → which org the work was done on behalf of.
      //  (2) for operator actions that MANAGE an org (org.create/delete/budget), the actor is unbound (no orgId),
      //      But the relevant org IS ALREADY the target → use target so the column doesn't stay empty.
      //  (3) user.create: the new user's org is carried in detail.orgId.
      const orgFromTarget = action === 'org.create' || action === 'org.delete' || action === 'org.budget' ? target : undefined;
      const orgFromDetail = action === 'user.create' && detail && typeof detail === 'object'
        ? (detail as { orgId?: string }).orgId : undefined;
      const org = p?.orgId ?? orgFromTarget ?? orgFromDetail;
      // The ROOT journal, explicitly — the same choice GET /audit already documents and makes when it
      // reads through `rawReader`. The organization is a FIELD on the record, not a key prefix, which is
      // what lets an unbound operator see every org's actions in one list and a bound identity see only
      // its own (filtered by that field). This used to be `rw` and happened to agree only because a
      // write never had an org in the ALS; once writes became org-scoped, every bound identity's audit
      // record landed under `org:<id>:__audit__` where the reader never looks — the log went silently
      // empty for exactly the identities whose actions most need recording.
      /**
       * `reason` is whatever the caller sent in `x-gnl-reason`, so a review can ask "why" and not only
       * "who". Not required, deliberately: making it mandatory would break every existing operator
       * script on the day it shipped, and a trail nobody can write to is worse than one with blanks.
       *
       * There is deliberately no `actingAs` here. I added one and then measured that it can never fill
       * on this surface: `org = bound ?? requested` and an explicit org header is REFUSED on any
       * non-GET (the v1 read-only rule, line ~971), so on a write the ALS only ever holds the caller's
       * own binding. A platform identity crossing into an organization does it through
       * `@gnldev/server`, which is where that field now lives.
       */
      const reason = c.req.header('x-gnl-reason')?.slice(0, 300);
      await appendLog(rawReader as unknown as Journal, '__audit__', {
        actor,
        action,
        target,
        ...(org ? { org } : {}),
        ...(reason ? { reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch { /* audit is best-effort — swallow */ }
  }

  // ── Managed agent versions: draft → promote/rollback (EE governance wave 2) ─────
  // Each agent has a single journal record: version list + active (prod) version number. Versions are
  // IMMUTABLE (a new record = a new version); promote only moves the 'active' pointer → rollback = promoting
  // An older version. Every change is logged to audit.
  const AGENT_STORE_PRE = '__studio_agent__:';
  // Org record prefix: orgs that were EXPLICITLY created (may not have any runs yet) are kept here.
  // ORG_RECORD_PRE from @gnldev/durable — the same literal lived here, in @gnldev/server, and (once
  // `adoptIntoOrg` arrived) in the storage adapters. One source, since it decides whether an
  // organization resolves at all.
  const ORG_PRE = ORG_RECORD_PRE;
  const agentStoreEnabled = writable && typeof rw.listKeys === 'function';
  type AgentStore = {
    list(): Promise<ManagedAgentRecord[]>;
    get(name: string): Promise<ManagedAgentRecord | undefined>;
    put(rec: ManagedAgentRecord): Promise<void>;
    /** Present if the journal supports deletePrefix — PERMANENTLY deletes the agent record (with ALL its
     *  Versions) (as OPPOSED TO the workflow store's tombstone/`put(key,null)` pattern — a real delete).
     * Otherwise the field is absent entirely (the caller must return 501, see DELETE /managed-agents/:name). */
    delete?(name: string): Promise<void>;
  };
  /** Agent version store (list/get/put[/delete]) over the given journal. Requires listKeys+get+put. */
  function makeAgentStore(j: Partial<Journal>): AgentStore | undefined {
    if (!agentStoreEnabled || typeof j.listKeys !== 'function' || typeof j.get !== 'function' || typeof j.put !== 'function') return undefined;
    const lk = j.listKeys.bind(j); const g = j.get.bind(j); const p = j.put.bind(j);
    const dp = typeof j.deletePrefix === 'function' ? j.deletePrefix.bind(j) : undefined;
    return {
      async list() {
        const keys = await lk(AGENT_STORE_PRE).catch(() => [] as string[]);
        const out: ManagedAgentRecord[] = [];
        for (const k of keys) {
          const rec = (await g(k).catch(() => null)) as ManagedAgentRecord | null;
          if (rec && typeof rec === 'object' && Array.isArray(rec.versions)) out.push(rec);
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },
      get: async (name) => ((await g(AGENT_STORE_PRE + name).catch(() => undefined)) ?? undefined) as ManagedAgentRecord | undefined,
      put: async (rec) => { await p(AGENT_STORE_PRE + rec.name, rec); },
      ...(dp
        ? {
          async delete(name: string) {
            const key = AGENT_STORE_PRE + name;
            // DeletePrefix is RANGE-based (key >= prefix && key < prefix+'￿') — in our key format
            // (`AGENT_STORE_PRE + name`, with NO trailing separator) `name` can be an EXACT string
            // Prefix of another agent's name (e.g. deleting 'dd' also catches 'dd2' in the range —
            // See run purge using a `${runId}:` separator against the same class of bug, retention.ts).
            // First read the colliding sibling keys, write them back after the sweep — only the
            // EXACTLY matching record is permanently deleted.
            const hits = await lk(key).catch(() => [] as string[]);
            const siblings = hits.filter((k) => k !== key);
            const preserved = await Promise.all(siblings.map(async (k) => [k, await g(k).catch(() => null)] as const));
            await dp(key);
            for (const [k, v] of preserved) if (v != null) await p(k, v as ManagedAgentRecord);
          },
        }
        : {}),
    };
  }
  /**
   * ORG-SCOPED agent version store: a bound identity (Principal.orgId) only manages/sees/promotes ITS OWN
   * Org's versions (via the withOrg prefix); an unbound operator manages the root (shared) namespace.
   * Note: runtime enforcement (@gnldev/server's actual traffic) is a separate layer — this store brings org
   * Isolation to Studio playground/workflow runs and to management/visibility.
   */
  function agentStoreFor(c: Context): AgentStore | undefined {
    // Priority: identity-bound org (Principal.orgId) > org resolved from header/ALS (GET only; the read
    // Context scoped by the org middleware) > root (shared) namespace. Without the former, header-based
    // Org resolution (when there's no auth binding) would make GET /managed-agents return the root store
    // For EVERY org (a leak) — see Phase 0.4.
    const bound = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    const base = rawReader as unknown as Journal;
    const j = (bound ? (withOrg(base, bound) as unknown as Partial<Journal>) : (base as unknown as Partial<Journal>));
    return makeAgentStore(j);
  }

  /** If an active (promoted) managed version exists, returns its model/system override (per the caller's org).
   * An explicit user override (body.model/system) OVERRIDES the managed version (playground experimentation). */
  async function managedOverrides(name: string, c: Context): Promise<{ model?: string; system?: string } | undefined> {
    const store = agentStoreFor(c);
    if (!store) return undefined;
    const rec = await store.get(name);
    if (!rec || rec.active == null) return undefined;
    const v = rec.versions.find((x) => x.version === rec.active);
    return v ? { model: v.model, ...(v.system != null ? { system: v.system } : {}) } : undefined;
  }

  // Is multi-org ON? Only if the host gave org OR the auth provider reports multiOrganization (paid
  // @gnldev/auth-ee). Neither exists on the free tier → org surfaces are NEVER shown: it runs in a single
  // Implicit org, and the user is never aware multi-org exists.
  const multiOrganizationEnabled = !!opts.org || !!authProvider?.capabilities?.().multiOrganization;
  if (!memoryIsOrgScoped && multiOrganizationEnabled) {
    // Said at boot, not at the first 403: a host reading this can change one option, while a user
    // hitting the refusal can only file a bug about a feature that looks broken.
    console.warn(
      '@gnldev/studio: `memory` was passed directly while multi-organization is enabled. That object ' +
      'owns its own store and cannot be given an organization boundary, so the thread endpoints are ' +
      'refused to organization-scoped identities rather than serving one organization another organization\'s ' +
      'conversations. Pass `memoryFactory` instead — it receives the org-scoped journal — or set `orgScoped: true` '
      + 'on your `memory` object if it already keeps its own organization boundary.',
    );
  }
  // The same sentence for the same problem, for every OTHER host object with it. `memory` got a boot
  // warning and a refusal; its four siblings got an advisory `{ orgId }` argument that no host is
  // obliged to read, and nothing was said at boot about any of them.
  //
  // Gated on `opts.org` rather than `multiOrganizationEnabled`, because the capability flag is the
  // wrong question here. It means "the paid multi-org product is licensed", and measured, an EE
  // licensee running SINGLE-TENANT — no `opts.org`, no org-bound identity, nothing refused — got three
  // warnings saying its endpoints "are refused". `opts.org` is the host deliberately turning on
  // per-organization scoping, which is the only boot-time fact that predicts a refusal. Everything the
  // boot check cannot see is covered by `warnRefusal`, which fires when a caller is actually refused
  // and therefore cannot be wrong in either direction.
  if (opts.org) {
    for (const { what, obj, fix } of unscopeableHosts) {
      if (!obj || (obj as { orgScoped?: boolean }).orgScoped === true) continue;
      console.warn(
        `@gnldev/studio: \`${what}\` was passed directly while multi-organization is enabled. It owns ` +
        'its own store and cannot be given an organization boundary from here, so the endpoints that ' +
        `reach it are refused to organization-scoped identities rather than serving one organization another ` +
        `organization's data. To serve them, ${fix}.`,
      );
    }
  }

  // PUBLIC (exempt from the read gate): lets the UI discover the auth mode + premium capabilities (sso/rbac...) BEFORE login.
  /**
   * Every capability, as a function of the two reachability predicates.
   *
   * Taking them as arguments is what lets `scopeRefused` below be DERIVED rather than enumerated: the
   * same expressions are evaluated twice, once as this caller and once as an unscoped operator, and the
   * difference is the answer. A hand-written list beside hand-written booleans is two things to keep in
   * step, and they had already drifted in both directions before anyone edited them again —
   * `queueManage` was announced as scope-refused on a host with no `queue.retry` at all (refused for
   * everyone, so refused for no scope reason), and `workflowExec` depends entirely on scope yet was
   * missing from the list. Nothing here can drift, because there is only one expression per capability.
   */
  const capsFor = (c: Context, reach: (what: string) => boolean, threads: boolean, unscoped: boolean) => ({
      resume: !!resume,
      compensate: !!compensate,
      chat: !!chat,
      org: !!opts.org,
      fork: !!resume && writable,
      playground: !!gnl,
      stream: !!gnl?.stream,
      tools: !!gnl?.listTools,
      toolExec: !!gnl?.runTool,
      toolExecDurable: !!gnl?.runTool && !!gnl?.toolExecDurable,
      memory: !!resolvedMemory && threads,
      workflows: !!gnl?.listWorkflows || !!workflows,
      workflowExec: !!gnl?.runWorkflow || (canRunManaged && reach('workflowStore')),
      scorers: !!scorers,
      datasets: !!datasets,
      mcp: !!mcp?.length,
      a2a: !!a2a,
      queue: !!queue && reach('queue'),
      // "Retry" action in the Jobs view: on if the host implemented queue.retry (RBAC is also
      // Enforced server-side on every request via allow(c,'write') — this is only button visibility).
      queueManage: !!queue?.retry && reach('queue'),
      // Dead-letter view (@gnldev/events quarantine): on if the host gave an events object. Named
      // `deadEvents` rather than `events`, because `/events` is already this API's SSE change stream
      // and a capability that reads as "the SSE stream is on" would be read that way.
      deadEvents: !!events && reach('events'),
      // "Release" action in the Dead-letter view: on if the host implemented events.release (RBAC is
      // also enforced server-side on every request via allow(c,'write') — this is only button
      // visibility, same pattern as queueManage/cacheManage).
      eventsManage: !!events?.release && reach('events'),
      // Cache view (@gnldev/cache hit/miss + size): on if the host gave a cache instance.
      cache: !!cache && reach('cache'),
      // Manual invalidate button: on if the host implemented cache.invalidate (RBAC is again enforced
      // Server-side via allow(c,'write') — this is only button visibility, same pattern as queueManage).
      cacheManage: !!cache?.invalidate && reach('cache'),
      // Scheduler (@gnldev/scheduler trigger introspection): the journal is READ-ONLY (see GET /scheduler/triggers),
      // It needs neither a separate opts.scheduler surface nor a running instance — writable + listKeys
      // Is enough (same auto-detection pattern as audit/organizations; returns an empty list if the host doesn't use @gnldev/scheduler).
      scheduler: writable && typeof rw.listKeys === 'function',
      knowledge: !!vectors && reach('vectors'),
      workflowManage: !!resolvedWfStore && reach('workflowStore'),
      // Governance: approval queue (needs resume), audit + organizations (need a writable journal + listKeys).
      approvals: !!resume,
      audit: writable && typeof rw.listKeys === 'function',
      // Agent approval registry (governance): review/approve/block code-defined agents recorded by
      // @gnldev/server's boot-time recording (see GET/POST /agents/registry* below) — SAME auto-detection
      // Pattern as audit/scheduler, no separate host option needed.
      // `!callerOrgScope(c)`, because all three routes this gates are `requirePlatformAdmin` and an
      // org-bound identity is refused by every one of them. Without it the capability said `true` to a
      // caller it was untrue for, and each consumer had to reintroduce the per-caller truth by hand:
      // `Agents.tsx` carried a `!me.data?.orgId` clause beside the flag, and `useAgentRegistry` grew an
      // `enabled` argument after being burned — a background poll on a 403 logs the user out.
      //
      // `writable && typeof rw.listKeys === 'function'` is decided once at construction; who is asking
      // is decided per request. A capability that mixes the two has to be corrected at every call site,
      // and the third consumer is the one that forgets. Not covered by `scopeRefused`: this is
      // platform-admin gating, not an unscopeable host object — the boolean was wrong, not unexplained.
      agentRegistry: writable && typeof rw.listKeys === 'function' && unscoped,
      // Compliance reports: findings produced in this run by the pii/moderation/prompt-injection
      // Processors (`${runId}:procreport:...`) — the SAME auto-detection pattern as audit/scheduler: writable +
      // ListKeys is enough, no separate host option is NEEDED (returns an empty list if the host doesn't use a processor).
      processors: writable && typeof rw.listKeys === 'function',
      // The organizations surface is shown ONLY when multi-org is on (paid/opt-in). Hidden on free.
      organizations: multiOrganizationEnabled && writable && typeof rw.listKeys === 'function',
      // Budget management lives in the org panel → also depends on multi-org.
      budgetManage: multiOrganizationEnabled && writable,
      // Create/delete org (multi-org + writable + listKeys). Delete additionally needs deletePrefix (checked at the endpoint).
      orgManage: multiOrganizationEnabled && writable && typeof rw.listKeys === 'function',
      // User management (paid): on if the host gave a userStore.
      userManage: !!opts.users,
      agentVersions: agentStoreEnabled,
      evalGate: !!(opts.evalGate && datasets),
      purge: writable && typeof (rw as Partial<Journal>).deletePrefix === 'function',
      // W5: replay-based regression ("re-run" + decision-point diff). replayRun needs a writable
      // Journal since it writes a new run; diffing two EXISTING runs (GET) doesn't depend on that.
      regression: writable,
      policy: writable,
      retention: !!opts.retention && writable && typeof (rw as Partial<Journal>).deletePrefix === 'function',
      // OTEL export button: on if the host gave opts.otelExport (RBAC is again enforced server-side
      // Via allow(c,'write') — this is only button visibility, same pattern as queueManage/cacheManage).
      otelExport: !!opts.otelExport,
      // D3-A: durable run cancel (POST /runs/:id/cancel) — writes cancelAgentRun's cross-worker flag.
      // Studio has no in-process AbortController registry (unlike @gnldev/server's P0.3 in-flight abort),
      // So this is the durable-flag path ONLY: a canceled run stops at its NEXT fresh model step,
      // Wherever it's running. Needs nothing but a writable journal (cancelAgentRun only get/put's a flag).
      runCancel: writable,
      // D3-A: durable workflow-run cancel (POST /workflows/runs/:id/cancel) — mirrors @gnldev/server's
      // P0.4 /workflows/runs/:id/cancel (reimplemented inline, see the route's own JSDoc for why).
      // Same capability gate as the suspended-runs registry itself (GET /workflows/runs) needs.
      workflowRunCancel: writable && typeof rw.listKeys === 'function',
      // Auth: if a provider exists the UI requires login; provider.capabilities() unlocks premium surfaces.
      authRequired: !!authProvider,
      ...(authProvider?.capabilities?.() ?? {}),
  });

  app.get('/capabilities', (c) => {
    // Reported for THIS caller, not for the deployment. Everything that depends on a host object with
    // no organization boundary is reported false to an organization-scoped identity, because that is
    // exactly who the endpoint behind it refuses. See `hostReachable`.
    const mine = capsFor(c, (what) => hostReachable(c, what), threadsReachable(c), !callerOrgScope(c));
    // The same deployment as seen by an identity with NO organization scope. `hostReachable` ends in
    // `!callerOrgScope(c)` and `threadsReachable` in `!callerOrgScope(c)`, so an operator is exactly the
    // case where both predicates are true — which is why this is a substitution rather than a second
    // request.
    // EVERY scope-dependent input is a parameter, including `unscoped`. Adding `!callerOrgScope(c)`
    // inline to `agentRegistry` instead made the difference blind to it: the substitution could not
    // reach that call, so a capability that genuinely depended on scope stayed out of `scopeRefused` —
    // the same defect this derivation exists to prevent, reintroduced by the fix for a different one.
    const asOperator = capsFor(c, () => true, true, true);
    return c.json({
      ...mine,
      /**
       * Capabilities that are `false` for THIS caller's organization scope but `true` for an unscoped
       * operator on the same deployment.
       *
       * DERIVED, not listed. The booleans alone cannot tell "this deployment has no cache" from "your
       * organization cannot reach this deployment's cache", so the UI rendered its not-configured state
       * — an org-bound admin was shown "Cache disabled" while the endpoint behind it answered
       * `403 org_scope_refused` naming the fix. Set-difference against the operator view means a new
       * gated capability is covered the day it is added, with nothing to remember.
       *
       * Empty for an operator, and empty for a deployment that simply has no queue/cache/vectors.
       */
      scopeRefused: (Object.keys(mine) as Array<keyof typeof mine>)
        .filter((k) => mine[k] === false && asOperator[k] === true),
    });
  });
  // S4 pagination: if ?limit= is given, returns a Page envelope {items,nextCursor,total} (newest first);
  // A call without the parameter stays a backward-compatible flat array (existing consumers don't break).
  // API-09: optional status/agent/q filters — SAME parameter names as @gnldev/server's GET /runs (see
  // Packages/server/src/index.ts). Only honored together with `limit` (a bare filter with no `limit`
  // Falls through to the unfiltered flat array below, same as today — matches the "no params → identical
  // To today" backward-compat contract; the studio-ui client always sends `limit`, so this never bites it).
  app.get('/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const limitRaw = c.req.query('limit');
    if (limitRaw === undefined) return c.json(await reader.listRuns());
    const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 500);
    /**
     * The cursor is an ASCENDING anchor — the exclusive END of the window the next page will serve —
     * NOT "how many newest rows to skip". The difference is the whole point.
     *
     * THIS IS A TRADE, NOT A STRICT IMPROVEMENT. The two readings are duals, and each is wrong under
     * the mutation the other survives:
     *
     *   INSERT at the newest end   moves newest-first offsets   leaves ascending indices alone
     *   DELETE at the oldest end   leaves newest-first offsets  moves ascending indices
     *
     * Under the old offset reading, every run written between two page requests pushed the window
     * back toward rows already shown: measured at total=100/limit=20, page 1 serves [80,100); five
     * runs land; page 2 computes 105-20=85 and serves [65,85) — five rows repeated.
     *
     * Under this one, a `sweepRuns` between two page requests renumbers everything above the deleted
     * rows: measured at 10 runs/limit 3, page 1 = [010,009,008]; sweep the 6 oldest; page 2 comes
     * back [010,009,008] again. The OLD code answered that same case correctly, because deleting from
     * the oldest end does not move a row's distance from the newest end.
     *
     * The trade is taken because the two events are nothing alike in frequency: an insert happens on
     * every single run, a sweep only when retention runs. It is still a trade — do not read the
     * change as free.
     *
     * The clamp below is also a choice with a cost. It keeps a stale anchor inside the table, which
     * turns "the window fell off the end" into "page 1 again": a repeat instead of a skip. Rows the
     * reader has seen twice are recoverable; rows never shown are not.
     *
     * The only cursor that survives both is one keyed on the ROW (created_at + runId) rather than on
     * a position. That needs a timestamp written by the database and a `createdAt` on RunSummary,
     * neither of which exists yet. This is one half, not the whole.
     *
     * Two kinds of bad cursor, two answers — they are not the same event:
     *
     *   NOT A NUMBER AT ALL (`?cursor=zzz`)   → 400. The caller invented one, or is speaking a
     *                                            vocabulary this server does not have.
     *   A NUMBER OUT OF RANGE (`-5`, `9999`)  → first page / clamp. Stale but well-formed: a cursor
     *                                            issued before a retention sweep is exactly this.
     *
     * The distinction is load-bearing. Answering an uninterpretable cursor with page 1 *and a fresh
     * `nextCursor`* looks like success, and the Studio's infinite query appends pages without
     * de-duplicating (`studio-ui/src/api.ts`), so the same rows enter the list again and again while
     * the client dutifully follows a cursor that never advances. Measured before this guard:
     * `?cursor=k_2026_r5` returned 200 with page 1 and a cursor of `"2"`.
     *
     * `2.7` floors to 2 and is honoured — a fractional cursor is nonsense we can still act on.
     * Zero is never handed out: the last page reports no cursor rather than `'0'`.
     */
    const cursorRaw = c.req.query('cursor');
    if (cursorRaw !== undefined && cursorRaw !== '' && !/^-?\d+(\.\d+)?$/.test(cursorRaw)) {
      return c.json({ error: `invalid cursor '${cursorRaw}': pass back the nextCursor from the previous page verbatim` }, 400);
    }
    const cursorNum = Math.floor(Number(cursorRaw));
    const anchor = Number.isFinite(cursorNum) && cursorNum > 0 ? cursorNum : undefined;
    const statusRaw = c.req.query('status');
    // Same list-not-a-chain form as @gnldev/server's GET /runs — the two must accept the SAME
    // vocabulary or the Studio's own filter tabs 400 against a server that already understands them.
    const RUN_STATUSES = ['completed', 'suspended', 'failed', 'running', 'canceled'] as const;
    if (statusRaw != null && !(RUN_STATUSES as readonly string[]).includes(statusRaw)) {
      return c.json({ error: `invalid status '${statusRaw}' (expected one of ${RUN_STATUSES.join(', ')})` }, 400);
    }
    const status = statusRaw as (typeof RUN_STATUSES)[number] | undefined;
    const agent = c.req.query('agent') || undefined;
    const q = c.req.query('q') || undefined;
    // API-01/API-09: prefer the engine push-down (listRunsPaged) — avoids materializing EVERY run (see
    // Journal.ts JournalReader.listRunsPaged / postgres-storage.ts's indexed `ORDER BY ... LIMIT`)
    // Just to slice out one page. listRunsPaged's own order is ASCENDING (oldest-first, mirroring the
    // Underlying `ORDER BY created_at`), but studio's contract here is "newest first" (see
    // Studio-ui/api.ts's RunsPage type) — so a window is taken from the ascending end and reversed
    // Locally, never the whole table. `total` (countRunsByStatus's push-down aggregate, the SAME
    // Source GET /metrics already uses below) is read ONLY to anchor the FIRST page; every page after
    // That walks backwards from the cursor, so a concurrent insert cannot shift the window (see the
    // Cursor note above). Falls back to the legacy full-scan+reverse when
    // Either capability is missing (a bare custom JournalReader, or an adapter without a cheap status
    // Aggregate — e.g. Redis, see redis-storage.ts), when total couldn't be read, or (API-09) when an
    // `agent`/`q` filter is active: countRunsByStatus has no per-agent/per-substring count, so there is
    // No cheap way to learn the FILTERED total upfront (needed for the newest-first↔ascending conversion
    // Above) — those filters fall through to the in-memory path below, no worse than the engine's own
    // Agent handling (postgres-storage.ts also full-scans for `agent` — there's no indexed column for it).
    if (agent === undefined && q === undefined && typeof reader.listRunsPaged === 'function' && typeof rw.countRunsByStatus === 'function') {
      // NOTE: unlike a normal optional-capability call, this can't be `rw.countRunsByStatus().catch(...)`
      // under an active org (see the reader bridge above + organization.ts: countRunsByStatus is
      // Deliberately NOT bridged per-org), the call resolves SYNCHRONOUSLY to `undefined` (not a
      // Rejected promise, via `scopedNow().countRunsByStatus?.()`), and `.catch` on `undefined` throws.
      // Captured once: the narrowing from the `typeof` guards above survives neither the awaits below
      // nor the closures, and the re-anchor path calls both a second time.
      const countRuns = rw.countRunsByStatus.bind(rw);
      const paged = reader.listRunsPaged.bind(reader);
      let counted: Record<string, number> | undefined;
      try { counted = await countRuns(); } catch { counted = undefined; }
      if (counted) {
        // API-09: total is the FILTERED count — countRunsByStatus's per-status breakdown already gives
        // It for free when `status` is set; unfiltered, sum every status (unchanged from before).
        const total = status ? (counted[status] ?? 0) : Object.values(counted).reduce((a, b) => a + b, 0);
        // Clamped to `total`: a cursor issued before a retention sweep can point past the end, and an
        // unclamped anchor would ask the engine for a window that no longer exists.
        const window = (end: number) => {
          const ascEnd = Math.min(end, total);
          return { ascEnd, ascStart: Math.max(0, ascEnd - limit) };
        };
        const draw = async (w: { ascEnd: number; ascStart: number }) =>
          w.ascEnd > w.ascStart
            ? (await paged({ limit: w.ascEnd - w.ascStart, cursor: String(w.ascStart), ...(status ? { status } : {}) })).items.reverse()
            : [];

        let win = window(anchor ?? total);
        let items = await draw(win);
        // The count and the rows are two separate reads — two round-trips on Postgres — and a
        // retention sweep can land BETWEEN them. Then `total` describes a table that no longer
        // exists: it says 10, the window asks for rows 7-10, and the engine now holds 4. The answer
        // was an empty page carrying `total: 10` — page one of a list that visibly has runs in it.
        // The clamp above only fixes a cursor that went stale between REQUESTS; this is the same
        // staleness inside one. Re-anchor once against what the engine actually returned; a second
        // sweep in the same millisecond would need a third read, and at that point the honest answer
        // is a short page rather than an unbounded retry loop.
        if (items.length === 0 && win.ascStart > 0) {
          const fresh = await Promise.resolve(countRuns()).catch(() => undefined);
          const freshTotal = fresh
            ? (status ? (fresh[status] ?? 0) : Object.values(fresh).reduce((a, b) => a + b, 0))
            : total;
          if (freshTotal > 0 && freshTotal !== total) {
            win = window(freshTotal);
            items = await draw(win);
            return c.json({ items, nextCursor: win.ascStart > 0 ? String(win.ascStart) : undefined, total: freshTotal });
          }
        }
        return c.json({ items, nextCursor: win.ascStart > 0 ? String(win.ascStart) : undefined, total });
      }
    }
    const all = await reader.listRuns();
    // API-09: status/agent/q filters applied server-side BEFORE reversing/slicing — `total` below
    // Therefore already reflects the FILTERED set, never the whole journal (the UI shows `total` in its
    // Search placeholder, and it must describe the same set as `items`).
    const needle = q?.toLowerCase();
    const filtered = all.filter((r) =>
      (status === undefined || r.status === status) &&
      (agent === undefined || r.agent === agent) &&
      (needle === undefined || r.runId.toLowerCase().includes(needle)),
    );
    // Same ascending-anchor cursor as the push-down branch above, and it MUST be the same: the branch
    // taken depends on capabilities and filters, so one pagination session can start here and continue
    // there (countRunsByStatus is deliberately unbridged under an org and resolves to undefined). Two
    // cursor vocabularies would then be read by the wrong reader and serve a silently wrong page.
    // ThreadId now comes from listRuns itself (every adapter surfaces it from the run's invisible `:input`
    // Entry in a SINGLE read, see journal.ts RunSummary.threadId) — no ADDITIONAL N+1 read happens here.
    const ascEnd = Math.min(anchor ?? filtered.length, filtered.length);
    const ascStart = Math.max(0, ascEnd - limit);
    const items = filtered.slice(ascStart, ascEnd).reverse(); // journal append order is ascending → reversed = newest first
    return c.json({ items, nextCursor: ascStart > 0 ? String(ascStart) : undefined, total: filtered.length });
  });
  app.get('/runs/:id', async (c) =>
    (await allowP(c.req.raw, 'runs:read')) ? c.json(await reader.readRun(decodeURIComponent(c.req.param('id')))) : deny(c.req.raw, 'read'),
  );

  // Materialized state at step N (reconstructState).
  app.get('/runs/:id/state', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const q = Number(c.req.query('step'));
    const step = Number.isFinite(q) ? q : entries.length;
    const seed = writable ? await rw.get!(`${id}:input`) : undefined;
    return c.json(reconstructState(entries, step, seed as any));
  });

  // Memory-context provenance (':memctx', frozen next to ':input' by durable's persistMemoryContext):
  // The frozen input says WHAT the model saw; this says WHERE each part came from — recall hits with
  // Similarity, recent-window count, OM observations, WM injection, echo-trim. `null` for runs
  // Without memory, pre-provenance runs, or a read-only journal — the UI renders that honestly as
  // "no provenance recorded", never as an error.
  app.get('/runs/:id/memory-context', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    if (!writable) return c.json({ context: null });
    const id = decodeURIComponent(c.req.param('id'));
    const ctx = await rw.get!(`${id}:memctx`).catch(() => undefined);
    return c.json({ context: ctx ?? null });
  });

  // Cost/token (getRunCost).
  app.get('/runs/:id/cost', async (c) => {
    if (!(await allowP(c.req.raw, 'money:read'))) return deny(c.req.raw, 'read');
    return c.json(await getRunCost(reader, decodeURIComponent(c.req.param('id'))));
  });

  // Runtime scorer results: the registry (AgentConfig.scorers) and the `${runId}:proc:eval:<name>`
  // Records that scoreRun memoizes — the read surface for exactly-once scores.
  app.get('/runs/:id/scores', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ scores: {} });
    const id = decodeURIComponent(c.req.param('id'));
    const prefix = `${id}:proc:eval:`;
    const keys = await rw.listKeys!(prefix).catch(() => [] as string[]);
    const scores: Record<string, unknown> = {};
    for (const k of keys) {
      const rec = (await rw.get!(k).catch(() => undefined)) as { v?: unknown } | undefined;
      if (rec && typeof rec === 'object' && 'v' in rec) scores[k.slice(prefix.length)] = rec.v;
    }
    return c.json({ scores });
  });

  // Compliance reports: findings the pii-redactor/prompt-injection/moderation processors produced in
  // This run (`readProcessorReports` — @gnldev/durable, reads the `${runId}:procreport:...` prefix).
  // Empty list if the host doesn't use a processor / writable+listKeys is missing (SAME fallback as scores).
  app.get('/runs/:id/processors', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ reports: [] });
    const id = decodeURIComponent(c.req.param('id'));
    const reports = await readProcessorReports(rw as any, id).catch(() => []);
    return c.json({ reports });
  });

  // The run's guard incidents (duplicate guard / loop detection /
  // MaxToolCalls — warn/reflect/block/suspend) as queryable telemetry. Same optional-capability
  // Fallback as /processors: no listKeys → empty list (never an error).
  app.get('/runs/:id/incidents', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ incidents: [] });
    const id = decodeURIComponent(c.req.param('id'));
    const incidents = await readIncidents(rw as any, id).catch(() => []);
    return c.json({ incidents });
  });

  // Dynamic agent network trace (runNetwork): CAS-frozen routing decisions + step results —
  // The UI draws the dynamic tree (router → agent → result) from this. Nested run detail at /runs/net:<id>:<i>.
  app.get('/runs/:id/network', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ routes: [], steps: [] });
    const id = decodeURIComponent(c.req.param('id'));
    // Rw is Partial<Journal>; writable + listKeys was checked → the surface getNetworkTrace uses is complete.
    return c.json(await getNetworkTrace(rw as any, id).catch(() => ({ routes: [], steps: [] })));
  });

  // OTEL-like trace: durations from entries' ts + cost (for the waterfall).
  // Enrichment: tool spans are named via the toolCallId→toolName mapping and linked to the model step
  // That called them via `parent` (span index) → the UI draws a real nested tree.
  app.get('/runs/:id/trace', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const cost = await getRunCost(reader, id);
    const first = entries.find((e) => e.ts != null)?.ts ?? 0;
    const last = [...entries].reverse().find((e) => e.ts != null)?.ts ?? first;
    // ToolCallId → toolName from model steps' content (the journal's tool record has no name).
    const toolNames = new Map<string, string>();
    for (const e of entries) {
      if (e.kind !== 'model') continue;
      for (const p of ((e.value as any)?.content ?? []) as any[]) {
        if (p?.type === 'tool-call' && p.toolCallId) toolNames.set(p.toolCallId, p.toolName ?? 'tool');
      }
    }
    let lastModelIdx: number | null = null;
    let modelStep = 0;
    const spans = entries.map((e, i) => {
      const v: any = e.value;
      const start = e.ts ?? first;
      const end = entries[i + 1]?.ts ?? last;
      const base = { kind: e.kind, startMs: start - first, durationMs: Math.max(0, end - start) };
      if (e.kind === 'model') {
        lastModelIdx = i;
        return {
          ...base,
          name: 'llm.generate',
          step: modelStep++,
          parent: null as number | null,
          attrs: { model: v?.response?.modelId, finish: v?.finishReason, inTok: v?.usage?.inputTokens, outTok: v?.usage?.outputTokens },
        };
      }
      const toolCallId = e.key.slice(e.key.lastIndexOf(':tool:') + ':tool:'.length);
      return {
        ...base,
        name: toolNames.get(toolCallId) ?? 'tool.execute',
        parent: lastModelIdx,
        attrs: { status: v?.status, toolCallId },
      };
    });
    return c.json({ totalMs: last - first, cost, spans });
  });

  // Per-step diff: messages added between step N and N-1 + the pending delta (time-travel drill-down).
  app.get('/runs/:id/diff', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const step = Math.max(1, Number(c.req.query('step') ?? entries.length));
    const seed = writable ? await rw.get!(`${id}:input`) : undefined;
    const cur = reconstructState(entries, step, seed as any);
    const prev = reconstructState(entries, step - 1, seed as any);
    return c.json({ step, added: cur.messages.slice(prev.messages.length), pendingBefore: prev.pending, pendingAfter: cur.pending });
  });

  // Aggregate metrics (dashboard): run counts + total cost/tokens.
  // ── Governance endpoints: approval queue / audit / organizations ───────────────────
  // Approval queue (inbox): the pending tool approvals of ALL suspended runs in a single list.
  app.get('/approvals', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const runs = await reader.listRuns();
    const items: { runId: string; toolCallId: string; toolName: string; args?: unknown; reason?: string }[] = [];
    for (const r of runs) {
      if (r.status !== 'suspended') continue;
      const entries = await reader.readRun(r.runId);
      // The sentinel in a suspended tool record carries args/reason → shows context in the inbox
      const meta = new Map<string, { args?: unknown; reason?: string }>();
      for (const e of entries) {
        const v: any = e.value;
        const sus = e.kind === 'tool' && v?.status === 'suspended' ? v?.output?.__gnl_suspend : undefined;
        if (sus?.toolCallId) meta.set(sus.toolCallId, { args: sus.args, reason: sus.reason });
      }
      const st = reconstructState(entries, entries.length);
      for (const pnd of st.pending) {
        items.push({ runId: r.runId, toolCallId: pnd.toolCallId, toolName: pnd.toolName, ...(meta.get(pnd.toolCallId) ?? {}) });
      }
    }
    // Approval webhook: the SAME pattern as the budget alert — a SINGLE POST per pending approval via a
    // First-write-wins __alert__ marker (webhook errors are swallowed, never breaks the inbox flow).
    // Lazy trigger: since the UI polls /approvals every 5s, a suspension is reported within ~5s.
    if (opts.alerts?.webhook && writable) {
      const rootRw = rawReader as Partial<Journal> & JournalReader;
      for (const it of items) {
        try {
          if ((await rootRw.get!(`__alert__:approval:${it.runId}:${it.toolCallId}`)) === undefined) {
            const payload = { type: 'approval-pending', ...it };
            await appendLog(rootRw as Journal, '__alert__', payload, `approval:${it.runId}:${it.toolCallId}`);
            await postAlert(payload);
          }
        } catch { /* alert is best-effort — swallow */ }
      }
    }
    return c.json({ items });
  });

  // Audit trail: the __audit__ log — NEWEST FIRST; exact-match action + substring q filters.
  // Org filter: a bound identity (Principal.orgId) sees ONLY its own context (?org= is ignored — it
  // Can't read anyone else's record); an unbound (operator) identity can optionally filter with ?org=.
  // NOTE: __audit__ lives in the ROOT (non-org-prefixed) journal → the raw `rawReader` is used instead
  // Of the ALS-scoped `rw` (otherwise a bound identity's GET would be scoped by the org middleware to a
  // Non-existent prefix like org:<id>:__audit__: and always return empty — see the rootRw pattern in /organizations).
  app.get('/audit', async (c) => {
    if (!(await allowP(c.req.raw, 'audit:read'))) return deny(c.req.raw, 'read');
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    if (!writable || typeof rootRw.listKeys !== 'function') return c.json({ items: [] });
    const limit = Math.max(1, Math.min(1000, Number(c.req.query('limit') ?? 200)));
    const action = c.req.query('action');
    const q = c.req.query('q')?.toLowerCase();
    // The ALS-resolved org counts too, not just the identity-bound one. `opts.org.resolve` / `x-gnl-org`
    // put the caller's organization in the ALS without touching the principal, and reading only
    // `principalOf(...).orgId` here meant that supported setup got EVERY organization's records back.
    // Line ~796 already resolves it this way, with a comment saying the alternative "would make GET
    // /managed-agents return the root store for EVERY org (a leak)" — the same leak, two endpoints over.
    const bound = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    const org = bound ?? (c.req.query('org') || undefined);
    // Bounded read, newest first. Every organization's writes land in this single root log, so an
    // unbounded read meant one organization's `limit=1` cost one `get` per record in the PLATFORM's entire
    // history — measured at 2001 gets for a 2000-record log, which on Postgres is 2000 round trips to
    // return one row. The scan window is generous relative to the page so filters still have material
    // to work with, and when it does cut the history short the response says so rather than presenting
    // a partial answer as a complete one.
    const scan = Math.max(limit * 20, 500);
    const total = await countLog(rootRw as Journal, '__audit__');
    const logs = await listLog<{ actor: string; action: string; target: string; org?: string; detail?: unknown }>(
      rootRw as Journal, '__audit__', { limit: scan },
    );
    // An ORG-scoped view starts at that org's current tenancy. `__audit__` is not org-prefixed, so it
    // survives purgeOrganization by design — an audit log erased by the operation it records is not an
    // audit log — but org ids are human-chosen strings ('acme', a company slug), and the same id going
    // to a different customer later is ordinary. Without this cutoff the next holder of an id opened
    // /audit and read who did what in the previous tenancy. The OPERATOR's unscoped view is unchanged
    // and still shows everything, including the purge itself.
    const purgedAt = org
      ? ((await rootRw.get?.(orgPurgedKey(org))) as { at?: number } | undefined)?.at ?? 0
      : 0;
    const items = logs
      .map((l) => ({ id: l.id, at: l.at, ...l.payload }))
      .filter((i) => !action || i.action === action)
      .filter((i) => !org || i.org === org)
      .filter((i) => !org || (i.at ?? 0) > purgedAt)
      .filter((i) => !q || i.target.toLowerCase().includes(q) || i.actor.toLowerCase().includes(q))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, limit);
    // `scanned`/`truncated` rather than a quietly short list: a filter that matches nothing inside the
    // window is indistinguishable from a filter that matches nothing at all, and only one of those is
    // worth changing the query over.
    return c.json({ items, scanned: Math.min(scan, total), total, truncated: total > scan });
  });

  // Organizations: listed from `org:<id>:` prefixes + usage/cost + budget status (opts.budgets).
  // A SINGLE notification to opts.alerts.webhook on budget overrun (first-write-wins __alert__ marker).
  const ORG_KEY_PRE = 'org:';
  const listOrganizations = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'money:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ organizations: [] });
    // The scan always happens on the ROOT journal (org: prefixes aren't visible in the org-scoped view);
    // An identity-bound org sees ONLY itself — the global list is open only to unbound (operator) identities.
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    const keys = await rootRw.listKeys!(ORG_KEY_PRE).catch(() => [] as string[]);
    // The ALS-resolved org counts too, not just the identity-bound one. `opts.org.resolve` / `x-gnl-org`
    // put the caller's organization in the ALS without touching the principal, and reading only
    // `principalOf(...).orgId` here meant that supported setup got EVERY organization's records back.
    // Line ~796 already resolves it this way, with a comment saying the alternative "would make GET
    // /managed-agents return the root store for EVERY org (a leak)" — the same leak, two endpoints over.
    const bound = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    // Merge DISCOVERED orgs (with org:<id>: prefixed data) with EXPLICITLY REGISTERED ones (__org__:<id>) →
    // A newly created org with no runs yet also shows up in the list.
    const discovered = keys.map((k) => { const j = k.indexOf(':', ORG_KEY_PRE.length); return j > ORG_KEY_PRE.length ? k.slice(ORG_KEY_PRE.length, j) : ''; }).filter(Boolean);
    // ListKeys also returns tombstones (put(__org__:id, null) — see DELETE /organizations); the codebase's
    // General convention is `get(...) != null` = "exists" (see ~line 972, ~1029). A deleted org would
    // Otherwise stay in the list (the "0 records deleted but still shows on screen" bug) → skip records with a null value.
    const registered: string[] = [];
    for (const k of await rootRw.listKeys!(ORG_PRE).catch(() => [] as string[])) {
      if ((await rootRw.get!(k).catch(() => undefined)) != null) registered.push(k.slice(ORG_PRE.length));
    }
    const ids = [...new Set([...discovered, ...registered])].filter((id) => !bound || id === bound).sort();
    const orgs: { id: string; label?: string; runs: number; tokens: number; costUsd: number; source?: 'materialized' | 'scan'; budget?: { usdLimit?: number; tokenLimit?: number; exceeded: boolean; inherited: boolean } }[] = [];
    for (const id of ids) {
      const view = withOrg(rootRw as Journal, id) as unknown as Partial<Journal> & JournalReader;
      const runsList = typeof view.listRuns === 'function' ? await view.listRuns() : [];
      let tokens = 0;
      let costUsd = 0;
      // API-02: fast path — the SAME materialized-counter shortcut GET /metrics already uses
      // (readMetricsSummary → O(1) getCounters point-read), instead of a SEQUENTIAL
      // GetRunCost/readRun scan over EVERY run in the organization. withOrg bridges getCounters
      // 1:1 (key-prefixed, see organization.ts) → this stays per-org isolated, same as /metrics'
      // Own use of it. `source` mirrors /metrics' honesty field so the UI/tests can tell which
      // Path served the response.
      let source: 'materialized' | 'scan' = 'scan';
      if (typeof view.getCounters === 'function') {
        // `days: 0` — this loop reads `all` and nothing else. The default summary also builds 14
        // daily buckets at 17 point reads each, and every one of them was discarded here: 255 reads
        // per organization to use 17, on every load of the list. Fifty organizations meant 12,750
        // reads against the caller's own database to answer one page.
        const summary = await readMetricsSummary(view as unknown as Journal, { days: 0 });
        if (summary.all) {
          tokens = summary.all.tokens ?? 0;
          costUsd = summary.all.costUsd ?? 0;
          source = 'materialized';
        }
      }
      // No materialized data yet (older data / a journal without getCounters) — fall back to the
      // Legacy per-run scan so behavior is IDENTICAL to before this fix. NOTE: `view.countRunsByStatus`
      // Is intentionally NOT used here — withOrg deliberately does not bridge it (an org-scoped
      // Aggregate would otherwise leak every organization's counts, see organization.ts) — run COUNT
      // Keeps coming from `runsList` above (already a cheap listRuns() summary pass, not a per-run
      // ReadRun) in both the fast and the scan path, so it's unaffected either way.
      if (source === 'scan') {
        for (const r of runsList) {
          const rc = await getRunCost(view, r.runId);
          tokens += rc.totalTokens;
          costUsd += rc.costUsd;
        }
      }
      // Label: from the __org__:<id> record document (collected via POST /organizations) — GET used to
      // Never read it, so the label was collected but never shown in the UI (see bug report #1). An
      // Implicit/discovered org (not yet registered) has no label.
      const orgRec = (await rootRw.get!(ORG_PRE + id).catch(() => undefined)) as { label?: string } | undefined;
      const label = orgRec?.label;
      // Effective limit: the journal's __budget__ document (managed from Studio, enforced by @gnldev/server)
      // > the host config fallback (opts.budgets). readBudget resolves the same way as @gnldev/server's enforcement.
      // Inherited: true if the ORG'S OWN __budget__:<id> document is missing/unlimited (inherited from the
      // Default) — distinguished so the UI doesn't pre-fill these inherited values on edit and accidentally
      // Create a per-org override (see bug report #3).
      const ownBudgetDoc = (await rootRw.get!(BUDGET_PRE + id).catch(() => undefined)) as { usdLimit?: number; tokenLimit?: number } | null | undefined;
      const hasOwnBudget = !!ownBudgetDoc && (ownBudgetDoc.usdLimit != null || ownBudgetDoc.tokenLimit != null);
      const lim = (await readBudget(rootRw, id)) ?? opts.budgets?.perOrg?.[id] ?? opts.budgets?.default;
      let budget: { usdLimit?: number; tokenLimit?: number; exceeded: boolean; inherited: boolean } | undefined;
      if (lim && (lim.usdLimit != null || lim.tokenLimit != null)) {
        const exceeded = (lim.usdLimit != null && costUsd > lim.usdLimit) || (lim.tokenLimit != null && tokens > lim.tokenLimit);
        budget = { ...lim, exceeded, inherited: !hasOwnBudget };
        if (exceeded && opts.alerts?.webhook) {
          try {
            if ((await rootRw.get!(`__alert__:budget:${id}`)) === undefined) {
              const payload = { type: 'budget-exceeded', org: id, costUsd, tokens, limits: lim };
              await appendLog(rootRw as Journal, '__alert__', payload, `budget:${id}`);
              await postAlert(payload);
            }
          } catch { /* alert is best-effort — swallow */ }
        }
      }
      orgs.push({ id, ...(label ? { label } : {}), runs: runsList.length, tokens, costUsd, source, ...(budget ? { budget } : {}) });
    }
    // The default budget is also included in the response so the panel can edit it (journal > opts fallback).
    const defaultBudget = (await readBudget(rootRw, undefined)) ?? opts.budgets?.default ?? null;
    return c.json({ organizations: orgs, defaultBudget });
  };
  app.get('/organizations', listOrganizations);

  // CREATE org (register): makes an org with no runs yet visible in the list → budget/users can be assigned.
  // Only an unbound (operator) identity can create; an org-bound identity cannot create another org.
  const createOrganization = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'org:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'org management requires a writable journal' }, 501);
    if (!multiOrganizationEnabled) return c.json({ error: 'multi-org is not enabled (single org)' }, 501);
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot create a new org'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; label?: string };
    const id = String(body.id ?? '').trim();
    if (!id) return c.json({ error: 'id is required' }, 400);
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    if (id === 'default') return c.json({ error: "'default' is reserved (default budget fallback)" }, 400);
    const rootJ = rawReader as unknown as Journal;
    if ((await rootJ.get(ORG_PRE + id)) != null) return c.json({ error: `org '${id}' is already registered` }, 409);
    const rec = { id, ...(body.label ? { label: String(body.label) } : {}), createdAt: Date.now() };
    await rootJ.put(ORG_PRE + id, rec);
    await audit(c, 'org.create', id, { label: rec.label });
    return c.json({ ok: true, organization: rec });
  };
  app.post('/organizations', createOrganization);

  // DELETE org (GDPR/cleanup): PERMANENTLY delete ALL `org:<id>:` data + the record + the budget document (irreversible).
  const deleteOrganization = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'org:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'org management requires a writable journal' }, 501);
    if (!multiOrganizationEnabled) return c.json({ error: 'multi-org is not enabled (single org)' }, 501);
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot delete an org'); if (denied) return denied; }
    const rootJ = rawReader as unknown as Journal;
    if (typeof rootJ.deletePrefix !== 'function') {
      return c.json({ error: 'org deletion requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    }
    // Note: the standalone `const` handler uses the generic Hono `Context` type (no route-specific path
    // Literal) → ':id' therefore needs `!`.
    const id = decodeURIComponent(c.req.param('id')!);
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    // GDPR runbook: purgeOrganization = the same org:<id>: sweep this line used to do inline, now the
    // ONE documented deletion surface (covers counters/metrics/wfrun/xrun too — see its JSDoc for what
    // Is deliberately NOT deleted: root __audit__ retention, orgless-scope data, EE users [handled below]).
    const deleted = await purgeOrganization(rootJ, id);       // the org's entire run/memory/queue trail
    await rootJ.put(ORG_PRE + id, null);                     // remove the record
    await rootJ.put(BUDGET_PRE + id, null);                     // remove the budget document
    // Prevent orphaned EE users: if members bound to the org aren't also deleted when the org is
    // Deleted, their tokens still validate (a ghost of the deleted org remains). Remove members too if opts.users is given.
    let removedUsers = 0;
    if (opts.users) {
      const members = (await opts.users.list()).filter((u) => u.orgId === id);
      for (const u of members) { await opts.users.remove(u.id); removedUsers++; }
    }
    await audit(c, 'org.delete', id, { deleted, ...(removedUsers ? { removedUsers } : {}) });
    return c.json({ ok: true, id, deleted, ...(removedUsers ? { removedUsers } : {}) });
  };
  app.delete('/organizations/:id', deleteOrganization);

  // ── Identity: the logged-in principal (UI "who am I logged in as" + org context) ───
  // Allow() attaches the principal to the context → principalOf reads it afterward. If auth is off,
  // Allow is always true + principal null → anonymous (everything open); if auth is on with no token, 401.
  app.get('/me', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const p = principalOf(c.req.raw);
    // NEW fields for the (separate) UI iteration:
    //  • platformAdmin — the EXPLICIT cross-org grant (scope: 'platform').
    //  • scope — resolved scope tag: 'platform' | 'org:<id>' | 'none'. In strict mode 'none' means the
    //    Caller is fail-closed (org-less, no grant); in free mode 'none' is the legacy operator.
    //  • strictMultiOrg — whether the paid strict model is active (so the UI can interpret 'none').
    // `operator` is kept UNCHANGED (legacy: org-less) for backward-compat.
    const s = principalScope(p);
    const scope = s.kind === 'org' ? `org:${s.orgId}` : s.kind; // 'platform' | 'org:<id>' | 'none'
    return c.json({
      id: p?.id ?? null,
      roles: p?.roles ?? [],
      orgId: p?.orgId ?? null,
      operator: !!p && !p.orgId,
      platformAdmin: isPlatformAdmin(p),
      scope,
      strictMultiOrg,
    });
  });

  // ── Permission catalog (read-only; the code-defined, GNL-team-owned list) ───────────────
  // Exposes the fine-grained permission catalog + the role→preset map so the UI can render assignment
  // Checkboxes and seed them from a role. Fine-grained permissions are a PAID (RBAC) capability → when
  // RBAC is OFF (free tier, coarse read/write only) the catalog is reported disabled/empty so the UI
  // Doesn't offer a model the backend can't enforce. This endpoint is READ-ONLY: there is no create/edit/
  // Delete of permission TYPES — the GNL team extends the catalog in code together with its enforcement.
  app.get('/permissions/catalog', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!rbacEnabled) return c.json({ enabled: false, permissions: [], rolePresets: {} });
    return c.json({ enabled: true, permissions: PERMISSION_CATALOG, rolePresets: ROLE_PERMISSION_PRESETS });
  });

  /**
   * Provider prefixes `resolveModel` understands — the four built-ins plus whatever the host taught it
   * with `registerModelProvider`.
   *
   * The Playground's model box suggests ids for the built-ins from a hardcoded list, so a deployment
   * wired to an OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a local server) registered its
   * prefix and then saw no sign of it anywhere in the UI — the very symptom
   * `registerModelProvider` was added to fix, still present one layer up. The registry knew; nothing
   * asked it. `knownModelProviders()` had no non-test caller at all.
   *
   * Behind the read gate rather than on `/capabilities`: that endpoint is deliberately public so the
   * login screen can render, and which providers a deployment routes to is configuration, not
   * something to hand out before anyone has identified themselves.
   */
  app.get('/model-providers', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    // Model ids come from the journal and from host config, never from a list compiled into the UI.
    // Providers add and rename models constantly, and a suggestion list baked into the bundle is one
    // that needs a gnl RELEASE to mention a model that shipped this morning — the same trap
    // DEFAULT_PRICING was in, and the same way out.
    //
    // The `__pricing__` overrides are included because they are already the list of models this
    // deployment cares about: anyone running a model they were not born knowing has to price it for
    // maxCostUsd to mean anything, so the ids are there for free and stay current without a second
    // place to edit.
    const doc = await readPricing(rw as never).catch(() => undefined);
    const priced = doc?.models ? Object.keys(doc.models) : [];
    const models = [...new Set([...(opts.modelSuggestions ?? []), ...priced])];
    return c.json({ providers: knownModelProviders(), models });
  });

  // ── User management (paid; if opts.users is given) ────────────────────────
  // ORG MODEL: org = organization, user = a MEMBER belonging to exactly 1 org, operator = a user with no
  // Org (platform-level). The token is returned ONCE on creation (the server never stores it in plaintext).
  //  • Operator (org-less admin): creates/deletes members in any org + can create org-less (operator) users.
  //  • Org-admin (bound admin): manages ONLY its OWN org's members (orgId is forced to its own org).
  //  • Member assignment is validated against an EXISTING org (a member cannot be added to a ghost org).
  async function orgExists(id: string): Promise<boolean> {
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    if ((await rootRw.get?.(ORG_PRE + id)) != null) return true; // explicitly registered
    const keys = await rootRw.listKeys?.(`${ORG_KEY_PRE}${id}:`).catch(() => [] as string[]);
    return !!keys?.length; // or an org with (implicit) data
  }

  app.get('/users', async (c) => {
    if (!(await allowP(c.req.raw, 'users:read'))) return deny(c.req.raw, 'read');
    if (!opts.users) return c.json({ users: [] });
    const own = principalOf(c.req.raw)?.orgId;
    const all = await opts.users.list();
    // Org-admin sees ONLY its own org's members; operator sees all.
    return c.json({ users: own ? all.filter((u) => u.orgId === own) : all });
  });

  app.post('/users', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled (the host must provide a userStore)' }, 501);
    const own = principalOf(c.req.raw)?.orgId;
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; roles?: string[]; permissions?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number };
    if (body.roles && (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== 'string'))) {
      return c.json({ error: 'roles must be a string array' }, 400);
    }
    if (body.permissions && (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== 'string'))) {
      return c.json({ error: 'permissions must be a string array' }, 400);
    }
    if (body.ttlMs != null && (typeof body.ttlMs !== 'number' || body.ttlMs <= 0)) {
      return c.json({ error: 'ttlMs must be a positive number' }, 400);
    }
    if (body.expiresAt != null && typeof body.expiresAt !== 'number') {
      return c.json({ error: 'expiresAt must be an epoch ms number' }, 400);
    }
    // PRIVILEGE CEILING: `users:write` lets an admin manage users, but it must NOT let a non-platform-admin
    // MINT the reserved `platform-admin` role (or the `'*'` super-grant) — that would create a cross-org
    // Super-admin out of an org-bound admin. Same-org checks below guard the target's org, not its privileges.
    {
      const ceiling = assertAssignablePrivileges(principalOf(c.req.raw), { roles: body.roles, permissions: body.permissions });
      if (!ceiling.ok) return c.json({ error: ceiling.reason }, 403);
    }
    let targetOrg = body.orgId?.trim() || undefined;
    if (own) {
      // Org-admin: the target is always ITS OWN org (a different/operator request is rejected).
      if (targetOrg && targetOrg !== own) {
        return c.json({ error: `you can only create users in your own org ('${own}')` }, 403);
      }
      targetOrg = own;
    } else if (targetOrg) {
      // Operator: a member must be assigned to an EXISTING org (org-less = legitimately creating another operator).
      if (targetOrg.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
      if (!(await orgExists(targetOrg))) {
        return c.json({ error: `org '${targetOrg}' doesn't exist — create the org first` }, 400);
      }
    }
    try {
      const created = await opts.users.create({
        email: body.email, name: body.name, roles: body.roles,
        ...(body.permissions?.length ? { permissions: body.permissions } : {}),
        orgId: targetOrg,
        ...(body.ttlMs != null ? { ttlMs: body.ttlMs } : {}),
        ...(body.expiresAt != null ? { expiresAt: body.expiresAt } : {}),
      });
      await audit(c, 'user.create', created.user.id, { roles: created.user.roles, ...(created.user.permissions ? { permissions: created.user.permissions } : {}), orgId: created.user.orgId });
      return c.json({ ok: true, ...created }); // { user, token } — token only here
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  app.delete('/users/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      // Org-admin can only delete a member of ITS OWN org.
      /**
       * `!target` is a REFUSAL, not a pass. The guard used to read `if (target && target.orgId !== own)`,
       * so a target the caller could not see skipped it entirely and the write went ahead. Measured
       * against a store whose `list()` returns nothing:
       *
       *   DELETE /users/u1 as acme-adm  ->  200 {"ok":true}   host calls: ["remove:u1"]
       *
       * — acme's admin deleting globex's user. `StudioUserStore.list()` takes no argument and nothing in
       * its contract says it must return every user of every organization, yet three guards depended on
       * exactly that. Both first-party stores do, so the shipped path was safe; a third-party store, or
       * scoping `list()` later as a security improvement, would have disabled all three at once.
       *
       * An organization-bound caller acting on a user it cannot see is refused. `POST /users` never had
       * this shape — it compares `body.orgId` to the caller directly, with no lookup.
       */
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (!target || target.orgId !== own) {
        return c.json({ error: `you can only delete members of your own org ('${own}')` }, 403);
      }
    }
    await opts.users.remove(id);
    await audit(c, 'user.delete', id);
    return c.json({ ok: true, id });
  });

  // Invalidate the user's token WITHOUT deleting the user (audit/history remains). Only enabled if
  // Opts.users.revoke is provided (501 if the host doesn't support it). SAME permission rule as DELETE /users/:id.
  app.post('/users/:id/revoke', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    if (!opts.users.revoke) return c.json({ error: 'revoke is not enabled for this host' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      // Org-admin can only revoke a member of ITS OWN org. `!target` refuses — see the delete route.
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (!target || target.orgId !== own) {
        return c.json({ error: `you can only revoke members of your own org ('${own}')` }, 403);
      }
    }
    await opts.users.revoke(id);
    await audit(c, 'user.revoke', id);
    return c.json({ ok: true, id });
  });

  // PATCH a user's roles and/or explicit permissions (the customer admin ASSIGNS catalog permissions to a
  // User via checkboxes). The token is unchanged; the next authenticate picks up the new grants. SAME
  // Permission + org-scope rules as the other /users writes (org-admin: own org only; operator: any).
  app.patch('/users/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    if (!opts.users.update) return c.json({ error: 'user update is not enabled for this host' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      // `!target` refuses — see the delete route.
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (!target || target.orgId !== own) {
        return c.json({ error: `you can only update members of your own org ('${own}')` }, 403);
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as { roles?: string[]; permissions?: string[] };
    if (body.roles !== undefined && (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== 'string'))) {
      return c.json({ error: 'roles must be a string array' }, 400);
    }
    if (body.permissions !== undefined && (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== 'string'))) {
      return c.json({ error: 'permissions must be a string array' }, 400);
    }
    if (body.roles === undefined && body.permissions === undefined) {
      return c.json({ error: 'nothing to update (provide roles and/or permissions)' }, 400);
    }
    // PRIVILEGE CEILING (see POST /users): an admin cannot ELEVATE a user (or itself) to `platform-admin`
    // / `'*'` via PATCH either — this is the self-grant path (PATCH /users/<own-id> {roles:[...]}).
    {
      const ceiling = assertAssignablePrivileges(principalOf(c.req.raw), { roles: body.roles, permissions: body.permissions });
      if (!ceiling.ok) return c.json({ error: ceiling.reason }, 403);
    }
    try {
      const user = await opts.users.update(id, {
        ...(body.roles !== undefined ? { roles: body.roles } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      });
      await audit(c, 'user.update', id, { roles: user.roles, ...(user.permissions ? { permissions: user.permissions } : {}) });
      return c.json({ ok: true, user });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Write/clear an org's budget (management — admin): the `__budget__:<id>` document in the journal.
  // Id='default' is the fallback for all orgs. Empty body/null values → the budget is deleted.
  // @gnldev/server's write path reads this document LIVE → changes take effect without a redeploy.
  const putOrganizationBudget = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'budget:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'budget management requires a writable journal' }, 501);
    // Note: the standalone `const` handler uses the generic Hono `Context` type (no route-specific path
    // Literal) → ':id' therefore needs `!` (see the note on the DELETE handler).
    const id = decodeURIComponent(c.req.param('id')!);
    // An identity-bound org can ONLY write ITS OWN budget — it cannot change someone else's or the
    // 'default' fallback (the write-side counterpart of the visibility restriction in GET /organizations).
    // An unbound (operator) identity manages all of them.
    // The ALS-resolved org counts too, not just the identity-bound one. `opts.org.resolve` / `x-gnl-org`
    // put the caller's organization in the ALS without touching the principal, and reading only
    // `principalOf(...).orgId` here meant that supported setup got EVERY organization's records back.
    // Line ~796 already resolves it this way, with a comment saying the alternative "would make GET
    // /managed-agents return the root store for EVERY org (a leak)" — the same leak, two endpoints over.
    const bound = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    if (bound && id !== bound) {
      return c.json({ error: `unauthorized: identity is bound to org '${bound}', cannot manage the budget of '${id}'` }, 403);
    }
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { usdLimit?: number | null; tokenLimit?: number | null };
    const usd = body.usdLimit;
    const tok = body.tokenLimit;
    for (const [k, v] of [['usdLimit', usd], ['tokenLimit', tok]] as const) {
      if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        return c.json({ error: `${k} must be a non-negative number` }, 400);
      }
    }
    const rootJ = rawReader as unknown as Journal;
    const budget: BudgetLimit | null = (usd == null && tok == null)
      ? null
      : { ...(usd != null ? { usdLimit: usd } : {}), ...(tok != null ? { tokenLimit: tok } : {}) };
    await rootJ.put(BUDGET_PRE + id, budget);
    await audit(c, 'org.budget', id, { budget });
    return c.json({ ok: true, id, budget });
  };
  app.put('/organizations/:id/budget', putOrganizationBudget);

  // P1.6 fast path — if the (org-scoped) journal has materialized counters
  // (`getCounters` bridged above + `__metrics__:all` has data), byStatus is STILL a cheap listRuns()
  // Summary pass (no readRun/getRunCost per run), and costUsd/tokens/byDay come straight off the
  // Counters (O(1 + days), see readMetricsSummary) — no per-run scan at all. `source` tells the caller
  // Which path served the response (materialized vs the legacy full scan) so Studio's UI/tests can tell.
  app.get('/metrics', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (typeof rw.getCounters === 'function') {
      const daysParam = Number(c.req.query('days'));
      // Clamped to at least one bucket HERE rather than inside `readMetricsSummary`, which now
      // accepts 0 so an internal caller can ask for the running totals alone. `?days=0` has always
      // answered with today's bucket, and this endpoint is published — the widening is for callers
      // in this process, not a change to what the URL means.
      const days = Number.isFinite(daysParam) ? Math.max(1, Math.trunc(daysParam)) : undefined;
      const summary = await readMetricsSummary(rw as unknown as Journal, { days });
      if (summary.all) {
        // P1.6b: when the (org-scoped) reader exposes `countRunsByStatus`, use the ENGINE-LEVEL push-down
        // Aggregate (O(distinct statuses), see journal.ts JournalReader.countRunsByStatus) instead of
        // Materializing every RunSummary via listRuns() just to count them. Falls back to the listRuns
        // Scan when unavailable (custom journal, or an org-scoped view — countRunsByStatus is
        // Deliberately NOT bridged per-org, see organization.ts).
        // `Promise.resolve(...)` before `.catch`, because the bridge above deliberately resolves this
        // call to `undefined` under an active organization — it says so in its own comment, and the
        // fallback below is written for exactly that. The call site then did `.catch()` on the result
        // BEFORE awaiting it, so `undefined.catch` threw and `GET /metrics` answered 500 to every
        // organization-scoped caller while the unscoped operator got 200. Measured in a browser against
        // a live Postgres deployment: acme/admin and globex/admin both 500, ops-admin 200, and Studio's
        // stat cards read `Runs 0 · Tokens 0` next to a list that showed one run.
        //
        // The setup-time `typeof` check cannot catch this: the bridge object always carries the method,
        // and whether it returns a promise depends on the ALS scope at CALL time.
        const counted = typeof rw.countRunsByStatus === 'function'
          ? await Promise.resolve(rw.countRunsByStatus()).catch(() => undefined)
          : undefined;
        let total: number;
        let byStatus: Record<string, number>;
        if (counted) {
          byStatus = counted;
          total = Object.values(counted).reduce((a, b) => a + b, 0);
        } else {
          const runs = await reader.listRuns();
          byStatus = {};
          for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
          total = runs.length;
        }
        return c.json({
          total,
          byStatus,
          costUsd: summary.all.costUsd ?? 0,
          tokens: summary.all.tokens ?? 0,
          source: 'materialized',
          byDay: summary.byDay,
        });
      }
    }
    // Legacy full scan (no materialized counters yet — pre-P1.6 data, or a journal without incrBy/getCounters).
    const runs = await reader.listRuns();
    const byStatus: Record<string, number> = {};
    let costUsd = 0, tokens = 0;
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    for (const r of runs) { const rc = await getRunCost(reader, r.runId); costUsd += rc.costUsd; tokens += rc.totalTokens; }
    return c.json({ total: runs.length, byStatus, costUsd, tokens, source: 'scan' });
  });

  // Per-run metric rows (Observability: time-series + latency percentiles + a rich table).
  // P1.6: for a finalized run, the `__metrics__run:<runId>` row (written once at completion — see
  // Registry.ts's post-run hook / metrics.ts recordRunMetrics) is read directly — no readRun/getRunCost.
  // Only runs WITHOUT that row (in-flight, or older than this feature / a journal without incrBy) fall
  // Back to the readRun+getRunCost scan. Response shape is UNCHANGED (same field names as before).
  app.get('/metrics/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    let runs = await reader.listRuns();
    // P1.6b: optional ?limit= — clamp 1..1000, slicing the run list BEFORE fetching any rows (a cheap
    // Partial win). Full cursor-based pagination for this endpoint is P0.3's job — not attempted here.
    const limitRaw = c.req.query('limit');
    if (limitRaw !== undefined) {
      const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 1000);
      runs = runs.slice(0, limit);
    }
    // P1.6b: ONE getMany round-trip for every fast-path row instead of N sequential rw.get calls, when
    // The (org-scoped) reader exposes it; falls back to the per-run rw.get loop otherwise (custom
    // Journal, or a journal without getMany at all).
    const fastRows: (MetricsRunRow | undefined)[] = typeof rw.getMany === 'function'
      ? await rw.getMany<MetricsRunRow>(runs.map((r) => metricsRunKey(r.runId))).catch(() => runs.map(() => undefined))
      : [];
    const rows = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      const row = fastRows[i] ?? (typeof rw.getMany !== 'function' && typeof rw.get === 'function'
        ? await rw.get<MetricsRunRow>(metricsRunKey(r.runId)).catch(() => undefined)
        : undefined);
      if (row) {
        rows.push({
          runId: r.runId,
          // D5: STATUS COMES FROM THE LIVE LIST, NEVER FROM THE ROW. The row is written once, the first
          // time a run finishes successfully (metrics.ts recordRunMetrics, exactly-once per runId) — so a
          // run that succeeded, was re-run and FAILED (or was canceled) kept a row saying 'completed'
          // while GET /runs, reading the same journal, said 'failed'. The aggregate contradicted the list
          // directly above it in Observability, and the row's `status` could never even hold three of the
          // five values its type claimed (see MetricsRunRow.status).
          // Fixed at READ time, not write time: making the row truthful when written does not keep it
          // truthful — the D5 scenario is precisely a verdict that changes AFTER the write — and
          // recording metrics on the failure path too would put failed runs into the day/cost aggregates
          // that /metrics reports as spend. So STATUS is served from the journal, which is its one source
          // of truth, and COST/tokens stay materialized in the row, which is the whole point of the fast
          // path: one owner each for living state and for settled history.
          // Free, not an N+1: `r` is the RunSummary this handler ALREADY fetched via listRuns() above,
          // and every adapter derives its status from the current `:outcome` record (deriveRunStatus).
          // No per-row outcome get, no extra round-trip, unchanged under ?limit=.
          status: r.status,
          modelSteps: row.modelSteps,
          toolCalls: row.toolCalls,
          startTs: row.startTs,
          durationMs: row.durationMs,
          costUsd: row.costUsd,
          totalTokens: row.totalTokens,
        });
        continue;
      }
      const entries = await reader.readRun(r.runId);
      const ts = entries.map((e) => e.ts).filter((t): t is number => t != null);
      const startTs = ts.length ? Math.min(...ts) : null;
      const endTs = ts.length ? Math.max(...ts) : null;
      const rc = await getRunCost(reader, r.runId);
      rows.push({
        runId: r.runId,
        status: r.status,
        modelSteps: r.modelSteps,
        toolCalls: r.toolCalls,
        startTs,
        durationMs: startTs != null && endTs != null ? endTs - startTs : null,
        costUsd: rc.costUsd,
        totalTokens: rc.totalTokens,
      });
    }
    return c.json({ runs: rows });
  });

  // ── SSE ticket (opt-in, audit #2): since EventSource can't send headers, the roleAuth `?token=`
  // Fallback carries the persistent secret in the URL (a log-leak risk — see role-auth.ts's JSDoc). An
  // Alternative: authenticated `POST /auth/sse-ticket` generates a SINGLE-USE random ticket with a 60s TTL;
  // `GET /events?ticket=...` consumes it IMMEDIATELY (unusable again). An in-memory Map; TTL sweeping is
  // Done lazily on every issue/consume call (no separate timer needed, leaves no dangling handle at
  // Test/process shutdown). The existing `?token=` behavior is preserved UNCHANGED — this is only a safer
  // ADDITIONAL path (backward compatible).
  const SSE_TICKET_TTL_MS = 60_000;
  const sseTickets = new Map<string, { principal: Principal | null; expiresAt: number }>();
  function sweepSseTickets(now: number): void {
    for (const [t, v] of sseTickets) if (v.expiresAt <= now) sseTickets.delete(t);
  }
  function issueSseTicket(principal: Principal | null): { ticket: string; expiresAt: number } {
    const now = Date.now();
    sweepSseTickets(now);
    const ticket = randomUUID();
    const expiresAt = now + SSE_TICKET_TTL_MS;
    sseTickets.set(ticket, { principal, expiresAt });
    return { ticket, expiresAt };
  }
  /** If the ticket is valid, returns its principal AND CONSUMES IT IMMEDIATELY (single-use); undefined if invalid/expired. */
  function consumeSseTicket(ticket: string): Principal | null | undefined {
    const now = Date.now();
    sweepSseTickets(now);
    const v = sseTickets.get(ticket);
    if (!v) return undefined;
    sseTickets.delete(ticket); // single-use: found or not, it never becomes valid again
    return v.expiresAt > now ? v.principal : undefined;
  }
  // Getting a ticket also requires READ permission (viewer/admin) — if auth is off (no provider), allow()
  // Already returns true, so the ticket is issued freely (consistent with the existing open behavior).
  app.post('/auth/sse-ticket', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const { ticket, expiresAt } = issueSseTicket(principalOf(c.req.raw));
    return c.json({ ticket, expiresAt });
  });

  // SSE: pushes when the run list changes (live instead of polling). EventSource can't send headers →
  // Gated with ?token= (roleAuth fallback) OR ?ticket= (the single-use ticket above).
  // API-04: poll interval — 2s (was 1s). The cheap-signal path below only pays for a full listRuns()
  // Scan when something has ACTUALLY changed (see readCheapEventsSignal), so this interval mostly gates
  // The cheap probe itself (already O(distinct statuses) via the engine's countRunsByStatus push-down,
  // Or a single indexed page read for the newest run) — 2s keeps the UI feeling live while halving even
  // That probe's frequency, with no user-visible latency cost worth calling out.
  const EVENTS_POLL_MS = 2000;
  /**
   * API-04-followup: the cheap signal (readCheapEventsSignal, below) only tracks per-status totals + the
   * Newest run's tuple, so an OLDER (non-newest) run's step progress can advance without moving it (see
   * The KNOWN GAP note below). Rather than pay for a full listRuns() scan every tick to close that gap,
   * A full listRuns() diff also runs unconditionally once every FULL_SCAN_EVERY_TICKS ticks — bounding
   * The worst-case staleness for a non-newest run's progress to one full-scan period (~10s at the 2s poll
   * Interval) instead of "until its own status changes". Net cost: 1 full scan per ~10s instead of per
   * 1s pre-API-04 (~10x cut) while every change is still surfaced within a bounded delay.
   * Not part of the public API (StudioApiOptions) — overridable only via an internal, untyped option so
   * Tests don't have to wait out the full 10s in real time.
   */
  const FULL_SCAN_EVERY_TICKS: number = (opts as any).__fullScanEveryTicks ?? 5;
  /**
   * API-04: a CHEAP fingerprint of "has anything changed" — deliberately NOT a full listRuns() scan.
   * Combines countRunsByStatus()'s per-status totals (catches a run being added/removed, or any run
   * Transitioning completed↔suspended — O(distinct statuses), see journal.ts's JSDoc) with the newest
   * Run's own summary tuple, read via a single indexed listRunsPaged({limit:1}) tail slice — the SAME
   * Total→ascending-range conversion GET /runs already uses above (catches the common case: the
   * Most-recently-created run's modelSteps/toolCalls advancing while it's still mid-flight).
   * Returns undefined when the underlying reader doesn't support countRunsByStatus (a bare/custom
   * JournalReader, or an org-scoped view — countRunsByStatus is deliberately not bridged per-org, see
   * The `reader` construction above) → callers fall back to the pre-API-04 full-scan behavior.
   * KNOWN GAP (bounded, not lost): an OLDER (non-newest) run advancing its steps while a newer run also
   * Exists won't move this fingerprint until ITS OWN status changes — but the periodic full scan below
   * (FULL_SCAN_EVERY_TICKS) still catches it within at most ~10s, so this is a bounded delay, not a
   * Missed event; the fallback path below has no such gap (or delay) at all.
   */
  async function readCheapEventsSignal(): Promise<string | undefined> {
    if (typeof rw.countRunsByStatus !== 'function') return undefined;
    let counted: Record<string, number> | undefined;
    try { counted = await rw.countRunsByStatus(); } catch { counted = undefined; }
    if (!counted) return undefined;
    const total = Object.values(counted).reduce((a, b) => a + b, 0);
    let newest: [string, string, number, number] | null = null;
    if (total > 0 && typeof reader.listRunsPaged === 'function') {
      try {
        const page = await reader.listRunsPaged({ limit: 1, cursor: String(total - 1) });
        const r = page.items[0];
        if (r) newest = [r.runId, r.status, r.modelSteps, r.toolCalls];
      } catch { newest = null; }
    }
    return JSON.stringify([counted, newest]);
  }
  app.get('/events', async (c) => {
    const ticket = c.req.query('ticket');
    let ticketOrg: string | undefined;
    if (ticket !== undefined) {
      const principal = consumeSseTicket(ticket);
      if (principal === undefined) return c.json({ error: 'invalid or expired ticket' }, 401);
      // If the ticket is org-bound (multi-org), the read is scoped to that org — PARITY with the org
      // Middleware's bound-principal behavior (see the app.use('*') block above).
      ticketOrg = principal?.orgId;
    } else if (!(await allowP(c.req.raw, 'runs:read'))) {
      return deny(c.req.raw, 'read');
    }
    const run = () => sseResponse(c, async (stream) => {
      // API-04: the event body is now INFORMATIVE — `{"runIds":[...],"at":<epoch ms>}` naming exactly
      // Which runs changed, instead of the old signal-only `data:'runs'` — so the client can patch just
      // Those rows (see studio-ui/api.ts's useLiveRuns) instead of refetching every loaded page.
      // BACKWARD COMPAT is handled CLIENT-SIDE (a JSON.parse failure there falls back to full
      // Invalidation) — this endpoint doesn't fork into two implementations for old vs new clients.
      let cheapSig: string | undefined;
      let known = new Map<string, string>(); // runId -> `${status}|${modelSteps}|${toolCalls}`
      let baselined = false;
      let legacyLast = ''; // fallback-path signature, used ONLY when countRunsByStatus is unavailable
      let tick = 0; // counts cheap-path ticks SINCE the baseline (for FULL_SCAN_EVERY_TICKS below)
      while (!stream.aborted) {
        const sig = await readCheapEventsSignal();
        if (sig !== undefined) {
          if (!baselined) {
            // First tick: establish the baseline silently (no event) — a freshly-connected client just
            // Did its own initial fetch, so reporting every existing run as "changed" here would be a
            // Needless (and, at tens of thousands of runs, large) initial payload.
            cheapSig = sig;
            known = new Map((await reader.listRuns()).map((r) => [r.runId, `${r.status}|${r.modelSteps}|${r.toolCalls}`]));
            baselined = true;
          } else {
            tick++;
            // Periodic full scan (FULL_SCAN_EVERY_TICKS): runs a full listRuns() diff even when the cheap
            // Signal DIDN'T change, so a non-newest run's progress (the KNOWN GAP above) is still caught
            // Within a bounded delay instead of only when its status flips.
            const forceFullScan = tick % FULL_SCAN_EVERY_TICKS === 0;
            if (sig !== cheapSig || forceFullScan) {
              cheapSig = sig;
              const runs = await reader.listRuns();
              const nextKnown = new Map<string, string>();
              const changed: string[] = [];
              for (const r of runs) {
                const fp = `${r.status}|${r.modelSteps}|${r.toolCalls}`;
                nextKnown.set(r.runId, fp);
                if (known.get(r.runId) !== fp) changed.push(r.runId);
              }
              // A run disappearing (purge/retention sweep) also counts as "changed" — the client needs
              // Its id to drop the row from cached pages, not just to see growth/edits.
              for (const id of known.keys()) if (!nextKnown.has(id)) changed.push(id);
              known = nextKnown;
              if (changed.length > 0) {
                await stream.writeSSE({ data: JSON.stringify({ runIds: changed, at: Date.now() }), event: 'change' });
              }
            }
          }
        } else {
          // Fallback: no cheap aggregate available → PRESERVE the exact pre-API-04 behavior (full
          // ListRuns() scan every poll, diffed as one whole-list signature, old uninformative payload).
          const runs = await reader.listRuns();
          const fullSig = JSON.stringify(runs.map((r) => [r.runId, r.status, r.modelSteps, r.toolCalls]));
          if (fullSig !== legacyLast) { legacyLast = fullSig; await stream.writeSSE({ data: 'runs', event: 'change' }); }
        }
        await stream.sleep(EVENTS_POLL_MS);
      }
    });
    return ticketOrg ? orgALS.run(ticketOrg, run) : run();
  });

  // "re-run from here" (admin).
  app.post('/runs/:id/fork', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!resume) return c.json({ error: 'fork requires resume' }, 501);
    if (!writable) return c.json({ error: 'fork requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { step?: number; newRunId?: string };
    // The same `${id}:input` visibility check cancel uses (persistInput is written by every
    // run()/stream() call). Without it fork answered 200 `{copiedModel: 0, copiedTool: 0}` for a run
    // the caller cannot see — a no-op reported as success, and a different answer than cancel gives
    // for the identical situation. It is also the second line of defence for the org boundary: `reader`
    // is org-scoped, so another organization's run reads as absent here rather than as an empty fork.
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    const fork = await forkRun(reader as any, id, body.step ?? 0, body.newRunId);
    const r = await resume(fork.newRunId, {});
    await audit(c, 'fork', id, { step: body.step ?? 0, newRunId: fork.newRunId });
    return c.json({ ok: true, ...fork, ...r });
  });

  // Approval → resume (admin).
  app.post('/runs/:id/resume', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!resume) return c.json({ error: 'resume is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { approvals?: Record<string, boolean> };
    const result = await resume(id, body.approvals ?? {}, { orgId: callerOrg(c) });
    // 'approve' if any value in approvals is true, otherwise 'deny' (the detail carries the full decision set)
    const anyApproved = Object.values(body.approvals ?? {}).some((v) => v === true);
    await audit(c, anyApproved ? 'approve' : 'deny', id, { approvals: body.approvals });
    return c.json({ ok: true, ...result });
  });

  /**
   * D3-A durably cancels an agent run — the studio-side counterpart of
   * @gnldev/server's POST /runs/:id/cancel. UNLIKE @gnldev/server, studio keeps no in-process AbortController
   * Registry for streamed generations (there is no equivalent of its `inflight` map here), so this is
   * ONLY the durable-flag path: `cancelAgentRun` writes a cross-worker flag every fresh model step
   * Checks (durable-model.ts) — a run in flight elsewhere stops at its NEXT step boundary, and every
   * Future resume attempt is refused (terminal, like a compensated run; recovery = fork). Visibility:
   * The SAME `${id}:input` presence check @gnldev/server's cancel endpoint uses (persistInput is written by
   * Every run()/stream() call) — a run from another organization is invisible through the org-scoped
   * `rw` (withOrg prefixes every key), so this returns the same 404 (no existence leak) as elsewhere.
   */
  /**
   * Is this run visible to the caller AT ALL?
   *
   * `rw` is org-scoped (withOrg prefixes every key), so another organization's run reads as absent and
   * the answer is the same 404 an unknown id gets — no existence leak. `persistInput` is written by
   * every run()/stream() call, so `${id}:input` is the presence marker.
   *
   * A helper rather than the line repeated per endpoint, because repeating it is exactly how this went
   * wrong: cancel and fork got the check, and /resume, /compensate and /otel-export did not. Measured on
   * the shipped build — an acme-bound admin naming `org:globex:victim` got 404 from cancel and 200 from
   * all three others, resuming a run it cannot see (approving its pending human-approval tool calls),
   * condemning it and running its compensate hooks, and exporting its full trace to an APM. Any new
   * per-run endpoint should call this rather than re-deriving the rule.
   */
  async function runVisible (id: string): Promise<boolean> {
    if (typeof rw.get !== 'function') return true; // read-only journal: presence cannot be established
    return (await rw.get(`${id}:input`).catch(() => undefined)) !== undefined;
  }

  app.post('/runs/:id/cancel', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'cancel requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    await cancelAgentRun(rw as unknown as Journal, id, { reason: 'studio-cancel' });
    await audit(c, 'run.cancel', id, { durable: true });
    return c.json({ ok: true, durable: true });
  });

  // Unwind an abandoned run — every executed side effect whose tool declares a
  // `compensate` hook is undone in reverse order, exactly-once (@gnldev/durable compensateRun). The run
  // Is CONDEMNED first (never resumable again) → write-gated + audited with the report summary.
  // `dryRun: true` previews the work without condemning or executing anything.
  app.post('/runs/:id/compensate', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!compensate) return c.json({ error: 'compensate is not enabled (pass the compensate option — see StudioApiOptions)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    // Also gated on the dryRun path: a preview still discloses another organization's saga plan.
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
    const report = (await compensate(id, { dryRun: !!body.dryRun }, { orgId: callerOrg(c) })) as { entries?: { status: string }[] };
    if (!body.dryRun) {
      const counts: Record<string, number> = {};
      for (const e of report.entries ?? []) counts[e.status] = (counts[e.status] ?? 0) + 1;
      await audit(c, 'run.compensate', id, { counts });
    }
    return c.json({ ok: true, report });
  });

  // GDPR/PII purge: PERMANENTLY delete ALL trace of a run (irreversible) — the one exception to the
  // Journal's append-only philosophy; only for legal deletion. The decision is logged to audit (actor + deleted record count).
  app.delete('/runs/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'run:delete'))) return deny(c.req.raw, 'write');
    // Root-level management: run purge runs ORG-UNSCOPED (rw = raw journal) → a bound identity could
    // Otherwise also delete another org's run. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot purge a run (operator required)'); if (denied) return denied; }
    if (typeof (rw as Partial<Journal>).deletePrefix !== 'function') {
      return c.json({ error: 'purge requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const deleted = await purgeRun(rw as unknown as Journal, id);
    await audit(c, 'run.purge', id, { deleted });
    return c.json({ ok: true, deleted });
  });

  // ── W5: Replay-based regression (durable regression.ts: replayRun + regressionReport) ────
  // Independently re-runs a recorded run's INPUT (runKeys.input) with a new model/system
  // (replayRun — NOT forkRun, it never touches the original run's journal records), then
  // Returns the decision-point diff (regressionReport → diffRuns).
  app.post('/runs/:id/regression', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'regression requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; system?: string; newRunId?: string; memoryOff?: boolean };
    if (!body.model) return c.json({ error: 'model is required (e.g. "openai/gpt-4o")' }, 400);
    let model: unknown;
    try {
      model = await (opts.regressionModel ?? resolveModel)(body.model);
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    try {
      const { newRunId } = await replayRun({
        journal: rw as unknown as Journal & JournalReader,
        runId: id,
        model: model as any,
        ...(body.system != null ? { system: body.system } : {}),
        ...(body.newRunId ? { newRunId: body.newRunId } : {}),
        // Counterfactual memory-off replay (see durable regression.ts stripMemoryContext): re-ask the
        // Turn WITHOUT what memory injected — provable causation instead of "it probably read it".
        ...(body.memoryOff ? { stripMemoryContext: true } : {}),
      });
      const report = await regressionReport(reader, id, newRunId);
      await audit(c, 'run.regression', id, { newRunId, model: body.model, divergentAt: report.diff.divergentAt, ...(body.memoryOff ? { memoryOff: true } : {}) });
      return c.json({ ok: true, ...report });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Diffs two EXISTING runs (without re-running) at the decision-point level — read-only.
  app.get('/runs/:id/regression/:otherId', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const otherId = decodeURIComponent(c.req.param('otherId'));
    return c.json(await regressionReport(reader, id, otherId));
  });

  // Export a run's trace to an external APM (Langfuse/Honeycomb/Datadog/Collector). SECURITY: Studio
  // NEVER holds the target endpoint/API key itself — the host CALLS opts.otelExport with its own
  // Configured target (internally the host runs @gnldev/otel's `exportRunToOtlp` with its own preset); we only TRIGGER it.
  app.post('/runs/:id/otel-export', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!opts.otelExport) return c.json({ error: 'OTEL export is not enabled (the host must provide otelExport)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    const result = await opts.otelExport(id);
    await audit(c, 'run.otel-export', id, result);
    return c.json(result);
  });

  // Retention sweep: PERMANENTLY clean up old runs per the policy (or the request body).
  app.post('/retention/sweep', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    // Root-level management: the sweep scans runs across ALL orgs (org-unscoped) → a bound identity could
    // Otherwise also delete other orgs' data. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot run a retention sweep (operator required)'); if (denied) return denied; }
    if (typeof (rw as Partial<Journal>).deletePrefix !== 'function') {
      return c.json({ error: 'retention requires journal deletePrefix support' }, 501);
    }
    const body = (await c.req.json().catch(() => ({}))) as { olderThanMs?: number; keepSuspended?: boolean; auditOlderThanMs?: number };
    const olderThanMs = body.olderThanMs ?? opts.retention?.olderThanMs;
    if (olderThanMs == null) return c.json({ error: 'olderThanMs is required (body or the retention option)' }, 400);
    const keepSuspended = body.keepSuspended ?? opts.retention?.keepSuspended ?? true;
    const result = await sweepRuns(rw as any, { olderThanMs, keepSuspended });
    // The audit log is swept only when a retention period was chosen for it, and against the ROOT
    // journal because that is where it lives (see the audit endpoint). The record written just below
    // is newer than any cutoff, so a sweep never erases the evidence of itself.
    const auditOlderThanMs = body.auditOlderThanMs ?? opts.retention?.auditOlderThanMs;
    const auditSwept = auditOlderThanMs == null
      ? undefined
      : await sweepLog(rawReader as unknown as Journal, '__audit__', { olderThanMs: auditOlderThanMs });
    await audit(c, 'retention.sweep', 'runs', {
      olderThanMs, keepSuspended,
      scanned: result.scanned, purged: result.purged.length,
      keptSuspended: result.keptSuspended, keptNoTs: result.keptNoTs,
      ...(auditSwept ? { auditOlderThanMs, auditDeleted: auditSwept.deleted, auditScanned: auditSwept.scanned } : {}),
    });
    return c.json({ ok: true, ...result, purged: result.purged.slice(0, 100), ...(auditSwept ? { audit: auditSwept } : {}) });
  });

  // ── Guard/policy editor: rules live in the journal (__policy__), policyGuard reads them live ──────────
  app.get('/policy', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!writable) return c.json({ policy: null });
    return c.json({ policy: (await rw.get!(POLICY_KEY)) ?? null });
  });

  app.put('/policy', async (c) => {
    if (!(await allowP(c.req.raw, 'policy:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'editing the policy requires a writable journal' }, 501);
    // Root-level management: the policy is a SINGLE GLOBAL rule set for ALL orgs (org-unscoped) → a
    // Bound identity could otherwise change everyone's guard. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot update the global policy (operator required)'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => null)) as { rules?: PolicyRule[]; ifVersion?: number } | null;
    if (!Array.isArray(body?.rules)) return c.json({ error: 'a rules array is required' }, 400);
    const ACTIONS = new Set(['allow', 'deny', 'require-approval']);
    for (const r of body.rules) {
      if (!r || typeof r.tool !== 'string' || !r.tool.trim() || !ACTIONS.has(r.action)) {
        return c.json({ error: "every rule must be { tool: string, action: 'allow'|'deny'|'require-approval', reason? }" }, 400);
      }
    }
    const prev = (await rw.get!(POLICY_KEY)) as PolicyDoc | undefined;
    // Optimistic lock (API-08): if the caller tells us which version it edited, refuse a silent
    // Lost update when another admin has since saved. Omitted `ifVersion` → old behavior (backward
    // Compat for existing clients / @gnldev/server, which never sends it).
    if (body.ifVersion != null) {
      const current = prev?.version ?? 0;
      if (body.ifVersion !== current) {
        return c.json({
          error: `policy was modified by another admin (expected v${body.ifVersion}, current v${current})`,
          code: 'version_conflict',
          current: prev ?? null,
        }, 409);
      }
    }
    const doc: PolicyDoc = { version: (prev?.version ?? 0) + 1, rules: body.rules, updatedAt: Date.now() };
    await rw.put!(POLICY_KEY, doc);
    // The FULL rule set is in the audit detail → past versions can be read back from the audit trail.
    await audit(c, 'policy.update', 'policy', { version: doc.version, rules: doc.rules });
    return c.json({ ok: true, version: doc.version });
  });

  // ── Model pricing ────────────────────────────────────────────────────────────
  // The price table a spend ceiling reads. DEFAULT_PRICING is compiled into @gnldev/durable, so it is
  // stale the day it ships and knows nothing about a model released last week — and an unpriced model
  // counts as $0, which means maxCostUsd cannot fire at ANY threshold. Correcting that by publishing a
  // release is the wrong loop for an operator whose ceiling is silently not capping anything today.
  //
  // The journal's `__pricing__` document LAYERS over the shipped table (see PricingDoc.replace): a
  // screen that lets you add tomorrow's model must not un-price gpt-4o as a side effect, because the
  // symptom of that is not an error — it is a ceiling that quietly stopped working.
  app.get('/pricing', async (c) => {
    if (!(await allowP(c.req.raw, 'money:read'))) return deny(c.req.raw, 'read');
    if (!writable) return c.json({ version: 0, overrides: {}, effective: {}, editable: false });
    // The ROOT journal, explicitly — the same choice /audit makes, and for the same reason: PUT
    // /pricing requires an unbound platform operator, so the document only ever exists at the root.
    // Reading it through the org-scoped `rw` meant a bound org admin was shown an empty override list
    // AND lost the operator's corrections from `effective` — the price their runs are actually billed
    // at, reported as the shipped default. Measured: operator sets x/y to 9, bound admin sees neither.
    const rootJ = rawReader as Partial<Journal> & JournalReader;
    const doc = (await rootJ.get!(PRICING_KEY)) as PricingDoc | undefined;
    return c.json({
      version: doc?.version ?? 0,
      overrides: doc?.models ?? {},
      // The SHIPPED table as well, so the editor can show what a row falls back to when its override is
      // removed. Without it the client can only compute `{...effective, ...overrides}`, and effective
      // already CONTAINS the overrides — so deleting one leaves the old price on screen, and the
      // operator checks a number that will not exist after saving.
      defaults: DEFAULT_PRICING,
      replace: doc?.replace ?? false,
      updatedAt: doc?.updatedAt ?? null,
      effective: await effectivePricingTable(rootJ as never),
      // Whether THIS caller can save, not whether the journal is writable. Reporting `true` to a bound
      // admin made the UI offer an editor whose Save answers 403 — the screen promising something the
      // server refuses.
      editable: isPlatformOperator(c),
    });
  });

  app.put('/pricing', async (c) => {
    if (!(await allowP(c.req.raw, 'policy:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'editing pricing requires a writable journal' }, 501);
    // Root-level management, exactly like the policy: pricing is ONE global table for every org, so a
    // bound identity could otherwise change what every other organization is billed at.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot update global pricing (operator required)'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => null)) as
      { models?: Record<string, { inputPer1M?: unknown; outputPer1M?: unknown; cachedInputPer1M?: unknown }>; replace?: boolean; ifVersion?: number } | null;
    if (!body?.models || typeof body.models !== 'object' || Array.isArray(body.models)) {
      return c.json({ error: 'a models object is required' }, 400);
    }
    // `replace: true` with nothing in it prices NOTHING — effectivePricingTable returns `{}`, every
    // model counts as $0, and every spend ceiling stops firing. This file's own comment describes that
    // as the failure it defends against, and the endpoint answered 200 to it. The UI can reach it in two
    // clicks: the row bin removes the last override while `replace` is carried through unchanged.
    if (body.replace && Object.keys(body.models).length === 0) {
      return c.json({
        error: 'refusing to save an empty table with replace: true — no model would have a price, so ' +
          'maxCostUsd and organization spend limits would stop firing entirely. Set replace: false to ' +
          'fall back to the shipped defaults, or send at least one model.',
      }, 400);
    }
    // A bound on size, because this document is read on EVERY model step (enforceStepLimits) and spread
    // into a new object each time. Without one, 20k rows of 200-char keys are accepted and then paid for
    // on every step of every run, forever.
    const MAX_MODELS = 500;
    const MAX_ID = 200;
    if (Object.keys(body.models).length > MAX_MODELS) {
      return c.json({ error: `too many models (${Object.keys(body.models).length} > ${MAX_MODELS})` }, 400);
    }
    for (const id of Object.keys(body.models)) {
      if (!id || id.length > MAX_ID) {
        return c.json({ error: `model id must be 1..${MAX_ID} characters (got ${id.length})` }, 400);
      }
    }
    const clean: Record<string, { inputPer1M: number; outputPer1M: number; cachedInputPer1M?: number }> = {};
    for (const [id, row] of Object.entries(body.models)) {
      // A NaN price is the dangerous input, not a negative one: it stores fine, produces NaN costs, and
      // `NaN > limit` is false — so the ceiling stops capping without anything failing.
      const input = row?.inputPer1M;
      const output = row?.outputPer1M;
      for (const [field, v] of [['inputPer1M', input], ['outputPer1M', output]] as const) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          return c.json({ error: `${id}.${field} must be a finite, non-negative number` }, 400);
        }
      }
      clean[id] = { inputPer1M: input as number, outputPer1M: output as number };
      const cached = row?.cachedInputPer1M;
      if (cached !== undefined) {
        if (typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0) {
          return c.json({ error: `${id}.cachedInputPer1M must be a finite, non-negative number` }, 400);
        }
        clean[id].cachedInputPer1M = cached;
      }
    }
    const prev = (await rw.get!(PRICING_KEY)) as PricingDoc | undefined;
    if (body.ifVersion != null) {
      const current = prev?.version ?? 0;
      if (body.ifVersion !== current) {
        return c.json({
          error: `pricing was modified by another admin (expected v${body.ifVersion}, current v${current})`,
          code: 'version_conflict', current: prev ?? null,
        }, 409);
      }
    }
    const doc: PricingDoc = {
      version: (prev?.version ?? 0) + 1,
      models: clean,
      updatedAt: Date.now(),
      ...(body.replace ? { replace: true } : {}),
    };
    await rw.put!(PRICING_KEY, doc);
    // The VALUES, not just the model names. A price is a spend ceiling: taking gpt-4o to $0.0001
    // effectively turns maxCostUsd off for it, and a record saying only "gpt-4o changed" cannot tell
    // an auditor whether that happened. Before/after per model, so the record answers the question it
    // exists for.
    //
    // Capped, because a `replace` of a large table would otherwise put hundreds of rows in one audit
    // entry — and a log that is expensive to write is a log somebody eventually turns off. The count is
    // reported whole, so a truncated record still says how much it is not showing.
    const prevModels = prev?.models ?? {};
    const changes = [];
    for (const [id, to] of Object.entries(clean)) {
      const from = prevModels[id];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ model: id, from: from ?? null, to });
    }
    if (body.replace) {
      for (const id of Object.keys(prevModels)) {
        if (!(id in clean)) changes.push({ model: id, from: prevModels[id], to: null });
      }
    }
    const AUDIT_CHANGE_CAP = 50;
    await audit(c, 'pricing.update', 'pricing', {
      version: doc.version,
      models: Object.keys(clean),
      replace: !!body.replace,
      changed: changes.length,
      changes: changes.slice(0, AUDIT_CHANGE_CAP),
      ...(changes.length > AUDIT_CHANGE_CAP ? { changesTruncated: true } : {}),
    });
    return c.json({ ok: true, version: doc.version });
  });

  // Live chat (admin).
  app.post('/chat', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!chat) return c.json({ error: 'chat is not enabled' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; runId?: string };
    if (!body.message) return c.json({ error: 'message is required' }, 400);
    try {
      return c.json({ ok: true, ...(await chat(String(body.message), { runId: body.runId }, { orgId: callerOrg(c) })) });
    } catch (e) {
      // This endpoint had no catch at all, so the SAME upstream failure that other endpoints turned
      // Into a 400 became an unhandled 500 here — one fault, two answers, depending only on which
      // Path the caller took. Now it goes through the same taxonomy as the rest.
      return runErrorResponse(c, e) ?? c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });

  /**
   * K1/W1: the SAME mapping as `limitErrorResponse`/`blockedErrorResponse` in @gnldev/server — but Studio is
   * NOT dependent on @gnldev/server (no dependency in package.json, only @gnldev/durable) → it's set up
   * LOCALLY here. The code/HTTP status choices are IDENTICAL to packages/server/src/index.ts: run_limit_
   * Exceeded/tool_loop_detected → 422 + resumable:true; side_effect_retry_blocked/run_busy → 409 +
   * Resumable:true; retry_limit_exceeded → 422, NO resumable (permanently 'failed' in the journal). If
   * Nothing matches → undefined → the caller falls through to the generic 400 path (existing behavior).
   */
  function runErrorResponse(c: Context, e: unknown): Response | undefined {
    if (e instanceof RunLimitExceededError || (e as any)?.name === 'RunLimitExceededError') {
      const err = e as RunLimitExceededError;
      return c.json({ error: err.message, code: 'run_limit_exceeded', detail: err.detail, resumable: true }, 422);
    }
    if (e instanceof ToolLoopDetectedError || (e as any)?.name === 'ToolLoopDetectedError') {
      const err = e as ToolLoopDetectedError;
      return c.json({ error: err.message, code: 'tool_loop_detected', detail: err.detail, resumable: true }, 422);
    }
    // A `runId` re-used for a different conversation. 409 rather than the generic 400: the request is
    // well-formed and collides with something that already exists. NO `resumable`, unlike everything
    // else here — the others clear and the same runId then succeeds, while this one never will for this
    // thread, so `true` would put a client in a loop. Same status, code and body as @gnldev/server's
    // `threadMismatchResponse`, because a caller should not have to learn which host it is talking to;
    // without it this fell through to the generic 400, which drops both the code and the `detail` that
    // names the two threads.
    if (e instanceof RunThreadMismatchError || (e as any)?.name === 'RunThreadMismatchError') {
      const err = e as RunThreadMismatchError;
      return c.json({ error: err.message, code: 'run_thread_mismatch', detail: err.detail }, 409);
    }
    // A provider failure is not one of OURS — it matches nothing above and used to fall through to
    // The generic 400, telling the caller its request was malformed when the request was fine.
    // Measured: a free endpoint answering 429 arrived as `400 "Failed after 3 attempts…"`, which a
    // Client with retry logic reads as "never retry" at the exact moment it should wait.
    const up = upstreamFailure(e);
    if (up) {
      const eu = e as { message?: string } | null | undefined;
      const res = c.json({
        error: eu?.message ?? String(e),
        code: up.code,
        ...(up.upstreamStatus !== undefined ? { upstreamStatus: up.upstreamStatus } : {}),
        ...(up.retryAfter !== undefined ? { retryAfter: up.retryAfter } : {}),
      }, up.status);
      if (up.retryAfter !== undefined) res.headers.set('Retry-After', String(up.retryAfter));
      return res;
    }
    const code = blockedErrorCode(e);
    if (!code) return undefined;
    const err = e as { message?: string; detail?: unknown } | null | undefined;
    const body = { error: err?.message ?? String(e), code, detail: err?.detail };
    return code === 'retry_limit_exceeded' ? c.json(body, 422) : c.json({ ...body, resumable: true }, 409);
  }

  // ── Playground (if gnl is given) ──────────────────────────────────────────────
  /**
   * Org-scoped agent visibility (SHARED helper with server): the caller's org = identity-bound
   * Principal.orgId (else the header-resolved org in ALS; operator/auth-off → undefined → everything visible).
   * A global agent (no orgs) is always visible → backward-compatible.
   */
  const callerOrg = (c: Context): string | undefined => principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
  /**
   * An org-invisible CODE-DEFINED agent → 404 (does NOT LEAK that it exists, same body as unknown-agent).
   * `orgs` is a property only of code-defined AgentConfig; names NOT IN listAgents (managed agent /
   * Unknown) pass through the existing run path UNTOUCHED (managed agents are already org-isolated via
   * The journal prefix, backward compat preserved). So the gate kicks in ONLY when: the name IS in the
   * List AND is invisible to the caller.
   */
  async function agentGate(c: Context, name: string): Promise<Response | undefined> {
    if (!gnl) return undefined; // playground off → caller already gets a 501
    const m = (await gnl.listAgents()).find((a) => a.name === name);
    if (m && !agentVisibleToOrg(m, callerOrg(c))) return c.json({ error: `agent '${name}' not registered` }, 404);
    return undefined;
  }
  // Registered agent list (for the selector). Visible if read is open; running requires write.
  // Org-scoped: an org-bound caller only sees GLOBAL agents + agents whose `orgs` include their org.
  app.get('/agents', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!gnl) return c.json([]);
    const org = callerOrg(c);
    const list = await gnl.listAgents();
    return c.json(list.filter((m) => agentVisibleToOrg(m, org)));
  });

  // ── Agent approval registry (governance) ────────────────────────────────────────────────────
  // @gnldev/server RECORDS each `config.agents` entry (fingerprinted) into the ROOT journal at its own
  // Boot — Studio only EXPOSES those same `__agent_registry__:<name>` records for review/approve/block;
  // It never computes a fingerprint itself (the playground runner is duck-typed via StudioAgentRunner
  // And doesn't carry the real AgentConfig — see its JSDoc above). Platform-level (never per-org, same
  // As /organizations) → gated by requirePlatformAdmin regardless of the org middleware.
  app.get('/agents/registry', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot view the agent registry (operator required)'); if (denied) return denied; }
    if (!writable || typeof rw.listKeys !== 'function') return c.json([]);
    try {
      return c.json(await listAgentRegistry(rawReader as unknown as Journal));
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  app.post('/agents/registry/:name/approve', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot approve an agent (operator required)'); if (denied) return denied; }
    if (!writable) return c.json({ error: 'agent registry requires a writable journal' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await approveAgent(rawReader as unknown as Journal, name, actorOf(c), body.note);
    await audit(c, 'agent.approve', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  app.post('/agents/registry/:name/block', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot block an agent (operator required)'); if (denied) return denied; }
    if (!writable) return c.json({ error: 'agent registry requires a writable journal' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await blockAgent(rawReader as unknown as Journal, name, actorOf(c), body.note);
    await audit(c, 'agent.block', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  // Run an agent (admin). The same runId as an approval → the suspended tool is released for free (resume for free).
  app.post('/agents/:name/run', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    if (!gnl) return c.json({ error: 'playground is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const gated = await agentGate(c, name);
    if (gated) return gated;
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (!body.runId) return c.json({ error: 'runId is required (idempotency key)' }, 400);
    { const denied = requireScopedThread(c, body.threadId); if (denied) return denied; }
    try {
      const mo = await managedOverrides(name, c);
      const r = await gnl.run(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        resourceId: body.resourceId,
        approvals: body.approvals,
        model: body.model ?? mo?.model,
        temperature: body.temperature,
        topP: body.topP,
        system: body.system ?? mo?.system,
        ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
      }, { orgId: callerOrg(c) });
      await audit(c, 'agent.run', name, { runId: body.runId, ...(mo && body.model == null ? { managedVersion: true } : {}) });
      // `finishReason` is here because without it an empty answer is unreadable. A run whose model
      // Returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // Legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // Response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // Had no way to tell the two apart. The framework already knows which happened; it just was
      // Not saying. Additive field, so existing clients are unaffected.
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts ?? [], finishReason: r.finishReason });
    } catch (e: any) {
      return runErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Run an agent with streaming (admin) — the same SSE schema as @gnldev/server.
  app.post('/agents/:name/stream', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    if (!gnl?.stream) return c.json({ error: 'streaming is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const gated = await agentGate(c, name);
    if (gated) return gated;
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (!body.runId) return c.json({ error: 'runId is required (idempotency key)' }, 400);
    { const denied = requireScopedThread(c, body.threadId); if (denied) return denied; }
    let result: any;
    try {
      const mo = await managedOverrides(name, c);
      result = await gnl.stream(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        resourceId: body.resourceId,
        approvals: body.approvals,
        model: body.model ?? mo?.model,
        temperature: body.temperature,
        topP: body.topP,
        system: body.system ?? mo?.system,
        ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
      }, { orgId: callerOrg(c) });
    } catch (e: any) {
      // Same taxonomy as the non-streaming /agents/:name/run handler above: this catch fires
      // BEFORE the SSE body starts (gnl.stream() only sets up the run — pipeAgentStream() below
      // Is what actually streams), so a normal JSON error response is still safe here.
      return runErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
    await audit(c, 'agent.run', name, { runId: body.runId, stream: true });
    return pipeAgentStream(c, body.runId, result);
  });

  // ── Tools (if gnl.listTools is given) ─────────────────────────────────────────
  // Flat tool list (name, description, JSON schema, which agents). For schema-driven form generation.
  app.get('/tools', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    return c.json(gnl?.listTools ? await gnl.listTools() : []);
  });

  // Run a tool for TEST purposes (admin) — NON-DURABLE: no journal/guard. Watch out for side effects.
  app.post('/tools/:name/execute', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!gnl?.runTool) return c.json({ error: 'tool execution is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; durable?: boolean; approve?: { runId: string; toolCallId: string; approved: boolean } };
    const r = await gnl.runTool(name, body.input, { durable: !!body.durable, approve: body.approve }, { orgId: callerOrg(c) });
    await audit(c, 'tool.exec', name, { durable: !!body.durable });
    return c.json(r.error ? { error: r.error, blocked: r.blocked, runId: r.runId } : { ok: true, result: r.result, runId: r.runId });
  });

  // ── Memory / Threads (if memory is given) ─────────────────────────────────────
  app.get('/threads', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory) return c.json([]);
    const resourceId = c.req.query('resourceId') || undefined;
    // See the `listThreads` note on the type above: the one-resource method takes an object, and the
    // unfiltered view is a DIFFERENT method. Conflating them is what made this filter inert.
    if (resourceId) return c.json(await resolvedMemory.listThreads({ resourceId }));
    // `listAllThreads` when the adapter has it; otherwise `listThreads()` with NO argument, which is
    // what an adapter written against the previous `listThreads(resourceId?: string)` shape implements
    // as its unfiltered view. Not a catch-all fallback: AgentMemory HAS `listAllThreads` and takes the
    // first branch, so the legacy call is only ever made to an adapter that meant it. Without this,
    // splitting the method silently emptied the operator's thread list for every host that had
    // implemented the old contract.
    if (resolvedMemory.listAllThreads) return c.json(await resolvedMemory.listAllThreads());
    return c.json(await (resolvedMemory.listThreads as unknown as () => Promise<unknown[]> | unknown[])());
  });
  app.get('/threads/:id/messages', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory) return c.json([]);
    return c.json(await resolvedMemory.getMessages(decodeURIComponent(c.req.param('id'))));
  });
  app.get('/threads/:id/working-memory', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory?.getWorkingMemory) return c.json({ value: null });
    return c.json({ value: (await resolvedMemory.getWorkingMemory(decodeURIComponent(c.req.param('id')))) ?? null });
  });
  app.patch('/threads/:id', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory?.updateThread) return c.json({ error: 'updateThread is not supported' }, 501);
    const patch = (await c.req.json().catch(() => ({}))) as { title?: string; metadata?: Record<string, unknown> };
    try {
      const thread = await resolvedMemory.updateThread(decodeURIComponent(c.req.param('id')), patch);
      await audit(c, 'thread.rename', decodeURIComponent(c.req.param('id')), patch);
      return c.json({ ok: true, thread });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });
  app.delete('/threads/:id', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory?.deleteThread) return c.json({ error: 'deleteThread is not supported' }, 501);
    try {
      await resolvedMemory.deleteThread(decodeURIComponent(c.req.param('id')));
      await audit(c, 'thread.delete', decodeURIComponent(c.req.param('id')));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });
  // Truncates a thread FROM a message index onward (destructive, e.g. for "retry from here"/branching
  // Flows) — deletes the message at afterIndex and everything after it (index base: getMessages, same
  // List the /threads/:id/messages route returns). afterIndex===-1 deletes the whole thread's messages.
  // 501 both when the adapter doesn't implement truncateMessages AND when it does but the underlying
  // Store can't support it (signaled by a `null` return) — same externally-observable outcome either way.
  app.delete('/threads/:id/messages', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedMemory(c); if (denied) return denied; }
    if (!resolvedMemory?.truncateMessages) return c.json({ error: 'truncateMessages is not supported' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { afterIndex?: unknown };
    if (typeof body.afterIndex !== 'number' || !Number.isFinite(body.afterIndex)) {
      return c.json({ error: 'afterIndex (number) is required' }, 400);
    }
    try {
      const id = decodeURIComponent(c.req.param('id'));
      const removed = await resolvedMemory.truncateMessages(id, body.afterIndex);
      if (removed == null) return c.json({ error: 'truncateMessages is not supported' }, 501);
      await audit(c, 'thread.truncate', id, { afterIndex: body.afterIndex, removed });
      return c.json({ ok: true, removed });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });

  // ── Queue / Jobs (if queue is given) ──────────────────────────────────────────
  /**
   * PROJECTED through an allowlist, like the dead-letter list beside it (see `pickFields`).
   *
   * This route used to return `listJobs()` verbatim. The shipped bridge is safe by accident — the real
   * `@gnldev/queue.listJobs` builds a summary with exactly the four `StudioJob` fields and leaves the
   * job's payload and error text in the store — but `StudioQueue` is a HOST duck-type, so "safe" was a
   * property of somebody else's object rather than of this gate. A host that maps its own rows (the
   * obvious way to bridge a queue that is not @gnldev/queue) forwards whatever those rows carry to a
   * `catalog:read`-only caller. The same class of hole the dead-letter route was measured with.
   */
  app.get('/jobs', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!queue) return c.json([]);
    { const denied = requireScopedHost(c, 'queue'); if (denied) return denied; }
    const jobs = await queue.listJobs({ orgId: callerOrg(c) });
    return c.json(jobs.map((j) => pickFields(j, JOB_FIELDS)));
  });

  // Re-queue a failed (dead-letter/qfail) job (if queue.retry is given — the host typically wraps
  // @gnldev/queue's retryJob). Only a TERMINAL-FAIL job can be retried: retrying a job that's still
  // Pending/locked would queue work the worker is ALREADY going to process a second time, causing a
  // DOUBLE-RUN — this protection lives on queue.retry's own side (returns null → 409).
  app.post('/jobs/:id/retry', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!queue?.retry) return c.json({ error: 'job retry is not supported (queue not given or retry not implemented)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    // Same reason: a job id from another organization requeues its dead-letter work.
    { const denied = requireScopedHost(c, 'queue'); if (denied) return denied; }
    const newId = await queue.retry(id, { orgId: callerOrg(c) });
    if (newId == null) {
      return c.json({ error: `job '${id}' not found or not in a retryable state (only failed/dead-letter jobs can be retried)` }, 409);
    }
    await audit(c, 'job.retry', id, { newId });
    return c.json({ ok: true, id: newId });
  });

  // ── Events dead-letter (@gnldev/events quarantine) ────────────────────────────
  //
  // NOT under `/events`. That path is already this API's SSE change stream (see GET /events above),
  // and it is a route, not a prefix — hanging a dead-letter list off it would either shadow the
  // stream or make the two indistinguishable to anyone reading the spec. A quarantined delivery and a
  // live change feed share the word "event" and nothing else, so they get separate paths.
  //
  // The addressing is the other reason this is not a copy of /jobs. A queue hands one job to one
  // worker, so `:id` names it; a topic FANS OUT, so a single event has one quarantine record PER
  // CONSUMER and only the triple `(topic, consumer, id)` names one. That triple travels in the query
  // string / body rather than the path: topic names routinely contain `.`, `:` and `/`
  // (`orders.created`, `billing/invoices`), and a path segment forces every one of those callers
  // through `%2F`, which routers and proxies normalize inconsistently.

  /**
   * ONE dead-letter scan RUNNING at a time, deployment-wide, and one per CALLER pending — the only
   * brake on the most expensive read this API serves.
   *
   * MEASURED, on real SQLite, before any of this existed. A 20 000-event topic with NOTHING
   * quarantined: one 60-byte `GET /dead-events` → 200, 0 rows, 1 470 ms, 20 400 store calls; ten of
   * them fired at once → 15 511 ms of wall time in which the single-threaded event loop served nobody
   * else. Ten cheap GETs, and every other Studio request — runs, traces, the SSE stream — waits.
   *
   * WHY A LIMIT AND NOT A CACHE. The obvious alternative is a short-lived result cache, and it is the
   * wrong tool here: the ONLY way an operator re-runs this scan is the view's Refresh button, which
   * exists precisely to get a fresh answer (`DeadEvents.tsx` invalidates the query to force it). A
   * cache would make the one affordance the page has do nothing.
   *
   * THE FIRST VERSION OF THIS BRAKE WAS A GLOBAL "BUSY → 429", AND IT WAS A DENIAL-OF-SERVICE. Its
   * stated reasoning was "queueing bounds nothing: a thousand requests still buy a thousand scans" —
   * true of an UNFAIR queue and false of this one, and the price of getting that wrong was measured:
   *
   *   one attacker connection, ONE request in flight at a time, a fresh (topic, consumer) each round
   *   → a legitimate operator holding a different token was refused 20 times out of 20.
   *
   * 60-byte GETs and `catalog:read` — any read token on the deployment — bought a total outage of the
   * endpoint, across organizations. A refusal keyed on "is ANYONE scanning" is a refusal the cheapest
   * possible caller controls.
   *
   * SO ADMISSION IS PER CALLER AND EXECUTION IS GLOBAL, which are two different questions:
   *
   *   ADMISSION (this map + `deadScanOutstanding`), and ONLY for a caller this process can actually
   *     TELL APART — see `deadScanCaller`. Such a principal may have a SMALL FIXED NUMBER of scans
   *     pending or running at once; past that it is refused — self-inflicted, so the 429 tells the
   *     caller something true about itself and nothing about anyone else. This is what bounds the work
   *     for an identified caller: a thousand CONCURRENT requests from one token still buy that same
   *     small number of scans.
   *
   *     A cap and not a lock, which is a correction rather than a detail: at one, the allowance was
   *     spent by the caller's own scan, so anyone else behind the SAME credential was refused on
   *     arrival. See `deadScanOutstanding` for the measurement — a shared token made the identified
   *     case strictly worse than the anonymous one it was written to fix.
   *   EXECUTION (`deadScanWaiters`). One scan runs at a time, deployment-wide, and the rest WAIT in
   *     FIFO rather than being refused. The event loop is protected exactly as before — concurrency
   *     is still one — but the caller that arrives while somebody else is scanning gets its answer a
   *     scan later instead of an error. FIFO is what removes the starvation: the attacker cannot
   *     re-arm until its own scan completes, by which time the operator is already at the head.
   *
   * AN UNIDENTIFIABLE CALLER GETS THE QUEUE AND NOTHING ELSE, which is the correction to the first
   * version of this split. That one keyed admission on `[orgId ?? '', id ?? '']`, so with auth off —
   * the shape `gnl init` scaffolds and the shape Studio's own quickstart runs — EVERY request hashed
   * to the same `["",""]` and the per-caller bound became the deployment-wide refusal it replaced.
   * MEASURED, one attacker connection with one request in flight and a fresh triple each round:
   *
   *   auth off, before: operator alone → 200 (precondition); under attack → 200 in 0 of 20 attempts
   *   auth on,  before: same attack    → 200 in 20 of 20 attempts
   *
   * "AUTH OFF" NAMES THE WRONG SET, and reading this line as the whole of the unidentified branch is
   * how the gap below survived a review. `roleAuth` filled `Principal.id` only under basic auth, while
   * `gnl add host` scaffolds a bearer token and `GNL_ADMIN_TOKEN` is one — so auth ON, with a valid
   * token, landed here too, and the budget was off in the deployments the framework generates.
   * Measured in that state with one shared admin token and 65 attacker connections: operator served 0
   * of 20, i.e. the "before" row above, reproduced through the fix. Closed at the source:
   * `@gnldev/auth` now derives a stable `Principal.credentialId` from the presented token, and
   * `deadScanCaller` prefers it. `credentialId` and not `id` because `id` is a MEMORY SUBJECT that
   * `resolveResourceId` prefers over the one a request names — putting a fingerprint there put two
   * explicitly-named end users in one memory bucket (measured in @gnldev/server).
   *
   * What still reaches this branch is a custom `AuthProvider` returning bare `{roles}`. That is a
   * realistic API-key bridge rather than a corner case, so it now WARNS once per process
   * (`warnNoAdmissionBudget`) instead of failing open in silence.
   *
   * The comment above this code called the collapse "the honest answer — there are no tenants there
   * to be fair between". A single deployment has several operators and several tabs whether or not it
   * has an auth provider, so it was neither honest nor an answer. The fix is not to invent an
   * identity out of a header or a socket (a caller that picks its own identity mints a fresh one per
   * request and walks straight back into the starvation) but to charge nothing to a caller that
   * cannot be named: it queues, FIFO, exactly like everyone else. Its work is still bounded, by
   * concurrency one and by `deadScanQueueWaitMs`, and the queue's DEPTH is bounded separately below
   * so that "everyone queues" cannot become "everyone is a waiter object".
   *
   * That also NARROWS a cross-tenant oracle, and an earlier version of this paragraph claimed it
   * closed one. Under the global refusal, org A's probe returned 200 when org B was idle and 429 when
   * org B was scanning — one tenant could time another's operator activity, and the length of the 429
   * window measured the size of its topic log. The ADMISSION 429 is now A's own business. But the
   * SATURATION 429 is still the deployment's, and B's scan is what saturates it: measured with `org`
   * resolved and acme running a 7 s scan, globex — which had started nothing — was refused
   * `429 dead_scan_busy` after 5 003 ms. The channel is weaker, not gone: it now costs the observer a
   * full `deadScanQueueWaitMs` per sample instead of an instant answer, and it reports "someone is
   * scanning" rather than "org B is scanning", since any tenant's scan saturates the same slot.
   *
   * That residual is the same shape as the LATENCY signal below and is not removable for the same
   * reason: at concurrency one, a 1.5-second whole-log read on a single-threaded event loop already
   * slows every other route in the process, so a busy deployment is observable whatever this endpoint
   * answers. Removing it means more than one scan slot, which is the thing the whole design refuses.
   * Documented as residual — which is what the previous wording should have said about the 429 too.
   *
   * Identical requests still COALESCE: two operators (or two tabs) pointed at the same
   * `(org, topic, consumer)` share the one scan and both get the real answer.
   *
   * The UI cannot trip any of this on its own: its Load/Refresh button is `busy` (and therefore
   * disabled) for the duration of the scan, so a single tab has at most one in flight.
   */
  const deadScans = new Map<string, Promise<StudioDeadEvent[]>>();

  /**
   * How long the host's own scan may take before Studio stops waiting for it (ms).
   *
   * WITHOUT IT THE ENDPOINT COULD BE CLOSED PERMANENTLY, and that was measured too: a `listDead` that
   * never settles (a Postgres WorkStore with a hung connection is the realistic shape) left the slot
   * occupied for the life of the process — `+40 ms → 429`, `+240 ms → 429`, and only a restart cleared
   * it. The scan's sync-throw and async-reject paths always released the slot; "never answers" is a
   * third path, and `.finally` on a promise that never settles never runs.
   *
   * 30 s is ~20× the measured 1 470 ms whole-log read of a 20 000-event topic, so it fires for a stuck
   * store rather than for a big one. A deployment with genuinely enormous topics raises it.
   */
  const deadScanTimeoutMs = opts.deadEventScan?.timeoutMs ?? 30_000;
  /**
   * How long a request may WAIT for the single execution slot before it is refused (ms).
   *
   * The bound on the queue is time, not depth: a waiter costs a promise and an open socket, and what
   * actually needs limiting is how long a client is held. Past this, 429 with a `Retry-After` derived
   * from real scan times — an answer the caller can act on, rather than a connection left hanging.
   */
  const deadScanQueueWaitMs = opts.deadEventScan?.queueWaitMs ?? 5_000;
  /**
   * How many requests may be WAITING for the single slot at once.
   *
   * It exists because admission no longer refuses an unidentifiable caller (see above): without a
   * depth bound, "everyone queues" would let one client hold an arbitrary number of waiter objects.
   * The number is derived rather than picked — the queue is already bounded in TIME at
   * `deadScanQueueWaitMs` (5 s) and a scan measured 1 470 ms, so at most ~4 waiters can ever reach the
   * head before the rest time out anyway. 64 is an order of magnitude above that: deep enough that no
   * real operator population is ever refused by it, shallow enough that the list cannot grow without
   * bound. Past it: 429, with the SATURATION message — which is true of the deployment and says
   * nothing about the caller.
   */
  const deadScanQueueDepth = opts.deadEventScan?.queueDepth ?? 64;
  /**
   * How many timed-out host scans may still be OUT THERE before this endpoint stops starting more.
   *
   * `withScanDeadline` stops Studio waiting; it cannot stop the host computing, and `ctx.signal` is
   * cooperative. A host that ignores it keeps its query running after Studio has answered 504 and
   * released the slot — so the concurrency-one guarantee holds only for scans Studio is still
   * WATCHING. MEASURED against a host that ignores the signal, one caller, eight sequential requests
   * at a 20 ms deadline: `504×8`, and eight whole-log reads running at once against a store that was
   * already not answering. The comment that used to sit on the deadline said ignoring the signal
   * "costs one wasted query and nothing else"; that is true of one request and false of a loop.
   *
   * So abandoned scans are COUNTED (up on the timeout, down whenever the host promise finally
   * settles) and a new scan is refused past this many. Two is deliberately small: a store that has
   * failed to answer twice is not a store that wants a third query. A host that never settles at all
   * pins the counter and this endpoint stays refusing — that is the trade, and it is the honest one:
   * the alternative is to keep opening whole-log reads against a wedged store forever. The refusal is
   * 503 and names the condition, so it is distinguishable from both the busy 429 and the 504.
   */
  const deadScanMaxAbandoned = opts.deadEventScan?.maxAbandonedScans ?? 2;

  /**
   * WHO is scanning, for admission — the AUTHENTICATED principal, or nobody.
   *
   * `undefined` means "this process cannot tell this caller apart from any other", and the caller is
   * then charged no admission at all: it goes to the FIFO queue. That is the whole fix for the
   * starvation measured above, and the reason it is stated as a capability rather than a fallback —
   * an admission bucket shared by callers who are not the same caller is not a bound, it is a shared
   * fate.
   *
   * WHAT COUNTS AS TELLING THEM APART is `principal.id`, and nothing else:
   *
   *   • NOT `actorOf` / `x-gnl-actor`, NOT `x-gnl-org`, NOT any other header. A caller that picks its
   *     own identity mints a fresh one per request and the budget stops existing.
   *   • NOT the ORG on its own. `Principal.id` is optional, and an API-key bridge that returns
   *     `{ orgId, permissions }` is a realistic provider — under the old key every caller in that org
   *     collapsed into one bucket and starved each other. MEASURED, two such callers asking for
   *     different triples at once: `200 / 429`. An org is not a caller.
   *   • NOT the org resolved from the REQUEST (`callerOrg`, which falls back to the `x-gnl-org` ALS).
   *     `p.orgId` is identity-bound and cannot be re-picked; the ALS value can. It is included only
   *     as a qualifier ON an identity, so the same id under two organizations is two buckets and a
   *     caller cannot mint a third by changing a header.
   *
   * `callerOrg` DOES key the coalescing map, which is a different question with a different answer:
   * there, using the request's org is mandatory (two organizations must never share one scan's rows),
   * and forgery buys the forger nothing but its own separate scan. Admission is the opposite — the
   * key must be unforgeable, so it comes only from the identity. The two disagreeing silently is what
   * produced a cross-organization 429: with `org` configured and no auth provider, the coalescing key
   * saw acme and globex as different while admission saw both as `["",""]`, so globex was told "your
   * own dead-letter scan is still running" about a scan it had never started (measured: `200 / 429`).
   * Now neither caller is identified, so neither is admission-refused, and the only 429 either can
   * see is the saturation one — which is about the deployment and is true.
   */
  const deadScanCaller = (c: Context): string | undefined => {
    const p = principalOf(c.req.raw);
    // `credentialId` before `id`, and it is why the budget exists at all in the common deployment:
    // `roleAuth` only fills `id` under basic auth, while `gnl add host` scaffolds a bearer token — so
    // keying on `id` alone left every token-authenticated deployment, including `GNL_ADMIN_TOKEN`, in
    // the unidentified branch below. MEASURED there with a single shared admin token and 65 attacker
    // connections: operator served 0/20. The starvation this admission model closes was still fully
    // open in the deployments the framework itself generates.
    //
    // Both are unforgeable (identity-bound, never a header) and either alone is a complete key, so the
    // fallback widens WHO gets a budget without weakening what the key means. `credentialId` is the
    // narrower, more useful subject when both exist: two people sharing one token share its budget,
    // which is the honest accounting — they share the credential.
    const caller = p?.credentialId ?? p?.id;
    if (caller === undefined) warnNoAdmissionBudget();
    return caller ? JSON.stringify([p?.orgId ?? '', caller]) : undefined;
  };
  /**
   * The unidentified branch must not be SILENT. It is the branch that charges no admission at all, so
   * a deployment that lands in it has the fairness bound switched off — and the failure mode of a
   * security control that is off is that everyone believes it is on.
   *
   * This is not hypothetical and the comment above used to imply it was: it read the branch as
   * "auth is off", when the shape that actually reached it was auth ON with a valid bearer token,
   * because the provider produced no per-caller field. That was true of `roleAuth` (fixed: it now
   * fills `Principal.credentialId`) and remains true of any custom `AuthProvider` returning bare
   * `{roles}` — a realistic API-key bridge. Measured in that state, one shared token and 65 attacker
   * connections: the operator was served 0 of 20.
   *
   * Once per process, not per request: a wedged deployment would otherwise print this on every poll.
   */
  let warnedNoAdmission = false;
  const warnNoAdmissionBudget = (): void => {
    if (warnedNoAdmission) return;
    warnedNoAdmission = true;
    console.warn(
      '@gnldev/studio: the dead-letter scan admission budget is DISABLED for this deployment — your ' +
      'auth provider returns a principal with neither `id` nor `credentialId`, so callers cannot be ' +
      'told apart and none can be charged for a scan. One caller can then hold the scan queue and ' +
      'starve everyone else. Return a stable `credentialId` (what `roleAuth` derives from the ' +
      'presented token) or an `id` from your AuthProvider to turn it on.',
    );
  };
  /**
   * principal → how many DISTINCT scans it currently has pending or running.
   *
   * This was a single-owner LOCK (principal → the one key it holds), refusing a caller's second triple
   * outright, and its comment called that "sharing a budget". It is not: it is first-arrival-wins, and
   * under a SHARED credential — the shape this whole mechanism exists to serve, since `gnl add host`
   * scaffolds one bearer token for a team — it inverted the fix. Measured, one shared admin token and a
   * SINGLE sequential attacker connection:
   *
   *   owner lock, shared token                 → operator served  0 of 20
   *   no identity at all (before credentialId) → operator served 20 of 20
   *
   * Naming the caller made it strictly worse than not naming it, and cheaper to exploit than the
   * 65-connection flood the lock was written against. Two colleagues on one token do it to each other
   * by accident.
   *
   * A COUNT with a small cap keeps the property the lock was for and drops the one it accidentally had.
   * The flood it must stop is CONCURRENT — 65 sockets from one source filling the queue — and a cap
   * bounds that however many sockets are opened. A SEQUENTIAL caller (an attacker re-arming after each
   * reply, or an ordinary second operator) holds one, so the next request still enters the FIFO and is
   * served in turn rather than being told a false thing about a scan it never started.
   */
  const deadScanOutstanding = new Map<string, number>();
  /**
   * Two, not one: one is what produced the starvation above — a caller's own in-flight scan consumed
   * the entire allowance, leaving nothing for anyone else behind the same credential. Larger buys an
   * attacker more of the queue for the same single credential. Two is the smallest value at which a
   * second party behind one credential can still queue.
   *
   * PRICE, measured rather than waved at: it doubles what a holder of MANY valid credentials can take.
   * Under the old lock, N credentials bought N waiter slots; under the cap they buy 2N. Measured at the
   * default `queueDepth` of 64: 32 distinct tokens filled the queue and the 33rd was refused `'full'`
   * immediately. That is a real widening and it is the deliberate trade — a compromised pool of tokens
   * is a harder thing to come by than the single shared token every scaffolded deployment ships with,
   * and the starvation on that one was total (0 of 20) rather than a factor of two.
   */
  const DEAD_SCAN_PER_CALLER = 2;
  /** FIFO of requests waiting for the single execution slot. */
  const deadScanWaiters: { identified: boolean; admit (ok: boolean): void }[] = [];
  let deadScanBusy = false;
  /** Host scans Studio stopped waiting for and that have not settled yet. See `deadScanMaxAbandoned`. */
  let deadScanAbandoned = 0;

  /** Hands the slot to the next waiter, or frees it. Called exactly once per acquired slot. */
  const releaseDeadScanSlot = (): void => {
    const next = deadScanWaiters.shift();
    if (next) next.admit(true);
    else deadScanBusy = false;
  };

  /**
   * `'slot'` = the slot is yours. `'timeout'` = you waited `deadScanQueueWaitMs` and did not get it.
   * `'full'` = the queue was already at its budget for you and you were never enqueued.
   *
   * THE QUEUE HAS TWO BUDGETS, because FIFO drop-tail is fair only between callers that cost the same.
   * Admission already limits an IDENTIFIED caller to one scan, so such a caller can hold at most one
   * waiter — the queue cannot be flooded by anyone this process can name. An UNIDENTIFIED caller has
   * no such bound (that is what "unidentified" costs), so with one shared budget a single source
   * opening connections takes every slot: measured with the default `queueDepth` of 64, the operator
   * is served in full up to 8 attacker connections and 0 of 10 at 65 — the exact starvation this design
   * replaced, bought back for the price of 65 concurrent 60-byte GETs. Where between 8 and 65 the cliff
   * falls depends on how long a scan takes relative to the queue budget, so no intermediate number is
   * quoted: it would be a property of the fixture, not of the deployment.
   *
   * So the unnameable pool gets HALF the depth and the rest is reserved for callers that can be
   * charged. An identified operator now reaches the queue while an anonymous flood is in progress,
   * which is the property that was lost. What this does NOT do is make a deployment with no auth
   * provider fair: there, everyone is in the unidentified pool and nothing distinguishes the operator
   * from the flood. That is not solvable here — a caller that picks its own identity mints a fresh one
   * per request, and socket/header identity is either forgeable or shared behind a proxy. The answer
   * for those deployments is an auth provider, which is what `warnNoAdmissionBudget` now says out loud
   * rather than leaving to be discovered under load.
   */
  const acquireDeadScanSlot = (identified: boolean): Promise<'slot' | 'timeout' | 'full'> => {
    if (!deadScanBusy) { deadScanBusy = true; return Promise.resolve('slot'); }
    // `>> 1` and not a ratio option: another knob here is another pair of settings a host can put in
    // contradiction (see the deadline-versus-queue-wait interaction two functions down), and half is
    // the only split that needs no justification of its own.
    // `max(1, …)`: halving must never reach zero, or a host that configured `queueDepth: 1` would
    // have no queue at all for anonymous callers — the split is meant to bound the pool, not to
    // delete it. Caught by the existing `queueDepth: 1` test, which is why it is spelled out here.
    const budget = identified ? deadScanQueueDepth : Math.max(1, deadScanQueueDepth >> 1);
    const used = identified ? deadScanWaiters.length : deadScanWaiters.filter((w) => !w.identified).length;
    if (used >= budget) return Promise.resolve('full');
    return new Promise<'slot' | 'timeout'>((resolve) => {
      let settled = false;
      const waiter = {
        identified,
        admit (ok: boolean) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok ? 'slot' : 'timeout');
        },
      };
      const timer = setTimeout(() => {
        const i = deadScanWaiters.indexOf(waiter);
        if (i >= 0) deadScanWaiters.splice(i, 1);
        waiter.admit(false);
      }, deadScanQueueWaitMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      deadScanWaiters.push(waiter);
    });
  };

  /**
   * What a scan actually costs, as an EWMA PER ORGANIZATION — the number behind `Retry-After`.
   *
   * `Retry-After: 1` was a decoration: measured, the scan it was telling callers to wait out took
   * 1 470 ms, so a compliant client came back on the dot and was refused again. A caller's own
   * completed scans are the only honest estimate available, and they are already being timed.
   *
   * PER ORGANIZATION, because one number for the whole process is a SIZE ORACLE. The value is
   * literally "how long a whole-topic-log read takes here", and a dead-letter log's read time is
   * proportional to its length — so a single global EWMA answers "how much traffic does the other
   * tenant have" to anyone who can provoke a 429. Measured, with `org` configured and acme running a
   * 2 500 ms scan: globex, which had never scanned anything, was refused with `Retry-After: 3`. The
   * bucket is `callerOrg` — the SAME org the coalescing key and the host call use, so the advice a
   * caller gets is about the scans it can actually cause. A forged `x-gnl-org` therefore buys a fresh
   * empty bucket and no information, which is the point.
   *
   * BOUNDED at `EWMA_BUCKETS` and evicted LEAST-RECENTLY-USED: with header-resolved orgs the bucket
   * name comes from the request, so an unbounded map would be a memory leak a caller controls.
   * Eviction costs a caller nothing but the fallback below.
   *
   * A plain `Map` gives insertion order, and `set` on an existing key does NOT move it — so the first
   * version evicted first-SEEN rather than least-recently-used, and a hot old bucket went before a
   * cold new one. Measured: after 256 forged `x-gnl-org` values each completed one scan, acme's own
   * ~2 500 ms measurement was gone and it was answered from the fallback (`Retry-After` 3 → 5) by
   * callers it has no relationship with. Re-inserting on touch is what makes "recently used" mean
   * anything: a bucket touched DURING the noise now outlives the strangers that arrived before it.
   *
   * It does not, and cannot, save an IDLE tenant — with 256 buckets and 256 newcomers the map is
   * simply full, and that eviction happens under any policy. The measurement above conflated the two;
   * what the order actually buys is that being active protects you, which it previously did not. The
   * attack was never cheap either (256 scans must COMPLETE, minutes at concurrency 1) and never leaked
   * memory — only the accuracy of the hint — which is why the fix is three lines and not a redesign.
   *
   * NOT elapsed-adjusted ("your scan started 900 ms ago, come back in 600 ms"): under-shooting buys
   * the client a second 429, which is the failure being fixed. Clamped to [1 s, 60 s] — a whole
   * minute is already past the point where a client should be polling this endpoint at all.
   */
  const deadScanEwmaMs = new Map<string, number>();
  const EWMA_BUCKETS = 256;
  const recordDeadScan = (bucket: string, ms: number): void => {
    const prev = deadScanEwmaMs.get(bucket);
    // delete THEN set: that is the whole of the LRU. A bare `set` leaves an existing key where it
    // first landed in insertion order, which is the position eviction reads.
    deadScanEwmaMs.delete(bucket);
    deadScanEwmaMs.set(bucket, prev === undefined ? ms : Math.round(prev * 0.7 + ms * 0.3));
    while (deadScanEwmaMs.size > EWMA_BUCKETS) {
      const oldest = deadScanEwmaMs.keys().next();
      if (oldest.done) break;
      deadScanEwmaMs.delete(oldest.value);
    }
  };
  /**
   * WITH NO MEASUREMENT FOR THIS BUCKET the answer is the queue budget, not `1`.
   *
   * The very first 429 a deployment serves is the one a client is most likely to obey literally, and
   * it was the one with nothing behind it: `deadScanEwmaMs` started at 0, `Math.max(1, 0)` made it a
   * second, and the code's own comment called that value "a decoration" while still emitting it.
   * `deadScanQueueWaitMs` is a real number about this deployment — a refused caller has just failed
   * to reach the head of the queue within it, so "at least that long" is the weakest true statement
   * available. It is also the floor a host raises by raising the queue budget, rather than a constant.
   */
  const deadScanRetryAfter = (bucket: string): string => {
    const ewma = deadScanEwmaMs.get(bucket);
    // A refusal is a USE of this bucket: the caller being turned away is the one the estimate is for,
    // and it is exactly when losing it hurts. Refreshing here is what keeps a caller that is being
    // refused in a burst from having its own measurement evicted out from under it mid-burst.
    if (ewma !== undefined) { deadScanEwmaMs.delete(bucket); deadScanEwmaMs.set(bucket, ewma); }
    return String(Math.min(60, Math.max(1, Math.ceil((ewma ?? deadScanQueueWaitMs) / 1000))));
  };

  /** Tagged so the route can turn a rejected SHARED scan into the right status for every joiner. */
  const scanError = (code: 'dead_scan_busy' | 'dead_scan_timeout' | 'dead_scan_store_wedged', message: string): Error =>
    Object.assign(new Error(message), { gnlScanCode: code });

  /**
   * Stops WAITING on the host scan after `deadScanTimeoutMs`; it cannot stop the host computing.
   *
   * The AbortController is the cooperative half — a host whose `listDead` honours `ctx.signal` (a
   * Postgres driver's `AbortSignal`, `fetch`) really does stop. A host that ignores it keeps running,
   * and the point stands anyway: this promise settles, so the slot is released and the endpoint
   * reopens. That is the difference between a wedged store costing one request and costing the
   * process.
   *
   * WHAT IT CANNOT DO ON ITS OWN is keep the concurrency-one promise, and that is why the abandoned
   * scan is COUNTED here rather than forgotten. Releasing the slot while the host is still reading
   * means the next request starts a second real query; a caller in a loop turns "one wasted query"
   * into as many as it likes. The counter comes back down the moment the host's promise settles —
   * including with a rejection, which is why both handlers decrement — so a store that is merely slow
   * recovers by itself. See `deadScanMaxAbandoned` for what happens once it is up.
   */
  const withScanDeadline = <T>(work: Promise<T>, ac: AbortController): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ac.abort();
        deadScanAbandoned++;
        const settle = (): void => { deadScanAbandoned--; };
        // Also the only handler that will ever be attached to `work` on this path — without it an
        // abandoned scan that eventually rejects is an unhandled rejection, which crashes some hosts.
        work.then(settle, settle);
        reject(scanError('dead_scan_timeout',
          `the dead-letter scan did not finish within ${deadScanTimeoutMs} ms and was abandoned — the `
          + 'event store is not answering. The scan slot has been released; nothing was changed.'));
      }, deadScanTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      work.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });

  /**
   * Copy ONLY these fields of a host record onto the wire — an allowlist, not a denylist.
   *
   * `rows.map(({ payload, error, ...rest }) => …)` named the two fields it knew about and forwarded
   * everything else. `StudioEvents` is a HOST duck-type: whatever object the host's `listDead`
   * returns is what gets spread. Measured — a host record carrying
   * `lastErrorDetail: "ssn '123-45-6789'"` reached a `catalog:read`-only caller verbatim, on the same
   * row as `errorRestricted: true`. An unknown field is not a known-safe field, and only the server
   * can decide which is which.
   */
  const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  /**
   * The allowlist names a field AND the shape its declared type gives it, because naming alone is not
   * a boundary. Measured against the name-only version: the fix above moved `dbDsn` out of a host's
   * topic row, and putting the SAME data one level in walked straight back through —
   * `consumers: [{name: 'billing', dbDsn: 'postgres://u:pw@h/db', lastFailure: "ssn '123-45-6789'"}]`
   * was served whole to a `catalog:read`-only caller, as was
   * `attempts: {n: 8, workerHost: 'worker-3.internal', dsn: '…'}` on a dead-letter row. The row's own
   * `toJSON` is already skipped, but the FIELD VALUE's was still honoured, so a getter or a `toJSON`
   * on an allowlisted key was a second way in.
   *
   * Every shape here comes from the declared wire type, not from taste: `StudioDeadEvent` and
   * `StudioJob` are scalars end to end, and `StudioEventTopic.consumers` is `string[]` — "an inventory
   * of names". A value that does not match is DROPPED, not coerced and not stringified: the host
   * contradicted the type it declares, and there is no reading of `{n, dsn}` as an attempt count that
   * is safe to guess at. Dropping matches what an unrecognised field NAME already gets.
   *
   * IT IS A STRUCTURAL BOUNDARY, NOT A CONTENT ONE, and the difference is worth stating because the
   * fix reads like more than it is. Measured after it: `consumers: ["billing ssn 123-45-6789"]` and
   * `topic: "orders 123-45-6789"` still reach the wire, because a `string[]` of names is exactly what
   * the type asks for and studio cannot know what a consumer is called here. What the allowlist stops
   * is a host attaching data it never declared — a whole object, a getter, a `toJSON` — which is the
   * shape every measured leak on these routes actually had. A host that writes a secret into a field
   * whose declared purpose is a name is outside its reach, and that is the reason the two fields known
   * to carry host data (`error`, `payload`) are gated on a PERMISSION instead of on a shape.
   *
   * `status` is deliberately checked as a scalar and not against its three declared values: refusing
   * an unrecognised status would blank the one field that says whether a record is stuck, on exactly
   * the deployment whose host is behaving unexpectedly. Widening the type is the host's mistake to
   * see, not ours to hide.
   */
  const pickFields = <T extends object>(row: T, fields: readonly (readonly [string, 'scalar' | 'strings'])[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [f, shape] of fields) {
      const v = (row as Record<string, unknown>)?.[f];
      if (v === undefined) continue;
      if (shape === 'scalar') { if (isScalar(v)) out[f] = v; continue; }
      if (Array.isArray(v) && v.every((e) => typeof e === 'string')) out[f] = [...v];
    }
    return out;
  };
  /** The operational half of a quarantine record: how much is stuck, is it growing, has releasing helped. */
  const DEAD_EVENT_FIELDS = [
    ['id', 'scalar'], ['topic', 'scalar'], ['consumer', 'scalar'], ['status', 'scalar'],
    ['attempts', 'scalar'], ['at', 'scalar'], ['releasedAt', 'scalar'], ['releases', 'scalar'],
  ] as const;
  /** Exactly `StudioJob` — the four fields the real `@gnldev/queue.listJobs` returns. */
  const JOB_FIELDS = [['id', 'scalar'], ['type', 'scalar'], ['status', 'scalar'], ['attempts', 'scalar']] as const;
  /** Exactly `StudioEventTopic` — the inventory, and nothing the host hung off the same object. */
  const TOPIC_FIELDS = [['topic', 'scalar'], ['consumers', 'strings']] as const;

  /**
   * The `(topic, consumer)` inventory the dead-letter list has to be pointed at. Optional on the host
   * side; an empty list means the view asks for a topic and consumer as free text instead.
   *
   * PROJECTED through an allowlist, like `/dead-events` and `/jobs`. It was the one route in this
   * group still returning the host object verbatim, and the hole is identical rather than analogous:
   * `StudioEventTopic` is a duck-type, so a host that builds the inventory from its own quarantine
   * rows attaches whatever those rows carry. Measured, a host returning
   * `{topic, consumers, sampleFailure: "ssn '123-45-6789'", dbDsn: 'postgres://u:pw@h/db'}` — a
   * `catalog:read`-only caller received all four fields. Nothing about "an inventory of names" makes
   * it safe; what makes it safe is that the server, not the host, decides which names leave.
   */
  app.get('/dead-events/topics', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!events?.topics) return c.json([]);
    { const denied = requireScopedHost(c, 'events'); if (denied) return denied; }
    const inventory = await events.topics({ orgId: callerOrg(c) });
    // Reading an allowlisted key can THROW: `topic` may be a getter, and this is somebody else's
    // object. Measured, one that threw answered 500 `Internal Server Error` with a stack pointing into
    // `pickFields`. The dead-letter list two routes down already defends the same duck-type against
    // `[null, 42]` for the same reason; the argument there — "a host duck-type either is defended
    // against or is not" — does not stop at this route. A row that cannot be read is skipped rather
    // than failing the whole inventory: the other topics are still true, and an operator looking at a
    // wedged store needs the part that answers.
    const projected: Record<string, unknown>[] = [];
    for (const t of inventory) {
      try { projected.push(pickFields(t, TOPIC_FIELDS)); } catch { /* unreadable row: not an inventory entry */ }
    }
    return c.json(projected);
  });

  /**
   * Quarantined deliveries for one topic+consumer (the host typically wraps @gnldev/events'
   * `listDeadEvents`). Both parameters are REQUIRED and validated before anything else is consulted:
   * a request that names no consumer is malformed whether or not this deployment has an event bus,
   * and answering it with an empty list would read as "nothing is quarantined".
   *
   * EXPENSIVE — `listDeadEvents` scans the entire topic log and does a `get` per event. Nothing here
   * polls it, the UI refreshes it only on an explicit operator action, and `deadScans` above caps the
   * damage a caller that ignores both can do.
   *
   * THE PAYLOAD IS NOT PART OF THE DEFAULT ANSWER, and that is a correctness fix rather than a
   * preference. This route requires `catalog:read`, the CONFIGURATION permission;
   * `StudioDeadEvent.payload` is whatever the producer emitted, which is customer data by definition.
   * Measured with a grant of exactly `['runs:read','catalog:read']`: `GET /threads` → 403
   * `missing threads:read`, while `GET /dead-events` → 200 with `{"customerEmail":…,"ssn":…}` in
   * every row. Two things now have to be true before a body leaves this process — the caller ASKED
   * (`?payload=1`) and the caller MAY (`payloads:read`) — and a caller that asked without the
   * permission is told so per record (`payloadRestricted: true`) rather than losing the list, because
   * reading the quarantine is legitimately part of `catalog:read` and only the bodies are not.
   *
   * `error` IS GATED TOO, and it took a second measurement to see why. It was left behind on purpose
   * when the payload gate went in — "the only evidence column, and Studio cannot clean someone else's
   * string" — which is true and was not enough. Re-measured end to end against a real quarantine
   * (@gnldev/events `String(err?.message ?? err)`, a handler that quoted the value it rejected the way
   * every validation library does), the answer to `['runs:read','catalog:read']` was:
   *
   *   [{"error":"ValidationError: ssn '123-45-6789' invalid for customer jane@customer.example",
   *     "attempts":2,…,"payloadRestricted":true}]
   *
   * One row, contradicting itself. The SSN the gate exists to withhold travelled in the field beside
   * the flag announcing it had been withheld — and in the DEFAULT answer, so unlike `payload` it did
   * not even need asking for. So `error` moves behind `payloads:read` as well.
   *
   * NO `?payload=1`-STYLE OPT-IN FOR IT, deliberately. The opt-in guards `payload` because a body is
   * bulk data a client can receive by accident; `error` is one short field the table renders in every
   * row, and an opt-in would blank that column for every caller including the ones entitled to it.
   * The permission is the whole gate here.
   *
   * REJECTED: truncating `error` to N characters instead of gating it. It does not work, and the
   * reason is measurable rather than aesthetic — PII arrives at the FRONT of a validation message.
   * `ValidationError: ssn '123-45-6789'` is 34 characters; `ECONNREFUSED 10.0.0.5:5432` is 26 and
   * `502 Bad Gateway from https://api.stripe.com/v1/charges` is 53. Every threshold that keeps the
   * short infrastructure errors readable also keeps the whole SSN, and every threshold that cuts the
   * SSN cuts them too. There is no N that separates the two, so the number would only be there to
   * look like a control.
   *
   * WHAT A CALLER WITHOUT THE PERMISSION STILL GETS, because "the list survives" has to mean
   * something: id, topic, consumer, status, attempts, releases and both timestamps — enough to answer
   * "how much is stuck, is it growing, has releasing it helped", which is the question an operator
   * who may not read customer data is entitled to an answer to. It does not answer "why", and that is
   * the point of the split rather than a shortfall of it: the why is in the payload and in the text
   * the handler wrote about the payload. @gnldev/events also logs the full error to the host's own
   * console at quarantine time, so the answer exists for whoever may read the logs.
   */
  app.get('/dead-events', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    const topic = c.req.query('topic');
    const consumer = c.req.query('consumer');
    if (!topic || !consumer) {
      return c.json({
        error: 'both `topic` and `consumer` are required — a topic fans out, so an event carries one '
          + 'dead-letter record per consumer and only the pair names a single list',
      }, 400);
    }
    if (!events) return c.json([]);
    { const denied = requireScopedHost(c, 'events'); if (denied) return denied; }
    const orgId = callerOrg(c);
    // Keyed on the ORGANIZATION as well as the pair: coalescing two callers onto one scan must never
    // hand one organization the answer computed for another.
    // Encoded as an array, NOT joined on a delimiter. Any single delimiter character can be forged
    // by the caller: this used to join on a NUL, and a `%00` in the query string decodes to exactly
    // that — so `topic=a%00b&consumer=c` and `topic=a&consumer=b%00c` built the SAME key, coalesced
    // onto one scan, and the second caller was handed the first one's rows with a 200 (measured).
    // JSON encoding is unambiguous because the encoder escapes whatever the parts contain. It is
    // also the reason the delimiter is gone from the source: written literally, a NUL is invisible
    // in a diff and in review. Same class of bug @gnldev/events escapes its own key parts for.
    const key = JSON.stringify([orgId ?? '', topic, consumer]);
    // The SAME org, for the same reason, everywhere a number about this caller's scans is produced:
    // the coalescing key above, the host call below, and the `Retry-After` bucket.
    const bucket = orgId ?? '';
    let scan = deadScans.get(key);
    if (!scan) {
      // The store has stopped answering and there are already `deadScanMaxAbandoned` reads out there
      // that nobody is waiting for. Starting another is not a retry, it is a second victim.
      if (deadScanAbandoned >= deadScanMaxAbandoned) {
        return c.json({
          error: `the event store is not answering — ${deadScanAbandoned} dead-letter scans have already `
            + 'passed their deadline and are still outstanding, so no new whole-topic-log read is being '
            + 'started. Nothing was changed.',
          code: 'dead_scan_store_wedged',
        }, 503, { 'Retry-After': deadScanRetryAfter(bucket) });
      }
      // EVERYTHING from here to `deadScans.set` is synchronous, and that is load-bearing rather than
      // stylistic: the admission record and the shared promise have to be published in the same tick
      // the decision is taken. An `await` in between (waiting for the slot BEFORE registering) meant
      // that a second identical request, arriving on the next microtask, saw an owner but no promise
      // to join — and the caller was refused for a scan that was about to be its own.
      //
      // `who === undefined` = a caller this process cannot name (see `deadScanCaller`). It is charged
      // no admission at all and goes straight to the FIFO queue; the only refusal it can see is the
      // saturation one, which is a true statement about the deployment rather than a false one about
      // a scan it never started.
      const who = deadScanCaller(c);
      if (who !== undefined) {
        if ((deadScanOutstanding.get(who) ?? 0) >= DEAD_SCAN_PER_CALLER) {
          return c.json({
            error: `you already have ${DEAD_SCAN_PER_CALLER} dead-letter scans in flight — this endpoint `
              + 'reads a whole topic log, so a caller may hold only a few at once. Wait for one, or retry '
              + 'after `Retry-After`.',
            code: 'dead_scan_busy',
          }, 429, { 'Retry-After': deadScanRetryAfter(bucket) });
        }
        deadScanOutstanding.set(who, (deadScanOutstanding.get(who) ?? 0) + 1);
      }
      const ac = new AbortController();
      scan = (async () => {
        const slot = await acquireDeadScanSlot(who !== undefined);
        if (slot !== 'slot') {
          throw scanError('dead_scan_busy', slot === 'full'
            ? 'the dead-letter scanner is saturated — this deployment runs one whole-topic-log read at a '
              + `time and ${deadScanQueueDepth} requests are already waiting for it. Retry after `
              + '`Retry-After`.'
            : 'the dead-letter scanner is saturated — this deployment runs one whole-topic-log read at a '
              + 'time and the queue did not clear in time. Retry after `Retry-After`.');
        }
        const startedAt = Date.now();
        try {
          // The SAME brake, re-read now that the slot is actually held. Checking it only at the door
          // (above, before this closure) let the queue walk straight past it: a request admitted when
          // the counter was 0 can sit in the FIFO while the scans ahead of it time out, and it then
          // starts a fresh whole-log read against a store already known to be wedged. Measured with
          // `timeoutMs 300 < queueWaitMs 5000` and 20 concurrent requests: 17 unwatched full-log reads
          // went out and the counter reported 9 outstanding, against `maxAbandonedScans: 2`.
          //
          // Unreachable on the defaults (30 s deadline > 5 s queue wait, so nothing waits long enough
          // to overtake the brake) — which is exactly why it was worth writing down: the two options
          // are documented independently and neither says the brake stops working when one is set
          // above the other. Inside the `try`, so the `finally` below returns the slot.
          if (deadScanAbandoned >= deadScanMaxAbandoned) {
            throw scanError('dead_scan_store_wedged',
              `the event store is not answering — ${deadScanAbandoned} dead-letter scans passed their `
              + 'deadline while this request waited for the scan slot, so it was not started. Nothing '
              + 'was changed.');
          }
          const out = await withScanDeadline(
            (async () => events.listDead(topic, consumer, { orgId, signal: ac.signal }))(),
            ac,
          );
          // ONLY a scan that actually finished is evidence of what a scan costs. In `finally` this
          // also ran on the timeout path, where the elapsed time is `deadScanTimeoutMs` by
          // construction — the deadline, not a measurement. Measured: one 4 s timeout, then a real
          // 10 ms scan, and the next refused caller was told `Retry-After: 5`. A host failure is
          // excluded for the mirror-image reason: a store that throws in 1 ms would drag the estimate
          // down and buy a compliant client a 429 it was told to expect not to get.
          recordDeadScan(bucket, Date.now() - startedAt);
          return out;
        } finally {
          releaseDeadScanSlot();
        }
      })().finally(() => {
        deadScans.delete(key);
        if (who !== undefined) {
          const n = (deadScanOutstanding.get(who) ?? 1) - 1;
          if (n > 0) deadScanOutstanding.set(who, n); else deadScanOutstanding.delete(who);
        }
      });
      deadScans.set(key, scan);
    }
    let rows: StudioDeadEvent[];
    try {
      rows = await scan;
    } catch (e) {
      // A SHARED scan's failure has to reach every joiner as the same answer, so the status is
      // reconstructed from the error rather than decided where it was thrown.
      const code = (e as { gnlScanCode?: string })?.gnlScanCode;
      if (code === 'dead_scan_busy') {
        return c.json({ error: (e as Error).message, code }, 429, { 'Retry-After': deadScanRetryAfter(bucket) });
      }
      // 504 and not 500: nothing here is broken, the store upstream did not answer. Same distinction
      // the provider-error mapping makes elsewhere in this file.
      if (code === 'dead_scan_timeout') return c.json({ error: (e as Error).message, code }, 504);
      // The post-slot re-read of the abandoned-scan brake. Same status and code as the door check, so
      // a client cannot tell — and should not have to — which of the two refused it.
      if (code === 'dead_scan_store_wedged') {
        return c.json({ error: (e as Error).message, code }, 503, { 'Retry-After': deadScanRetryAfter(bucket) });
      }
      throw e; // a real host failure — unchanged, the framework's 500
    }
    // AFTER the await, deliberately: the scan above may be SHARED with another request, so the
    // decision about what leaves this process has to be taken per request. Two callers coalesced onto
    // one scan get different answers here if they carry different grants.
    //
    // The permission is now checked UNCONDITIONALLY, where it used to be checked only for a caller
    // that asked for bodies. That ordering existed so nobody was measured against a permission they
    // did not need — and `error` is exactly the case that made the premise false: it ships in the
    // default answer, so every caller needs measuring against `payloads:read` whether or not they
    // asked for a body.
    const mayReadData = await allowP(c.req.raw, 'payloads:read');
    const asked = c.req.query('payload') === '1';
    return c.json(rows.map((row) => {
      // ALLOWLIST (`DEAD_EVENT_FIELDS`), not the `{ payload, error, ...rest }` this replaces. The rest
      // spread forwarded every field the host happened to put on the record, and a host record is not
      // this server's schema — see `pickFields`.
      const out = pickFields(row, DEAD_EVENT_FIELDS);
      // `errorRestricted` is set only when there was an error to withhold — it is a statement about
      // THE RECORD ("this one has failure text you may not read"), so claiming it for a record with
      // no error would be inventing one. `payloadRestricted` below is unconditional on purpose: it
      // answers a different question, about the REQUEST ("you asked for bodies; you may not have
      // them"), which is true whatever the individual record turned out to hold.
      //
      // `row?.` for the same reason `pickFields` has it, and it was inconsistent without it: the
      // allowlist above tolerated a host record that is `null` or a scalar, and the two lines below
      // then threw on it — measured, a `listDead` returning `[null, 42]` answered 500. It is not a
      // denial of service (the slot is released either way), which is exactly why it was worth
      // fixing rather than arguing about: a host duck-type either is defended against or is not.
      if (row?.error !== undefined) {
        if (mayReadData) out.error = row.error;
        else out.errorRestricted = true;
      }
      if (asked) {
        if (mayReadData) { if (row?.payload !== undefined) out.payload = row.payload; }
        else out.payloadRestricted = true;
      }
      return out;
    }));
  });

  /**
   * Release a quarantined event back for delivery to ONE consumer (the host typically wraps
   * @gnldev/events' `retryDeadEvent`).
   *
   * `false` → 409, the same shape as `queue.retry`'s `null`: there was nothing to release because the
   * event was never quarantined, or it has since been delivered. What differs from the queue is the
   * AFTERMATH — retry opens a new job and leaves two rows, a release stamps the existing record and
   * leaves one. The audit target is the event id with the topic+consumer in `detail`, because the id
   * on its own does not identify the record that changed.
   */
  app.post('/dead-events/release', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!events?.release) {
      return c.json({ error: 'dead-event release is not supported (events not given or release not implemented)' }, 501);
    }
    const body = (await c.req.json().catch(() => ({}))) as { topic?: unknown; consumer?: unknown; id?: unknown };
    const { topic, consumer, id } = body;
    if (typeof topic !== 'string' || !topic || typeof consumer !== 'string' || !consumer || typeof id !== 'string' || !id) {
      return c.json({ error: 'topic, consumer and id (non-empty strings) are all required — a dead-letter record is addressed by the triple, not by the event id' }, 400);
    }
    // Same reason as the queue's: releasing another organization's quarantined event re-runs that
    // organization's handler.
    { const denied = requireScopedHost(c, 'events'); if (denied) return denied; }
    if (!(await events.release(topic, consumer, id, { orgId: callerOrg(c) }))) {
      return c.json({
        error: `event '${id}' is not releasable for consumer '${consumer}' on topic '${topic}' — it was never `
          + 'quarantined, or it has since been delivered',
      }, 409);
    }
    await audit(c, 'event.release', id, { topic, consumer });
    return c.json({ ok: true });
  });

  // ── Cache (if cache is given): hit/miss ratio + manual invalidate (@gnldev/cache stats()/invalidate() duck-type) ──
  app.get('/cache/stats', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!cache) return c.json({ hits: 0, misses: 0, hitRate: 0, size: 0 });
    { const denied = requireScopedHost(c, 'cache'); if (denied) return denied; }
    return c.json(await cache.stats({ orgId: callerOrg(c) }));
  });

  // Manual invalidate: if body.key is given, only that key; if not (best-effort — CacheStore doesn't
  // Offer key enumeration), all keys the host knows about are removed (see StudioCache.invalidate).
  app.post('/cache/invalidate', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!cache?.invalidate) return c.json({ error: 'cache invalidate is not supported (cache not given or invalidate not implemented)' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
    // The org travels with it. With no key AND no organization the host wipes everything it knows —
    // measured from an acme-bound admin: `{ok:true,deleted:{removed:9}}`, every organization's cache
    // gone in one call. Studio cannot scope a host's cache itself; it can stop hiding whose request it
    // was, which is what lets the host scope it.
    { const denied = requireScopedHost(c, 'cache'); if (denied) return denied; }
    const deleted = await cache.invalidate(body.key, { orgId: callerOrg(c) });
    await audit(c, 'cache.invalidate', body.key !== undefined ? String(body.key) : '*', { deleted });
    return c.json({ ok: true, deleted });
  });

  // ── Scheduler (@gnldev/scheduler trigger introspection): the journal is READ-ONLY, it needs NO separate
  // Running scheduler instance (see @gnldev/scheduler's `listTriggers` — reads the SAME sched:def:/
  // Sched:state:/sched:fail: keys as pollScheduler, never MUTATES any state). Returns an empty list if
  // The journal isn't writable + doesn't support listKeys (or the host doesn't use @gnldev/scheduler at all) (same pattern as queue/jobs).
  /*
   * TWO OF ITS FIELDS ARE NOT CONFIGURATION, and they are the same two the dead-letter route gates.
   * `TriggerInfo.input` is the scheduled workflow's own argument, verbatim — the exact analogue of
   * `StudioDeadEvent.payload`, and per-customer whenever a trigger is. `TriggerInfo.lastError` is
   * `String(err?.message ?? err)` from the host's own workflow (@gnldev/scheduler writes it to
   * `sched:fail:<id>`), which ran ON that input, so it can quote it the same way a handler's does.
   *
   * This route used to return `listTriggers()` VERBATIM under `catalog:read` alone. Gating the event
   * body while a scheduled body walked out of the next endpoint would be a patch, not a rule — the
   * rule is that `catalog:read` is the configuration permission and `payloads:read` is the one for
   * what flows through it.
   *
   * `input` gets no `…Restricted` marker and `lastError` does: nothing in the UI has ever rendered
   * `input` (it was pure over-exposure, so its absence cannot be misread), while `lastError` IS
   * rendered under a failed trigger, where a missing one would read as "failed for no stated reason".
   */
  app.get('/scheduler/triggers', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function' || typeof rw.get !== 'function') return c.json([]);
    const triggers = await listTriggers(rw as unknown as Journal);
    if (await allowP(c.req.raw, 'payloads:read')) return c.json(triggers);
    return c.json(triggers.map(({ input: _input, lastError, ...rest }) => ({
      ...rest,
      ...(lastError !== undefined ? { lastErrorRestricted: true as const } : {}),
    })));
  });

  // ── Knowledge / vector search (if vectors is given) ────────────────────────────
  app.post('/knowledge/search', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    // AND `payloads:read`, because the response IS customer data. `catalog:read` is the CONFIGURATION
    // permission — agents, tools, workflows, policy — and it is what an admin reads before granting.
    // This route returns indexed corpus text verbatim: measured, an acme-bound identity got back
    // `[{"text":"globex private doc"}]`. Every other route in this file that reaches through the
    // configuration to the data behind it (a dead-letter body, a scheduled trigger's input) is gated
    // the same way; this one was the exception that made `catalog:read`'s own description false.
    //
    // ROUTE-LEVEL, not a field projection like its siblings: there is no `textRestricted: true` worth
    // returning, because a search result without its text is not a narrower answer, it is no answer.
    //
    // BACKWARD COMPATIBLE by construction, same as when `payloads:read` was introduced: `*:read`
    // matches it through the wildcard every named read uses, and every role preset starts from
    // `*:read`. Only an admin who deliberately narrowed someone to a named subset has to add it.
    if (!(await allowP(c.req.raw, 'payloads:read'))) return deny(c.req.raw, 'read');
    if (!vectors) return c.json([]);
    { const denied = requireScopedHost(c, 'vectors'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; topK?: number };
    if (!body.query?.trim()) return c.json([]);
    // The host owns the index, so only the host can filter it — but it needs to know who asked.
    return c.json(await vectors.search(body.query, body.topK, { orgId: callerOrg(c) }));
  });

  // ── Workflows (if gnl.listWorkflows or the workflows option is given) ──────────
  app.get('/workflows', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    const rawCode = gnl?.listWorkflows ? await gnl.listWorkflows() : (workflows ? await workflows.listWorkflows() : []);
    const code: WorkflowMeta[] = rawCode.map((w) => ({ ...w, source: 'code' as const, ...(workflowInputs?.[w.name] ? { input: workflowInputs[w.name] } : {}) }));
    // The managed half only. Code workflows come from the process, not from an organization's data, so they
    // stay listed — refusing the whole route would take the code list away over an unrelated option.
    // Measured before this: an acme-bound admin's `GET /workflows` returned globex's definition
    // including its prompt template.
    const wfList = wfStoreFor(c);
    const managed: WorkflowMeta[] = wfList
      ? (await wfList.list()).map((d) => ({ name: d.name, description: d.description, steps: d.steps.map((s) => ({ id: s.id, kind: 'agent' })), source: 'managed' as const }))
      : [];
    const codeNames = new Set(code.map((w) => w.name));
    return c.json([...code, ...managed.filter((m) => !codeNames.has(m.name))]);
  });

  // Run a workflow durably (admin) — give input, get step results back.
  app.post('/workflows/:name/run', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; runId?: string; maxSteps?: number; dryRun?: boolean; resume?: Record<string, unknown> };
    // Try code-defined first.
    if (gnl?.runWorkflow) {
      const codeNames = gnl.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
      if (codeNames.includes(name)) {
        if (body.dryRun) return c.json({ error: 'dry-run is only supported for managed workflows — code workflows require the real engine' }, 501);
        try {
          // P0.4: forward resume alongside runId/maxSteps (typed HITL payload — see StudioAgentRunner.runWorkflow).
          const wfOpts = {
            ...(body.runId ? { runId: body.runId } : {}),
            ...(body.maxSteps != null ? { maxSteps: body.maxSteps } : {}),
            ...(body.resume ? { resume: body.resume } : {}),
          };
          return c.json({ ok: true, ...(await gnl.runWorkflow(name, body.input, Object.keys(wfOpts).length ? wfOpts : undefined, { orgId: callerOrg(c) })) });
        } catch (e: any) {
          return c.json({ error: String(e?.message ?? e) }, 400);
        }
      }
    }
    // Managed workflow — compile it and run with the REAL engine (same journaling/suspend as code workflows).
    const wf = wfStoreFor(c);
    if (canRunManaged && wf && (await wf.get(name))) {
      try {
        const runId = body.runId ?? `${body.dryRun ? 'dry-' : ''}wf-${name}-${Date.now()}`;
        return c.json({ ok: true, ...(await runManaged(wf!, name, body.input, runId, body.maxSteps, body.dryRun, (n) => managedOverrides(n, c), body.resume)) });
      } catch (e: any) {
        return c.json({ error: String(e?.message ?? e) }, 400);
      }
    }
    if (wf && !compileWorkflow && (await wf.get(name)))
      return c.json({ error: 'running a managed workflow requires compileWorkflow (@gnldev/studio/workflow)' }, 501);
    if (!gnl?.runWorkflow && !canRunManaged) return c.json({ error: 'workflow execution is not enabled' }, 501);
    { const denied = wfStoreRefusal(c); if (denied) return denied; }
    return c.json({ error: `workflow '${name}' not found` }, 404);
  });

  // Run a workflow LIVE (admin) — SSE: streams in real time as steps land in the journal (poll-to-stream).
  // Without changing the engine: start runWorkflow + poll the `<runId>:wf:*` keys. Requires listKeys+get.
  // What-if fork (workflow): copy the output of the first `upto` steps to a new runId → with the same
  // Input, the copied ones REPLAY on resume, and the selected step onward re-runs. The workflow
  // Counterpart of the agent fork (forkRun) — "what-if" analysis that can't be copied without a journal.
  app.post('/workflows/:name/runs/:id/fork', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ error: 'fork requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const src = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { upto?: number; newRunId?: string };
    // Step order: code workflow metadata → otherwise the managed definition.
    let stepIds: string[] | undefined;
    if (gnl?.listWorkflows) stepIds = (await gnl.listWorkflows()).find((w) => w.name === name)?.steps.map((s) => s.id);
    if (!stepIds?.length && workflows) stepIds = (await workflows.listWorkflows()).find((w) => w.name === name)?.steps.map((s) => s.id);
    { const wf = wfStoreFor(c); if (!stepIds?.length && wf) stepIds = (await wf.get(name))?.steps.map((s) => s.id); }
    if (!stepIds?.length) {
      const denied = wfStoreRefusal(c); if (denied) return denied;
      return c.json({ error: `workflow '${name}' not found` }, 404);
    }

    const upto = Math.max(0, Math.min(body.upto ?? stepIds.length, stepIds.length));
    const keep = new Set(stepIds.slice(0, upto));
    const dst = body.newRunId ?? `${src}:fork:${Date.now()}`;
    const prefix = `${src}:wf:`;
    const keys = await rw.listKeys!(prefix).catch(() => [] as string[]);
    let copied = 0;
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      // Composite sub-keys are also attributed to their step: foreach[0], loop#2, nested:child …
      const owner = stepIds.find((sid) => rest === sid || rest.startsWith(sid + '[') || rest.startsWith(sid + '#') || rest.startsWith(sid + ':'));
      if (owner && keep.has(owner)) {
        await rw.put!(`${dst}:wf:${rest}`, await rw.get!(k));
        copied++;
      }
    }
    await audit(c, 'fork', src, { workflow: name, upto, newRunId: dst });
    return c.json({ ok: true, newRunId: dst, copied, keptSteps: [...keep] });
  });

  app.post('/workflows/:name/run-stream', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'streaming requires a writable journal (listKeys+get)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; runId?: string };
    const runId = body.runId || `wf-${name}-${Date.now()}`;

    // Code or managed? → pick the right starter. Both journal to `${runId}:wf:*` → poll-to-stream is shared.
    const codeNames = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    const isCode = codeNames.includes(name);
    const wf = wfStoreFor(c);
    let begin: (() => Promise<any>) | null = null;
    if (isCode && gnl?.runWorkflow) {
      const runWf = gnl.runWorkflow.bind(gnl); // unbound method → loses this; bind it.
      begin = () => runWf(name, body.input, { runId });
    } else if (!isCode && canRunManaged && wf && (await wf.get(name))) {
      begin = () => runManaged(wf!, name, body.input, runId, undefined, undefined, (n) => managedOverrides(n, c));
    }
    if (!begin) {
      if (wf && !compileWorkflow && (await wf.get(name)))
        return c.json({ error: 'running a managed workflow requires compileWorkflow (@gnldev/studio/workflow)' }, 501);
      if (!gnl?.runWorkflow && !canRunManaged) return c.json({ error: 'workflow execution is not enabled' }, 501);
      { const denied = wfStoreRefusal(c); if (denied) return denied; }
      return c.json({ error: `workflow '${name}' not found` }, 404);
    }

    const pre = `${runId}:wf:`;
    const jkeys = rw.listKeys.bind(rw);
    const jget = rw.get.bind(rw);
    const start = begin;
    return sseResponse(c, async (stream) => {
      await stream.writeSSE({ event: 'start', data: JSON.stringify({ runId }) });
      const seen = new Set<string>();
      const emitNew = async () => {
        const keys = await jkeys(pre).catch(() => [] as string[]);
        for (const k of keys) {
          if (seen.has(k)) continue;
          seen.add(k);
          const stepId = k.slice(pre.length);
          if (stepId === '_suspend') continue;
          const output = await jget(k).catch(() => undefined);
          await stream.writeSSE({ event: 'step', data: JSON.stringify({ stepId, output, ts: Date.now() }) });
        }
      };
      let settled = false;
      let result: any;
      let error: any;
      const p = start()
        .then((r) => { result = r; })
        .catch((e) => { error = e; })
        .finally(() => { settled = true; });
      while (!settled && !stream.aborted) { await emitNew(); await stream.sleep(120); }
      await p;
      await emitNew(); // final steps the poll didn't catch up to
      if (error) await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(error?.message ?? error) }) });
      else await stream.writeSSE({ event: result?.suspended ? 'suspended' : 'done', data: JSON.stringify(result ?? { runId }) });
    });
  });

  // The status of a workflow RUN (step outputs + suspend, from the journal) — open a past run / replay.
  app.get('/workflows/run/:runId', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'wf run state requires listKeys+get' }, 501);
    const runId = decodeURIComponent(c.req.param('runId'));
    const pre = `${runId}:wf:`;
    const keys = await rw.listKeys(pre);
    const steps: { stepId: string; output: unknown }[] = [];
    let suspend: unknown = null;
    for (const k of keys) {
      const stepId = k.slice(pre.length);
      const v = await rw.get(k);
      if (stepId === '_suspend') suspend = v;
      else steps.push({ stepId, output: v });
    }
    return c.json({ runId, steps, suspended: !!suspend, suspend });
  });

  // Lists ALL runs of a workflow (persistent history; server-side instead of localStorage).
  // Extracts `wf-<name>-` prefixed runIds from the journal (pure-wf runs don't land in listRuns → listKeys).
  app.get('/workflows/:name/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'wf run listing requires listKeys+get' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit')) || 100));
    const prefix = `wf-${name}-`;
    // Disambiguate sibling workflow prefix collisions (wf-order-… ⊃ wf-order-fulfillment-…).
    const siblings = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    const longerSibs = siblings.filter((s) => s !== name && s.startsWith(name + '-'));
    const keys = await rw.listKeys(prefix);
    const byRun = new Map<string, { steps: Set<string>; suspend: boolean }>();
    for (const k of keys) {
      const sep = k.indexOf(':wf:');
      if (sep < 0) continue;
      const runId = k.slice(0, sep);
      if (!runId.startsWith(prefix)) continue;
      if (longerSibs.some((s) => runId.startsWith(`wf-${s}-`))) continue;
      const rest = k.slice(sep + ':wf:'.length);
      let e = byRun.get(runId);
      if (!e) { e = { steps: new Set(), suspend: false }; byRun.set(runId, e); }
      if (rest === '_suspend') e.suspend = true;
      else e.steps.add(rest);
    }
    const runs: { runId: string; startedAt?: number; steps: number; status: 'completed' | 'suspended'; suspended: boolean }[] = [];
    for (const [runId, e] of byRun) {
      let status: 'completed' | 'suspended' = 'completed';
      if (e.suspend) {
        // _suspend is sticky: if the suspended step's output now exists, the run was resumed and completed.
        const s = (await rw.get(`${runId}:wf:_suspend`).catch(() => null)) as { stepId?: string } | null;
        status = s?.stepId && e.steps.has(s.stepId) ? 'completed' : 'suspended';
      }
      const tail = runId.slice(prefix.length);
      runs.push({ runId, startedAt: /^\d+$/.test(tail) ? Number(tail) : undefined, steps: e.steps.size, status, suspended: status === 'suspended' });
    }
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.runId < b.runId ? 1 : -1));
    return c.json(runs.slice(0, limit));
  });

  /**
   * P0.4 the suspended/completed/canceled workflow-run REGISTRY query — every run
   * (code OR managed) in ONE `wfrun:` prefix scan. Deliberately reimplemented INLINE against `rw` rather
   * Than importing @gnldev/workflow's `listWorkflowRuns`: the studio CORE stays decoupled from @gnldev/workflow
   * (see WorkflowLike/managed-workflow.ts — only the optional `./workflow` compiler subpath depends on
   * It), and `rw` here already goes through the org-scoped ALS bridge on GET (same isolation guarantee
   * Every other listKeys-based route in this file gets — see `reader`'s `scopedNow()` above). The
   * `wfrun:<runId>` key shape is a documented contract of @gnldev/workflow's workflow.ts (statusKey),
   * Stable to read directly without importing the package.
   */
  app.get('/workflows/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'workflow run listing requires listKeys+get' }, 501);
    const statusRaw = c.req.query('status');
    if (statusRaw != null && statusRaw !== 'suspended' && statusRaw !== 'completed' && statusRaw !== 'canceled') {
      return c.json({ error: `invalid status '${statusRaw}' (expected 'suspended', 'completed', or 'canceled')` }, 400);
    }
    type WfRunRow = { runId: string; status: string; stepId?: string; waitId?: string; reason?: unknown; updatedAt: number };
    const keys = await rw.listKeys('wfrun:');
    const limitRaw = c.req.query('limit');

    // API-03: `limit` omitted → the legacy flat-array contract, UNCHANGED (older callers — e.g.
    // Packages/server — never send `limit` and must keep getting a bare array back).
    if (limitRaw === undefined) {
      const out: WfRunRow[] = [];
      for (const k of keys) {
        const st = (await rw.get(k)) as WfRunRow | undefined;
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
      }
      out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return c.json(out);
    }

    // API-03: `limit` given → a paged `{items,nextCursor}` envelope (same shape GET /runs above uses)
    // AND a bounded scan. This route used to `get` EVERY `wfrun:*` key on every poll regardless of how
    // Few rows the caller actually wanted (Workflows.tsx refetches it repeatedly for the suspended-runs
    // Inbox) — a 20k-run registry meant ~20k reads just to show 3 suspended rows. `listKeys` returns keys
    // Oldest-first (created_at ASC — see journal.ts/postgres-storage.ts), so reversing gives newest-first;
    // `cursor` is an offset into that reversed order, and the scan stops as soon as `limit` matches are
    // Found (the `status` filter still can't be pushed into the key shape itself, so this is the cheapest
    // Bound available without changing the `wfrun:` record format).
    const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 500);
    const start = Math.max(Math.floor(Number(c.req.query('cursor'))) || 0, 0);
    const window = [...keys].reverse().slice(start);

    const out: WfRunRow[] = [];
    let scanned = 0;
    if (typeof rw.getMany === 'function') {
      // ONE batched round-trip for the whole remaining window instead of a `get` call per key (same
      // Pattern as /metrics/runs above) — the early exit below still keeps the RESPONSE bounded even
      // Though the batch itself already happened.
      const values = await rw.getMany<WfRunRow>(window);
      for (; scanned < values.length; scanned++) {
        const st = values[scanned];
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
        if (out.length >= limit) { scanned++; break; }
      }
    } else {
      for (; scanned < window.length; scanned++) {
        const st = (await rw.get(window[scanned]!)) as WfRunRow | undefined;
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
        if (out.length >= limit) { scanned++; break; }
      }
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const nextCursor = scanned < window.length ? String(start + scanned) : undefined;
    return c.json({ items: out, nextCursor });
  });

  /**
   * D3-A durably cancels a workflow run — studio's counterpart of
   * @gnldev/server's POST /workflows/runs/:id/cancel (P0.4). Reimplemented INLINE against `rw` rather than
   * Importing @gnldev/workflow's `cancelWorkflowRun` — same reason GET /workflows/runs above is inline
   * (the studio CORE stays decoupled from @gnldev/workflow; only the optional `./workflow` compiler
   * Subpath depends on it). Writes the SAME two keys `cancelWorkflowRun` does: the per-run
   * `${runId}:wf:_canceled` flag (checked by runResumable before every step — reaches a run in flight
   * On ANOTHER worker at its next step boundary) and the `wfrun:<runId>` registry record with
   * `status:'canceled'` (so it moves out of the suspended-runs inbox and GET /workflows/runs?status=canceled
   * Picks it up) — see workflow-p04.test.ts's own comment on this exact key shape. A run whose registry
   * Record already reports `completed` is a no-op (nothing left to cancel); visibility follows the SAME
   * Pattern GET /workflows/runs/:id (fork) uses elsewhere: EITHER the registry record OR the `_suspend`
   * Marker must exist, otherwise this is a cross-org/nonexistent runId → 404 (no existence leak).
   */
  app.post('/workflows/runs/:id/cancel', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable || typeof rw.listKeys !== 'function' || typeof rw.get !== 'function' || typeof rw.put !== 'function') {
      return c.json({ error: 'workflow cancel requires a writable journal (listKeys+get+put)' }, 501);
    }
    const runId = decodeURIComponent(c.req.param('id'));
    const statusKey = `wfrun:${runId}`;
    const existing = (await rw.get!(statusKey).catch(() => undefined)) as
      { status?: string; stepId?: string; waitId?: string } | undefined;
    const visible = existing !== undefined || (await rw.get!(`${runId}:wf:_suspend`).catch(() => undefined)) !== undefined;
    if (!visible) return c.json({ error: `workflow run '${runId}' not found` }, 404);
    if (existing?.status === 'completed') {
      await audit(c, 'workflow.cancel', runId, { cancelled: false });
      return c.json({ ok: true, cancelled: false, note: 'run already completed' });
    }
    const now = Date.now();
    await rw.put!(`${runId}:wf:_canceled`, { at: now });
    await rw.put!(statusKey, {
      runId, status: 'canceled', updatedAt: now,
      ...(existing?.stepId ? { stepId: existing.stepId } : {}),
      ...(existing?.waitId ? { waitId: existing.waitId } : {}),
    });
    await audit(c, 'workflow.cancel', runId, { cancelled: true });
    return c.json({ ok: true, cancelled: true });
  });

  // ── Workflow CRUD (managed; if resolvedWfStore exists) ─────────────────────────
  app.get('/workflows/:name/def', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    { const denied = requireScopedHost(c, 'workflowStore'); if (denied) return denied; }
    const wf = wfStoreFor(c);
    if (!wf) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const def = await wf.get(name);
    if (!def) return c.json({ error: 'not found' }, 404);
    return c.json(def);
  });

  app.post('/workflows', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedHost(c, 'workflowStore'); if (denied) return denied; }
    const wf = wfStoreFor(c);
    if (!wf) return c.json({ error: 'no workflow store is available' }, 501);
    const body = (await c.req.json().catch(() => null)) as WorkflowDef | null;
    if (!body?.name?.trim()) return c.json({ error: 'name is required' }, 400);
    const now = Date.now();
    const def: WorkflowDef = { ...body, steps: body.steps ?? [], createdAt: body.createdAt ?? now, updatedAt: now };
    await wf.set(def);
    await audit(c, 'workflow.create', def.name);
    return c.json({ ok: true, workflow: { name: def.name, description: def.description, steps: def.steps.map((s) => ({ id: s.id, kind: 'agent' })), source: 'managed' } });
  });

  app.put('/workflows/:name', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedHost(c, 'workflowStore'); if (denied) return denied; }
    const wf = wfStoreFor(c);
    if (!wf) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => null)) as Partial<WorkflowDef> | null;
    if (!body) return c.json({ error: 'invalid body' }, 400);
    const existing = await wf.get(name);
    const def: WorkflowDef = { ...existing, ...body, steps: body.steps ?? existing?.steps ?? [], name, updatedAt: Date.now(), createdAt: existing?.createdAt ?? Date.now() };
    await wf.set(def);
    await audit(c, 'workflow.update', name);
    return c.json({ ok: true });
  });

  app.delete('/workflows/:name', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    { const denied = requireScopedHost(c, 'workflowStore'); if (denied) return denied; }
    const wf = wfStoreFor(c);
    if (!wf) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const codeNames = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    if (codeNames.includes(name)) return c.json({ error: 'a code-defined workflow cannot be deleted' }, 403);
    await wf.delete(name);
    await audit(c, 'workflow.delete', name);
    return c.json({ ok: true });
  });

  // ── Scorers / Evals (if scorers is given) ─────────────────────────────────────
  app.get('/scorers', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    return c.json(scorers ? await scorers.list() : []);
  });
  // Score a run with the selected scorers (read; deterministic, reads from a journaled run).
  // ── Managed agent versions: list / new version / promote (rollback = promoting an older version) ──
  app.get('/managed-agents', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    const store = agentStoreFor(c); // org-scoped: a bound identity sees only its own versions
    if (!store) return c.json({ agents: [] });
    return c.json({ agents: await store.list() });
  });

  app.post('/managed-agents', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c); // a bound identity manages only ITS OWN org's versions
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const body = (await c.req.json().catch(() => null)) as { name?: string; model?: string; system?: string; maxSteps?: number; note?: string } | null;
    if (!body?.name?.trim() || !body?.model?.trim()) return c.json({ error: 'name and model are required' }, 400);
    const name = body.name.trim();
    // GOVERNANCE OVER CODE-DEFINED AGENTS (deliberate boundary — no-code builder is deferred):
    // A managed version only OVERRIDES an existing code agent's model/system (see managedOverrides).
    // Versioning a name with NO code counterpart would create a record that can never run (the registry
    // Throws "not registered"). Reject it at the source so the managed layer stays honest — it governs
    // Code agents; it is not a no-code agent factory. Enforced only when a runner is wired (`gnl`): with
    // No runner the studio is store-only (nothing runs anyway) and the UI's agent dropdown is empty, so
    // There's nothing to guard against. (An org-bound caller sees the same code registry.)
    const isCodeDefined = !gnl || (await gnl.listAgents()).some((a) => a.name === name);
    if (!isCodeDefined) return c.json({ error: `'${name}' is not a code-defined agent. Managed versions govern code-defined agents — define '${name}' in createGnl first.` }, 422);
    const rec = (await store.get(name)) ?? { name, active: null, versions: [] };
    const version = (rec.versions[rec.versions.length - 1]?.version ?? 0) + 1;
    rec.versions.push({
      version,
      model: body.model.trim(),
      ...(body.system != null ? { system: body.system } : {}),
      ...(body.maxSteps != null ? { maxSteps: body.maxSteps } : {}),
      ...(body.note ? { note: body.note } : {}),
      createdAt: Date.now(),
    });
    // The first version is auto-promoted to prod: if there's no active version yet (active == null), the
    // Newly created version becomes prod → a new managed agent works immediately (no "I created it but
    // Why doesn't it run" friction). Subsequent versions stay drafts (active untouched) → require promote.
    // EXCEPTION: if the eval gate (opts.evalGate) is configured, even the first version is NOT
    // Auto-promoted — otherwise it would land in prod without clearing the eval suite (a governance
    // Bypass). While the gate is on, the user promotes manually (the gate runs then).
    const autoPromoted = rec.active == null && !opts.evalGate;
    if (autoPromoted) rec.active = version;
    await store.put(rec);
    await audit(c, 'agent.version', name, { version });
    if (autoPromoted) await audit(c, 'agent.promote', name, { from: null, to: version, auto: true });
    return c.json({ ok: true, name, version, active: rec.active });
  });

  app.post('/managed-agents/:name/promote', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c);
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const rec = await store.get(name);
    if (!rec) return c.json({ error: `agent '${name}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    const target = rec.versions.find((v) => v.version === body.version);
    if (!target) return c.json({ error: `version ${body.version} not found (available: ${rec.versions.map((v) => v.version).join(', ')})` }, 400);

    // Eval gate: run the suite → all aggregate scores must clear the threshold; the decision is logged to audit.
    if (opts.evalGate) {
      if (!datasets) return c.json({ error: 'evalGate is configured but the datasets option is missing' }, 501);
      const minAvg = opts.evalGate.minAvg ?? 0.5;
      let aggregate: Record<string, number>;
      try {
        // The organization too. This is the eval gate for PROMOTING a managed agent version, which
        // happens in an organization's context — leaving it off would be the same rule applied to
        // the call sites that were easy to find rather than to all of them.
        aggregate = (await datasets.run(opts.evalGate.datasetId, undefined, { orgId: callerOrg(c) })).aggregate;
      } catch (e: any) {
        return c.json({ error: `eval gate could not run: ${String(e?.message ?? e)}` }, 500);
      }
      // A GATE THAT MEASURED NOTHING HAS NOT PASSED. Two degenerate answers used to sail through, both
      // because `filter` cannot flag what it never sees: an EMPTY aggregate — the dataset ran with no
      // scorers attached, so `evalDataset` builds `{}`, `Object.entries({})` is `[]`, `failing` is empty
      // and `passed` is true — and a NON-FINITE average, since `NaN < minAvg` is false so it is not
      // "failing" either. Both answer "promote it" to the question "is this version good enough", which
      // is the one direction a gate must never fail in. Neither is reachable from a shipped code path
      // today (no caller passes `scorers: []`, and every shipped scorer guards its own arithmetic), but
      // that is a property of today's callers, not of the gate.
      const measured = Object.entries(aggregate);
      if (measured.length === 0) {
        return c.json({
          error: 'eval gate could not decide: the dataset produced no scores. Attach at least one scorer '
            + 'to the datasets manager, or remove the gate — a gate with nothing to measure is not a pass.',
          aggregate,
        }, 412);
      }
      const failing = measured.filter(([, v]) => !Number.isFinite(v) || v < minAvg);
      const passed = failing.length === 0;
      await audit(c, 'agent.gate', name, { version: target.version, datasetId: opts.evalGate.datasetId, minAvg, aggregate, passed });
      if (!passed) {
        return c.json({
          error: `eval gate FAILED: ${failing.map(([k, v]) => `${k}=${v.toFixed(2)}<${minAvg}`).join(', ')} — promote rejected`,
          aggregate,
        }, 412);
      }
    }

    const from = rec.active;
    rec.active = target.version;
    await store.put(rec);
    await audit(c, 'agent.promote', name, { from, to: target.version });
    return c.json({ ok: true, name, active: rec.active, previous: from });
  });

  // PERMANENTLY delete a managed agent record (with ALL its versions) — removes only the MANAGED record;
  // A code-defined agent (createGnl agents) doesn't come from this store, so it can't be deleted/affected.
  // If code + managed share a name, deleting only removes the managed override — the code agent (registry) keeps showing as-is.
  app.delete('/managed-agents/:name', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c); // a bound identity deletes only ITS OWN org's record
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const existing = await store.get(name);
    if (!existing) return c.json({ error: `agent '${name}' not found` }, 404);
    if (!store.delete) return c.json({ error: 'agent deletion requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    await store.delete(name);
    await audit(c, 'agent.delete', name, { versions: existing.versions.length, hadActive: existing.active != null });
    return c.json({ ok: true, name });
  });

  // Delete a SINGLE VERSION. The ACTIVE (prod) version cannot be deleted → promote another version first
  // (409). Since the active version is never deleted, the active pointer always stays valid. If the last
  // Version is deleted too, the agent record is removed entirely (same as whole-agent delete — needs store.delete; only in that case).
  app.delete('/managed-agents/:name/versions/:version', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c);
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const version = Number(c.req.param('version'));
    const rec = await store.get(name);
    if (!rec) return c.json({ error: `agent '${name}' not found` }, 404);
    if (!rec.versions.some((v) => v.version === version)) {
      return c.json({ error: `version ${version} not found (available: ${rec.versions.map((v) => v.version).join(', ')})` }, 400);
    }
    if (rec.active === version) {
      return c.json({ error: `active (prod) version v${version} cannot be deleted — promote another version first` }, 409);
    }
    rec.versions = rec.versions.filter((v) => v.version !== version);
    if (rec.versions.length === 0) {
      if (!store.delete) return c.json({ error: 'deleting the last version requires journal deletePrefix support' }, 501);
      await store.delete(name);
    } else {
      await store.put(rec);
    }
    await audit(c, 'agent.version-delete', name, { version, remaining: rec.versions.length });
    return c.json({ ok: true, name, version, active: rec.active, remaining: rec.versions.length });
  });

  app.post('/runs/:id/score', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    if (!scorers) return c.json({ error: 'scorers is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    // Read-gated, but it still reads a RUN: a scorer's `reason` quotes the run it judged, so an
    // unscoped id hands another organization's prompt back to the caller through the explanation field.
    if (!(await runVisible(id))) return c.json({ error: `run '${id}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { scorers?: string[]; expected?: string };
    try {
      return c.json({ ok: true, ...(await scorers.score(id, body.scorers ?? [], { expected: body.expected })) });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // ── Evals / Datasets (if datasets is given) ───────────────────────────────────
  app.get('/datasets', async (c) => ((await allowP(c.req.raw, 'catalog:read')) ? c.json(datasets ? await datasets.list() : []) : deny(c.req.raw, 'read')));
  // Run a dataset suite (admin — runs the agent → LLM). Returns a result table + aggregate.
  app.post('/datasets/:id/run', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!datasets) return c.json({ error: 'datasets is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { scorers?: string[] };
    try {
      return c.json({ ok: true, ...(await datasets.run(id, { scorers: body.scorers }, { orgId: callerOrg(c) })) });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // ── A2A Networks (if the a2a option is on) — extracts agent-to-agent edges from the journal ───────
  app.get('/a2a-network', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!a2a) return c.json([]);
    const runs = await reader.listRuns();
    const edges: { parentRunId: string; remoteAgent: string; remoteRunId?: string; status: string }[] = [];
    for (const r of runs) {
      const entries = await reader.readRun(r.runId);
      for (const e of entries) {
        const out: any = (e.value as any)?.output;
        if (e.kind === 'tool' && out && typeof out === 'object' && out.remoteAgent) {
          edges.push({ parentRunId: r.runId, remoteAgent: String(out.remoteAgent), remoteRunId: out.runId, status: (e.value as any)?.status ?? '?' });
        }
      }
    }
    return c.json(edges);
  });

  // ── MCP Servers (if mcp is given) — list each client's tools ─────────
  app.get('/mcp-servers', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    if (!mcp?.length) return c.json([]);
    const out: { id: string; name?: string; tools: unknown[]; error?: string }[] = [];
    for (const s of mcp) {
      try {
        const { tools } = await s.client.listTools();
        out.push({ id: s.id, name: s.name, tools });
      } catch (e: any) {
        out.push({ id: s.id, name: s.name, tools: [], error: String(e?.message ?? e) });
      }
    }
    return c.json(out);
  });

  return app;
}

/** **Studio Admin** (HTML UI only). Points at the local/remote API via `apiBase`; can be served statically/separately. */
function studioAdminApp (opts: { apiBase?: string } = {}): Hono {
  const app = new Hono();
  app.get('/openapi.json', (c) => c.json(openapiSpec(opts.apiBase ?? '')));
  // The page carries its own <meta> CSP, but the spec IGNORES frame-ancestors in meta form — so the
  // one directive that stops this admin page being framed for clickjacking ("Execute" sits on it) was
  // dead. The server owns this route, so the header goes on here; the meta stays for other hostings.
  app.get('/swagger', (c) => {
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY'); // the same statement for anything old enough to predate CSP
    return c.html(swaggerHtml(opts.apiBase ?? ''));
  });
  // Prefer the prebuilt React SPA (@gnldev/studio-ui) first; fall back to the old single-file HTML if there's no build.
  if (!mountSpa(app, opts.apiBase ?? '')) app.get('/', (c) => c.html(notBuiltHtml()));
  return app;
}

/**
 * A convenience that combines Admin + API into a single app (backward compatible). Admin at '/', API at '/api/*'.
 * Pass `apiBase` for the prefix it will be mounted at (e.g. '/studio' → admin fetches against /studio/api).
 */
function studioAppApp (input: JournalReader | StudioAppOptions): Hono {
  const opts: StudioAppOptions = isReader(input) ? { reader: input } : input;
  const app = new Hono();
  app.route('/api', studioApiApp(opts));
  app.get('/openapi.json', (c) => c.json(openapiSpec(opts.apiBase ?? '')));
  // The page carries its own <meta> CSP, but the spec IGNORES frame-ancestors in meta form — so the
  // one directive that stops this admin page being framed for clickjacking ("Execute" sits on it) was
  // dead. The server owns this route, so the header goes on here; the meta stays for other hostings.
  app.get('/swagger', (c) => {
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY'); // the same statement for anything old enough to predate CSP
    return c.html(swaggerHtml(opts.apiBase ?? ''));
  });
  // Prefer the prebuilt React SPA (@gnldev/studio-ui) first; fall back to the old single-file HTML if there's no build.
  if (!mountSpa(app, opts.apiBase ?? '')) app.get('/', (c) => c.html(notBuiltHtml()));
  return app;
}

/**
 * The public factories. Each returns a fetch handler, not a Hono app — see `handler.ts` for why.
 *
 * Hono host:      app.mount('/studio', createStudioApp(...))
 * Anything else:  toNodeHandler(createStudioApp(...))   // @gnldev/studio/node
 * Standalone:     serve({ fetch: createStudioApp(...).fetch })
 */
export function createStudioApi (input: JournalReader | StudioApiOptions): FetchHandler {
  return toFetchHandler(studioApiApp(input));
}
export function createStudioAdmin (opts: { apiBase?: string } = {}): FetchHandler {
  return toFetchHandler(studioAdminApp(opts));
}
export function createStudioApp (input: JournalReader | StudioAppOptions): FetchHandler {
  return toFetchHandler(studioAppApp(input));
}

// Backward-compatible type alias.
export type StudioOptions = StudioApiOptions;
