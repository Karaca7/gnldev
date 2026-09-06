// @gnldev/durable — an exactly-once + deterministic-replay layer for Vercel AI SDK agents.
// Drop-in: generateText -> runDurable. Composable: withDurableModel + durableTools.

export { InMemoryJournal, parseJournalKey, summarizeRun, claim, frozenGet, runKeys, deriveRunStatus, nestedAgentRunId, listRunsArray, asReaderJournal, runIdOfKey } from './journal.js';
// H13 — journal format versioning: an API that keeps old records readable across SDK-major transitions.
export { JOURNAL_FORMAT_VERSION, JournalFormatError, registerFormatUpgrade, stampFormat, upgradeFormat, isVersionedKey } from './format.js';
export { acquireRunLock } from './run-lock.js';
export type { RunLock } from './run-lock.js';
export { reconstructState, forkRun, settleModelContent } from './time-travel.js';
export { appendLog, listLog, countLog, consumeOnce } from './durable-log.js';
export type { LogItem } from './durable-log.js';
export type { ReconstructedState, ReconstructSeed, ForkResult } from './time-travel.js';
export type {
  Journal,
  JournalReader,
  JournalEntry,
  JournalEntryKind,
  RunSummary,
  DurableCtx,
  ToolJournalRecord,
  RunStatus,
  RunOutcomeRecord,
} from './journal.js';
export { BasicMemory, PROVENANCE_RECENT_CAP, messagePreview } from './memory.js';
export type { Memory, MemoryContextProvenance, RecalledMessageRef } from './memory.js';
export { getRunCost, toTraceSpans } from './cost.js';
// Sibling packages (@gnldev/otel's span builder) read the same journal records and hit the same
// AI-SDK shape churn. Exporting the two readers keeps ONE implementation of that knowledge instead
// of a copy per package — the copies are what drift, and drift here is silent.
export { flattenUsage, finishReasonText, type FlatUsage } from './sdk-compat.js';
export type { RunCost, RunCostOptions, TraceSpan } from './cost.js';
export { DEFAULT_PRICING, priceFor, costOf, PRICING_KEY, readPricing, effectivePricingTable } from './pricing.js';
// Exported for consumers that need the usage/modelId of ONE model step and their own pricing
// Decision on top — `getRunCost` prices an unknown model at 0, which is right for a total and wrong
// For a report that has to distinguish "free" from "we have no price for this".
export { usageAndCostFromModelValue, modelRecordFacts } from './cost.js';
export type { ModelPricing, PricingDoc } from './pricing.js';
export {
  DivergenceError, RunBusyError, SideEffectRetryBlockedError, RetryLimitExceededError,
  ReplicationNotAcknowledgedError, SuiteVersionMismatchError, RunThreadMismatchError,
  RunInputMismatchError, RunActorMismatchError, RunSweptError,
  CALLER_CONFLICT_CODES, callerConflictCode,
  BLOCKED_ERROR_CODES, blockedErrorCode, upstreamFailure,
} from './errors.js';
export type { UpstreamFailure } from './errors.js';
// Task 3: opt-in sibling-suite version-skew guard (see suite-consistency.ts).
export { assertSuiteConsistent, versionsEqual } from './suite-consistency.js';
export type { AssertSuiteConsistentOptions } from './suite-consistency.js';
export { StepTimeoutError, withTimeout } from './timeout.js';
export { argsHash, stableStringify } from './hash.js';
export { serialize, deserialize } from './serialize.js';
export { withDurableModel } from './durable-model.js';
export type { DurableModelOptions, ExclusiveStepOptions } from './durable-model.js';
export { durableTool, durableTools } from './durable-tool.js';
// AI SDK drop-in: LLM-aware idempotency for a plain generateText/streamText loop (no runDurable).
export { withIdempotency, releaseFailedClaim } from './idempotent-tools.js';
export type { WithIdempotencyOptions } from './idempotent-tools.js';
export type { ModelInput, AnyTool, ToolSet } from './types.js';
export { gnlTool } from './types.js';
// Shared with @gnldev/studio: rendering a tool list has no call context, so a dynamic description
// must resolve to nothing rather than to a stringified function.
export { toolDescriptionText } from './types.js';
export type { ToolDurability } from './types.js';
export { runDurable, resumeRun, streamDurable, limitBreachFromSteps, blockedFromSteps } from './run.js';
export type { RunDurableArgs, StreamDurableArgs, DurableResult, ResumeAgentConfig, StreamBreach, MemoryContextRecord } from './run.js';
// K1/W1 (B): sentinel→error conversion helper for code that consumes streamDurable directly.
export { streamFinishError } from './run.js';
// Greenfield storage contracts (ports + Storage + capability + composite).
export { CapabilityError, requireCapability, composite, toJournal, matchFilter, assertUniformSeq } from './storage.js';
export type { AdoptIntoOrgResult,
  Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions,
  VectorDoc, VectorItem, VectorMatch, LogRecord,
  Storage, CapabilityLevel, CapabilityMatrix, StoreName, CompositeConfig,
} from './storage.js';
export { InMemoryStorage } from './in-memory-storage.js';
export { RedisStorage } from './redis-storage.js';
export type { RedisLike, RedisStorageOptions } from './redis-storage.js';
export type { Guard, GuardCall, GuardDecision, Interrupt, SuspendSentinel } from './guard.js';
export { taintGuardian } from './guard.js';
export { durableProcessorStep, createProcessorCtx, ProcessorTripwire, recordProcessorReport, readProcessorReports } from './processor.js';
// D4-retry turn-level retry-with-feedback ladder (see run.ts).
export { ProcessorRetry, RetryExhaustedByProcessorError } from './processor.js';
export { recordIncident, readIncidents } from './incidents.js';
export { readRunOutcome, recordRunOutcome, runStarted, runCanceled, isRunFailure } from './outcome.js';
export { acquireLease, releaseLease, readLease } from './lease.js';
export type { Lease } from './lease.js';
export type { RunIncident } from './incidents.js';
export type { Processor, ProcessorInput, ProcessorOutput, ProcessorCtx, ProcessorToolResult, ProcessorReport, ProcessorStepInput, ProcessorStepOverride, ProcessorStepOutput } from './processor.js';
export { createAgentTool, runSubAgent } from './agent-tool.js';
export type { AgentToolConfig } from './agent-tool.js';
export { createGnl, agentVisibleToOrg, sealRequestContext, serverIdentityOf, GNL_RESOURCE_ID_KEY, GNL_ORG_ID_KEY, GNL_THREAD_ID_KEY } from './registry.js';
export type { CreateGnlConfig, AgentConfig, RunOptions, WorkflowLike, WorkflowMeta, WorkflowRunResult, RequestContext, DynamicArg, ScorerLike, NetworkConfig } from './registry.js';
// Dynamic multi-agent routing (Supervisor/`.network()` parity) — decisions are CAS-frozen.
export { runNetwork, getNetworkTrace, netKeys } from './network.js';
export type { NetworkResult, NetworkStep, NetworkTarget, RouteDecision, RunNetworkOptions } from './network.js';
export { withOrg, orgScopeOf, orgPrefix, isPlatformKey, assertOrgRegistered, assertNoRunsInFlight, ORG_RECORD_PRE, ADOPTABLE_RESERVED_PREFIXES, ENGINE_META_KEYS } from './organization.js';
export { withOrgStorage, orgStorageScopeOf } from './org-storage.js';
export { orgPurgedKey, purgeRun, purgeThread, purgeResource, purgeOrganization, sweepRuns, sweepLog, sweepThreads, createRetentionSweeper } from './retention.js';
export type { LogSweepTarget, RetentionSweeperOptions, RetentionSweepSummary, RetentionSweeper } from './retention.js';
export { recordIdemConflict, readIdemLedger } from './idem-ledger.js';
export { semKey, semTombKey, SEM_TEMPLATE_VERSION } from './semantic-dup.js';
export type { SemanticDupConfig, SemanticIdentity, SemDupRecord } from './semantic-dup.js';
// Heyet matrisi: kullanım profili × yan-etki sınıfı tekrar politikası.
export { PRESET_MATRIX, PRESET_DEFAULT } from './policy-matrix.js';
export { xidKey, xidPlanOf, writeXid, readXid, xidWhen } from './xid.js';
export type { XidRecord, XidPlan } from './xid.js';
export type { EffectClass, DupSpec, DupAction } from './policy-matrix.js';
// HERMES v1: approval-gated suggestions/lessons (two switches, evidence discipline, optional promotion).
export {
  createSuggestions, validateSuggestionsConfig, evidenceQualityOf, normalizeRule,
  suggKey, personalLessonKey, orgLessonKey, lessonProvenanceKey,
} from './suggestions.js';
export type {
  SuggestionsConfig, SuggestionsApi, SuggestionRecord, SuggestionEvidence, LessonRecord, EvidenceQuality,
} from './suggestions.js';
export type { IdemConflictRecord } from './idem-ledger.js';
// Phase 8.1: the common poll-loop core for queue/events/scheduler (a setTimeout chain with backoff).
export { createPollLoop } from './polling.js';
export type { PollLoopOptions, PollLoop } from './polling.js';
// H3: hand off a long-lived run to a new period (the safe, core-untouched solution for journal compaction).
export { rolloverRun, toModelMessages, rolloverKey } from './rollover.js';
export type { RolloverOptions, RolloverResult } from './rollover.js';
export { policyGuard, evaluatePolicy, POLICY_KEY } from './policy.js';
export type { PolicyRule, PolicyDoc } from './policy.js';
export {
  checkBudget, readBudget, getOrgUsage, isBudgetExceeded, budgetsEnforceable, assertBudget,
  BudgetExceededError, BUDGET_PRE, USAGE_KEY, usageCountedKey, recordRunUsage,
  BoundedUsageCostCache, createBoundedUsageCache,
} from './budget.js';
export type { BudgetLimit, OrganizationUsage, BudgetCheck, UsageCostCache } from './budget.js';
// P1.6 materialized metrics layer (incremental per-day/per-agent counters +
// Per-run fast-path row, riding incrBy/getCounters/putIfAbsent/deletePrefix) — see metrics.ts.
export {
  recordRunMetrics, recordRunScores, backfillMetrics, rebuildMetrics, readMetricsSummary, readCounter,
  metricsDayKey, metricsAgentDayKey, metricsRunKey, metricsDoneKey, metricsScoresDoneKey,
  METRICS_ALL_KEY, METRICS_COUNTERS_PRE, METRICS_RUN_PRE, METRICS_DONE_PRE, METRICS_SCORES_DONE_PRE,
} from './metrics.js';
export type { MetricsRunRow, MetricsDayEntry } from './metrics.js';
export type { SweepOptions, SweepResult, LogSweepOptions, LogSweepResult, ThreadSweepOptions, ThreadSweepResult } from './retention.js';
export { DuplicateSideEffectError, RunLimitExceededError, TaintedSideEffectError, ToolLoopDetectedError } from './limits.js';
export { markRunTainted, readRunTaint, readThreadTaint, readTaintProvenance } from './taint.js';
export type { RunTaint, TaintProvenance } from './taint.js';
export { compensateRun, assertNotCompensated, runCompensated, CompensatedRunError } from './compensation.js';
export type { CompensationEntry, CompensationReport } from './compensation.js';
// P2-cancel durable cross-worker agent-run cancel — see cancel.ts.
export { cancelAgentRun, agentRunCanceled, assertNotCanceled, RunCanceledError } from './cancel.js';
// Agent approval registry — governance gate for code-defined agents (opt-in via server requireAgentApproval).
export {
  fingerprintAgent, recordAgent, approveAgent, blockAgent, agentApprovalStatus, isAgentServable,
  listAgentRegistry, agentRegistryKey, AGENT_REGISTRY_PRE,
} from './agent-registry.js';
export type { AgentRegistryRecord, AgentApprovalStatus } from './agent-registry.js';
export type { RunLimits, RunLimitKind } from './limits.js';
export { resolveModel, withModelFallback, setChainToolShaper, registerModelProvider, knownModelProviders } from './model-router.js';
export type { FallbackCandidate, ModelProviderFactory } from './model-router.js';
// W2: Replay-based regression core (diffRuns/replayRun/regressionReport) — see regression.ts.
// BuildDecisionSequence: also re-exported for P1.1 — @gnldev/evals' trajectory
// Scorer builds a run's tool-call sequence from this same primitive.
export { diffRuns, replayRun, regressionReport, buildDecisionSequence } from './regression.js';
export type {
  DecisionPoint, DiffDetail, DiffEntry, RunDiff,
  ReplayRunConfig, ReplayRunResult,
  RegressionScorer, RegressionReportOptions, RegressionReport,
} from './regression.js';
// Persistent storage: `@gnldev/durable/sqlite` (SqliteStorage) · `@gnldev/durable/postgres`
// (PostgresStorage) · `@gnldev/durable/redis` (RedisStorage — runs/work/cache/meta; memory/vectors are
// Overridden via composite). For a bare durable run use `new SqliteStorage(path).runs` (RunJournal = journal).
// P2-migrate schema introspection/migration façade — see migrate.ts.
export { runMigrationCheck, tablesFromDDL } from './migrate.js';
export type { SchemaCheckResult, SchemaMigrationResult, MissingColumn, MigratableStorage, MigrationCheckResult } from './migrate.js';
