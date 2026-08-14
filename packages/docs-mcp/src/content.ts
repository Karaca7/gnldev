// EMBEDDED static GNL doc content — the fallback single source of truth for @gnldev/docs-mcp.
//
// Compiled 1:1 from components/docs/nav-data.ts (ordered list of the 25 features:
// Slug/title/oneLiner/tier/package) and lib/llms-content.ts (per-slug install/apis/example)
// On the gnl.dev site — content mirrors the official docs, not invented here.
// It is embedded here so this package can work on its own even if the site
// (https://gnl.dev) is down/unreachable; falls back to this if live content can't be
// Fetched via GNL_DOCS_URL.
//
// If the site content changes, this file must be synced by hand (no automatic sync —
// No runtime dependency was set up between the site and this package, to avoid a
// Lockfile race).

export type DocTier = 'core' | 'studio' | 'ee';

export const TIER_LABEL: Record<DocTier, string> = {
  core: `Core (free)`,
  studio: `Studio (free)`,
  ee: `Enterprise (licensed)`,
};

/**
 * Printed under every `ee` feature. Without it the install line for those recipes reads like any
 * Other — `npm install @gnldev/auth-ee` — for a package that is not on the public registry and will
 * Not be, so a reader following it gets E404 and no idea why.
 */
export const EE_NOTE =
  `\`@gnldev/auth-ee\` is a commercial package and is not published to the public npm registry. ` +
  `The APIs below are documented so the capability is discoverable; the package is distributed ` +
  `separately under the Elastic License 2.0. See https://gnl.dev for terms and access.`;

export interface DocFeature {
  /** URL fragment — lives under gnl.dev/docs/<slug>; used as the tools/call argument. */
  slug: string;
  /** 1-based order number (identical to the position in docNav). */
  order: number;
  title: string;
  oneLiner: string;
  tier: DocTier;
  package: string;
  /** Installation/import line(s). */
  install: string;
  /** Core API surface — in "name — short description" form. */
  apis: string[];
  /** 1 minimal code example. */
  example: string;
}

/** GNL overview summary — short summary mirroring gnl.dev/llms.txt (source for the gnl_docs_overview tool). */
export const OVERVIEW_SUMMARY = `A thin correctness layer on top of the Vercel AI SDK: journal-based durability, exactly-once tool calls, deterministic replay/time-travel. Runtime footprint ~8KB, BYO-DB (SQLite/Postgres/your own storage), no telemetry/phone-home — your journal always stays on your own infrastructure.`;

export const OVERVIEW_DETAIL = `GNL keeps the same agent loop via \`runDurable\`, a drop-in replacement for \`generateText\`/\`streamText\`; it additionally takes a \`journal\` + \`runId\`. Even if the process crashes, calling it again with the same \`runId\` resumes deterministically from where it left off, and completed tool calls never run again. Three tiers: Core (free, @gnldev/durable/@gnldev/server/@gnldev/auth/@gnldev/evals), Studio (@gnldev/studio — inspection/management, free), Enterprise (@gnldev/auth-ee — signed license, RBAC/SSO/multi-organization/budget).`;

/** Full list of the 25 features — mirrors gnl.dev/llms-full.txt. Order = the order field. */
export const FEATURES: DocFeature[] = [
  {
    slug: `agent-registry`,
    order: 1,
    title: `Agent registry (createGnl)`,
    oneLiner: `Central entry point that defines agents/tools/workflows in a single config and runs them durably.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createGnl, toJournal } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';`,
    apis: [`createGnl(config) — returns { run, stream, listWorkflows, runWorkflow }`, `CreateGnlConfig — storage/journal, agents, tools, workflows`, `AgentConfig — model, tools, system, guard, maxSteps, agents (sub-agent)`, `RunOptions — runId, prompt|messages, threadId, resourceId, approvals`],
    example: `const storage = new SqliteStorage(process.env.DB_PATH ?? 'app.db');
const config: CreateGnlConfig = {
  storage,
  agents: { starwars: { model: buildModel(), system: SYSTEM, tools: makeSwapiTools(), maxSteps: 4 } },
};
const gnl = createGnl(config);
await gnl.run('starwars', { runId: 'demo-1', prompt: 'Who is Luke Skywalker?' });`,
  },
  {
    slug: `storage-adapters`,
    order: 2,
    title: `Storage adapters`,
    oneLiner: `Pluggable storage: SqliteStorage, PostgresStorage, InMemoryStorage.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { SqliteStorage } from '@gnldev/durable/sqlite';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { InMemoryStorage, toJournal, composite } from '@gnldev/durable';`,
    apis: [`SqliteStorage — node:sqlite-based dev/single-file storage`, `PostgresStorage — pg-based production storage (connectionString or pool)`, `InMemoryStorage — test storage without persistence`, `composite({ default, overrides }) — different backend per port`, `toJournal(storage.runs) — bridges RunJournal to Journal & JournalReader`],
    example: `import { composite } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = composite({
  default: new SqliteStorage('app.db'),
  overrides: { cache: someRedisBackedStorage },
});`,
  },
  {
    slug: `rest-api-openapi`,
    order: 3,
    title: `Automatic REST API + OpenAPI + SSE`,
    oneLiner: `Turns createGnl into a durable HTTP API + SSE stream in a single line.`,
    tier: `core`,
    package: `@gnldev/server`,
    install: `npm install @gnldev/server @gnldev/durable hono`,
    apis: [`createRestApi(config, opts) — Hono router: run/resume/stream/usage/openapi.json`, `RestApiOptions — title, auth, org, budgets`, `buildOpenApi(...) — generates an OpenAPI 3.1 schema`, `pipeAgentStream(...) — converts a streamDurable result into an SSE event stream`],
    example: `const app = new Hono();
app.mount('/api', createRestApi(config, { title: 'SWAPI Free', auth }));

// POST /api/agents/starwars/run     {"runId":"demo-1","prompt":"..."}
// POST /api/agents/starwars/stream  -> SSE (text-delta/tool-call/tool-result/interrupt/done)`,
  },
  {
    slug: `exactly-once-tools`,
    order: 4,
    title: `Exactly-once tools`,
    oneLiner: `Side-effecting tools run only once per runId.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `pnpm add @gnldev/durable ai`,
    apis: [`runDurable — the durable counterpart of generateText, takes journal+runId`, `durableTool / durableTools — wraps a tool (set) as exactly-once`, `argsHash — detects determinism drift during replay`, `SideEffectRetryBlockedError / RetryLimitExceededError`],
    example: `const journal = new InMemoryJournal();
await runDurable({
  runId: 'run-1',
  journal,
  model,
  tools: { chargeCard },
  prompt: 'charge',
  stopWhen: stepCountIs(6),
});
// Calling again with the same runId does NOT re-run chargeCard (exactly-once)`,
  },
  {
    slug: `deterministic-replay`,
    order: 5,
    title: `Deterministic replay & crash recovery`,
    oneLiner: `An interrupted run resumes deterministically from where it left off.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { runDurable, resumeRun, InMemoryJournal } from '@gnldev/durable';`,
    apis: [`runDurable — writes every model/tool step to the journal`, `resumeRun(runId, opts) — reads the recorded input from the journal and resumes`, `reconstructState — materializes state from journal entries`, `DivergenceError — non-determinism detection in replay: 'strict' mode`],
    example: `const r2 = await resumeRun('o1', {
  journal,
  model: makeModel(),
  tools: makeTools(counter),
  approvals: { 'call-c': true },
  stopWhen: stepCountIs(6),
});
// The prompt is NOT given again — it's read from the journal`,
  },
  {
    slug: `human-in-loop-approvals`,
    order: 6,
    title: `Human-approved tools (guard)`,
    oneLiner: `Guard suspends risky calls; resumed with approval.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { runDurable, resumeRun } from '@gnldev/durable';
import type { Guard, GuardCall, GuardDecision, Interrupt } from '@gnldev/durable';`,
    apis: [`Guard — (call: GuardCall) => GuardDecision, runs before every tool call`, `GuardDecision — 'allow' | 'deny' | 'require-approval'`, `Interrupt — record of a suspended tool call`, `resumeRun — resumes a suspended run with approvals`],
    example: `const guard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000
    ? { action: 'require-approval' }
    : { action: 'allow' };

await runDurable({ runId: 'o1', journal, model, tools, guard, prompt: 'Charge 5000', stopWhen: stepCountIs(6) });
// R1.interrupts.length === 1 -> a call awaiting approval; resume with resumeRun(..., { approvals: { 'call-c': true } })`,
  },
  {
    slug: `durable-workflows`,
    order: 7,
    title: `Durable workflows`,
    oneLiner: `Multi-step workflows are safe to suspend/resume.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { workflow, step } from '@gnldev/workflow';
import { createGnl } from '@gnldev/durable';`,
    apis: [`workflow() / step(id, run) — defines a workflow with sequential steps`, `createGnl(config).runWorkflow(name, input, { runId }) — runs it durably`, `WorkflowLike — structural interface with build()/run()/optional runResumable()`, `listWorkflows() — introspects the registered workflow's step list`],
    example: `const myWorkflow = workflow<{ email: string }>()
  .then(step('onboard:create-account', async (input) => ({ ...input, accountId: 'acc_1' })))
  .then(step('onboard:send-welcome', async (input) => ({ ...input, welcomed: true })));

const gnl = createGnl({ storage, agents: {}, workflows: { onboard: myWorkflow } });
const res = await gnl.runWorkflow('onboard', input, { runId: 'wf-1' });`,
  },
  {
    slug: `model-fallback`,
    order: 8,
    title: `Model routing & fallback`,
    oneLiner: `Deterministically falls back to the first working model from a candidate list.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { withModelFallback, resolveModel, runDurable } from '@gnldev/durable';
import type { FallbackCandidate } from '@gnldev/durable';`,
    apis: [`resolveModel('provider/model') — converts a string id into an actual model (lazy import)`, `withModelFallback(candidates, journal, runId) — deterministically falls back to the first successful model`, `FallbackCandidate — { spec, model }`],
    example: `const model = withModelFallback(
  [{ model: 'openai:gpt-4o' }, { model: 'openai:gpt-4o-mini' }],
  journal,
  runId,
);
await runDurable({ runId, journal, model, tools, prompt });`,
  },
  {
    slug: `cost-observability`,
    order: 9,
    title: `Cost & pricing observability`,
    oneLiner: `Computes per-run token/cost/trace from the journal.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { getRunCost, toTraceSpans } from '@gnldev/durable';`,
    apis: [`getRunCost(reader, runId) — computes per-run token/USD cost`, `toTraceSpans(reader, runId) — generates an OTel gen_ai-compatible span list`, `effectivePricingTable(journal) — journal __pricing__ (if present) > DEFAULT_PRICING`, `DEFAULT_PRICING — approximate model pricing table ($/1M tokens)`],
    example: `const cost = await getRunCost(reader, runId);
// { runId, inputTokens, outputTokens, totalTokens, costUsd, byModel }`,
  },
  {
    slug: `open-core-auth`,
    order: 10,
    title: `Open-core auth (roleAuth)`,
    oneLiner: `Free bearer/role-based identity/authorization; REST+Studio gate.`,
    tier: `core`,
    package: `@gnldev/auth`,
    install: `import { roleAuth, type Cred } from '@gnldev/auth';
import { createRestApi } from '@gnldev/server';
import { createStudioApp } from '@gnldev/studio';`,
    apis: [`roleAuth({ admin?, viewer? }) — AuthProvider | undefined (opt-in)`, `AuthProvider — authenticate(c), authorize(principal, c, ctx)`, `Principal — { id?, roles, orgId?, permissions? }`, `makeGate — converts an AuthProvider into a Hono gate`],
    example: `// In production, refuse to start rather than fall back to a token that is public knowledge.
const required = (name: string) => {
  const v = process.env[name];
  if (!v && process.env.NODE_ENV === 'production') throw new Error(name + ' is not set');
  return v ?? 'dev-only';
};
const auth = roleAuth({
  admin: { token: required('GNL_ADMIN_TOKEN') },
  viewer: { token: required('GNL_VIEWER_TOKEN') },
});
app.mount('/api', createRestApi(config, { title: 'SWAPI Free', auth }));`,
  },
  {
    slug: `studio-inspector`,
    order: 11,
    title: `Studio — inspector & management plane`,
    oneLiner: `Journal observation UI+API: timeline/trace/cost/Playground/management.`,
    tier: `studio`,
    package: `@gnldev/studio`,
    install: `import { createStudioApp, createStudioRunner } from '@gnldev/studio';
import { aiToolSchema } from '@gnldev/studio/ai';`,
    apis: [`createStudioApp(opts) — Admin HTML UI + JSON API in a single app`, `createStudioApi / createStudioAdmin — JSON API only / HTML UI only`, `createStudioRunner(gnl, config, opts) — Playground/Tools/Workflows runner`, `GET /capabilities — discovers which Studio views are enabled`],
    example: `app.mount('/studio', createStudioApp({
  reader: toJournal(storage.runs),
  apiBase: '/studio',
  gnl: createStudioRunner(gnl, config, { toJsonSchema: aiToolSchema }),
  auth,
}));`,
  },
  {
    slug: `time-travel-fork`,
    order: 12,
    title: `Time travel & fork`,
    oneLiner: `Reconstruct state from any step, or fork into a new branch.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { reconstructState, forkRun } from '@gnldev/durable';
import { runDurable, resumeRun } from '@gnldev/durable';`,
    apis: [`reconstructState(entries, uptoStep, seed?) — materializes state at a given step`, `forkRun(journal, srcRunId, step, newRunId) — copies the first N steps to a new runId`, `ForkResult — { newRunId, copiedModel, copiedTool }`],
    example: `const fork = await forkRun(journal, 'r', 1, 'fork1');
// Fork => { newRunId: 'fork1', copiedModel: 1, copiedTool: 1 }
const r2 = await resumeRun('fork1', { journal, model: forkModel(), tools: tools(), stopWhen: stepCountIs(6) });`,
  },
  {
    slug: `guard-policy`,
    order: 13,
    title: `Data-driven guard/policy`,
    oneLiner: `Allow/deny/suspend guard driven by __policy__ in the journal; no deploy needed.`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { policyGuard } from '@gnldev/durable';`,
    apis: [`policyGuard(journal, { key?, fallback }) — builds a Guard from the __policy__ document`, `evaluatePolicy(doc, toolName, fallback) — pure evaluation function`, `POLICY_KEY — journal key ('__policy__')`, `PolicyRule — { tool, action: 'allow'|'deny'|'require-approval', reason? }`],
    example: `const guard = policyGuard(journal, { fallback: 'allow' });
await runDurable({ runId, journal, model, tools, guard, prompt });

// Live update from Studio:
// PUT /policy { "rules": [{ "tool": "send_email", "action": "require-approval" }] }`,
  },
  {
    slug: `evals-scorers`,
    order: 14,
    title: `Evaluation: scorer & LLM-judge`,
    oneLiner: `Scores runs deterministically from the journal trace.`,
    tier: `core`,
    package: `@gnldev/evals`,
    install: `pnpm add @gnldev/evals @gnldev/durable ai`,
    apis: [`scoreRun(reader, runId, scorers, opts) — scores deterministically from the journal trace`, `exactMatch / contains / regexScore / embeddingSimilarity — rule-based scorers`, `llmJudge({ model, rubric }) — LLM-judge scorer (memoized)`, `evalDataset({ dataset, run, scorers, journal? }) — batch/resumable suite`],
    example: `const res = await scoreRun(reader, runId, [
  exactMatch(),
  llmJudge({ model, rubric: 'Is the answer correct and short?' }),
], { expected: 'Paris' });
// Res.scores -> { 'exact-match': { score, reason }, 'llm-judge': { score, reason } }`,
  },
  {
    slug: `eval-gate`,
    order: 15,
    title: `Eval gate (promote governance)`,
    oneLiner: `No promote without passing the suite (412).`,
    tier: `studio`,
    package: `@gnldev/studio`,
    install: `import { createStudioApp } from '@gnldev/studio';
import type { StudioDatasets, EvalDatasetResultLike } from '@gnldev/studio';
import { evalDataset } from '@gnldev/evals';`,
    apis: [`StudioAppOptions.evalGate — { datasetId, minAvg? } (if given, gates promote)`, `StudioDatasets — { list(), run(id) } contract supplied by the host`, `POST /managed-agents/:name/promote — 412 without passing the suite if evalGate is enabled`],
    example: `app.mount('/studio', createStudioApp({
  reader: toJournal(storage.runs),
  gnl: createStudioRunner(gnl, config, { toJsonSchema: aiToolSchema }),
  datasets,                                     // required — evalGate returns 501 without it
  evalGate: { datasetId: 'regression', minAvg: 0.7 },
  auth,
}));`,
  },
  {
    slug: `agent-versioning`,
    order: 16,
    title: `Agent versioning`,
    oneLiner: `Keep agent versions in the journal, activate via promote.`,
    tier: `studio`,
    package: `@gnldev/studio`,
    install: `import { createStudioApp } from '@gnldev/studio';`,
    apis: [`POST /managed-agents — { name, model, system?, maxSteps?, note? } adds a new version`, `POST /managed-agents/:name/promote — { version } changes the active version`, `GET /managed-agents — version history + active version number`],
    example: `// POST /studio/api/managed-agents
{ "name": "support-bot", "model": "gpt-4o-mini", "system": "Give short and polite answers.", "maxSteps": 4 }
// > { ok: true, name: "support-bot", version: 2, active: 1 }

// POST /studio/api/managed-agents/support-bot/promote
{ "version": 2 } // -> { ok: true, active: 2, previous: 1 }`,
  },
  {
    slug: `retention-ttl`,
    order: 17,
    title: `Retention TTL sweep`,
    oneLiner: `Bulk-cleans old runs by age (sweepRuns).`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { sweepRuns } from '@gnldev/durable';`,
    apis: [`sweepRuns(journal, { olderThanMs, keepSuspended? }) — bulk-deletes old runs`, `SweepResult — { scanned, purged, keptSuspended, keptNoTs, deletedEntries }`, `purgeRun — the single-run deletion helper used internally by sweepRuns`],
    example: `const result = await sweepRuns(journal, { olderThanMs: 30 * 86_400_000 }); // 30 days
// Suspended (awaiting approval) runs are kept via keepSuspended (default true)

// Studio: POST /retention/sweep { "olderThanMs": 2592000000 }`,
  },
  {
    slug: `gdpr-purge`,
    order: 18,
    title: `GDPR / PII deletion (purge)`,
    oneLiner: `Permanently delete a run/thread's journal trace (purgeRun/purgeThread).`,
    tier: `core`,
    package: `@gnldev/durable`,
    install: `import { purgeRun, purgeThread } from '@gnldev/durable';`,
    apis: [`purgeRun(journal, runId) — permanently deletes ALL trace of a run (the only exception to append-only)`, `purgeThread(journal, threadId) — deletes a thread's BasicMemory trace`, `sweepRuns — bulk purgeRun based on retention policy`],
    example: `const removed = await purgeRun(journal, 'run-123');
// Removed: number of journal keys deleted

// Studio: DELETE /runs/:id -> { ok: true, deleted: <count> }`,
  },
  {
    slug: `signed-license`,
    order: 19,
    title: `Signed license (Enterprise)`,
    oneLiner: `Validates an Ed25519-signed license; fail-closed boot.`,
    tier: `ee`,
    package: `@gnldev/auth-ee`,
    install: `import {
  createEnterpriseAuth,
  generateLicenseKeys,
  signLicense,
  validateLicense,
  assertLicensed,
} from '@gnldev/auth-ee';`,
    apis: [`generateLicenseKeys() — generates an Ed25519 key pair (vendor, one-time)`, `signLicense(payload, privateKey) — generates a signed license key`, `validateLicense(key, { publicKey }) — returns LicenseInfo (offline validation)`, `createEnterpriseAuth(opts) — returns a premium AuthProvider if the license is valid`],
    example: `const auth = createEnterpriseAuth({
  licenseKey: process.env.GNL_LICENSE_KEY,
  publicKey: process.env.GNL_EE_PUBLIC_KEY,
  failClosed: true,
  fallback: roleAuth({ admin: { token: ADMIN_TOKEN } }),
});`,
  },
  {
    slug: `multi-organization`,
    order: 20,
    title: `Multi-organization (organization isolation)`,
    oneLiner: `Each request scoped to an isolated organization journal; tied to identity, 403 on mismatch.`,
    tier: `ee`,
    package: `@gnldev/server`,
    install: `npm install @gnldev/server @gnldev/durable @gnldev/auth-ee`,
    apis: [`withOrg(journal, orgId) — scopes the journal with an 'org:<orgId>:' prefix`, `RestApiOptions.org — opt-in multi-organization (createRestApi option name; concept: organization scope)`, `OrgOptions — { resolve?, required? } (defaults to the x-gnl-org header)`],
    example: `app.mount('/api', createRestApi(config, {
  title: 'SWAPI Pro',
  auth,
  org: {},   // every request lands on an organization journal scoped via withOrg
}));
// Identity tied to an organization (Cred.orgId) overrides the header, 403 on mismatch`,
  },
  {
    slug: `budget-quota`,
    order: 21,
    title: `Budget & quota (402)`,
    oneLiner: `Organization token/cost limit; new runs get 402 when exceeded.`,
    tier: `ee`,
    package: `@gnldev/server`,
    install: `import { createGnl } from '@gnldev/durable';
import { createRestApi } from '@gnldev/server';
import { checkBudget, assertBudget, getOrgUsage, BudgetExceededError } from '@gnldev/durable';`,
    apis: [`RestApiOptions.budgets — { default?, perOrg? } (journal __budget__ overrides this)`, `checkBudget / assertBudget — checks / throws on limit overage`, `getOrgUsage — returns the organization's total runs/tokens/costUsd (O(1))`, `recordRunUsage — adds to the __usage__ counter when a run completes (idempotent)`],
    example: `app.mount('/api', createRestApi(config, {
  auth,
  org: {},
  budgets: { default: { tokenLimit: 100_000 }, perOrg: { 'acme-corp': { usdLimit: 25 } } },
}));
// New run/stream/workflow requests get 402 when exceeded (resume is free)`,
  },
  {
    slug: `rbac`,
    order: 22,
    title: `RBAC (role-based authorization)`,
    oneLiner: `Resource/action authorization via role→permission mapping.`,
    tier: `ee`,
    package: `@gnldev/auth-ee`,
    install: `import { createRbac, createEnterpriseAuth } from '@gnldev/auth-ee';
import type { Permission, RbacProvider } from '@gnldev/auth-ee';`,
    apis: [`createRbac(roleGrants?) — defaults to { admin: ['*'], viewer: ['*:read'] }`, `Permission — 'resource:action' pattern (e.g. 'runs:read', '*:read', '*')`, `permissionMatches(granted, required) — wildcard (*)-supported matching`],
    example: `const rbac = createRbac({ editor: ['runs:read', 'runs:write'], viewer: ['*:read'] });
const auth = createEnterpriseAuth({ licenseKey, rbac, fallback });
// Authorize(principal, ctx) -> { allow: true } | { allow: false, status: 403 }`,
  },
  {
    slug: `sso`,
    order: 23,
    title: `SSO (OAuth/OIDC/SAML/JWT)`,
    oneLiner: `Resolves an enterprise identity provider to a Principal.`,
    tier: `ee`,
    package: `@gnldev/auth-ee`,
    install: `import { createJwtSso, createEnterpriseAuth } from '@gnldev/auth-ee';`,
    apis: [`createJwtSso({ secret|publicKey, issuer?, audience? }) — validates the JWT and produces a Principal`, `SsoProvider — { authorizeUrl, handleCallback, principalFromRequest }`, `createAuth0Sso / createWorkOsSso — full OAuth/OIDC providers (redirect → callback → token exchange + JWKS signature verification)`],
    example: `const sso = createJwtSso({
  publicKey: process.env.SSO_JWT_PUBLIC_KEY,
  issuer: 'https://idp.example.com',
  audience: 'gnl-api',
});
const auth = createEnterpriseAuth({ licenseKey, sso, fallback });`,
  },
  {
    slug: `user-store`,
    order: 24,
    title: `User management (journal-backed)`,
    oneLiner: `Token→Principal; hashed in the journal; Studio Users.`,
    tier: `ee`,
    package: `@gnldev/auth-ee`,
    install: `import { createEnterpriseAuth, createJournalUserStore, createJournalAuditSink } from '@gnldev/auth-ee';
import { toJournal } from '@gnldev/durable';`,
    apis: [`createJournalUserStore(journal) — bearer token → Principal, hashed in the journal`, `JournalUserStore — authenticate(token), list(), create(input), revoke(id)`, `EeUserRecord/EeUserPublic — record shape (token only appears once, in the create() return)`],
    example: `const userStore = createJournalUserStore(toJournal(storage.runs));
const { token } = await userStore.create({ email: 'acme-viewer@example.com', roles: ['viewer'], orgId: 'acme' });
// Token: 'eeu_...' — returned ONLY HERE`,
  },
  {
    slug: `audit-log`,
    order: 25,
    title: `Audit log`,
    oneLiner: `Authorization decisions + management actions persisted, with a non-spoofable actor.`,
    tier: `ee`,
    package: `@gnldev/auth-ee`,
    install: `import { createEnterpriseAuth, createJournalAuditSink, consoleAuditSink } from '@gnldev/auth-ee';
import { toJournal } from '@gnldev/durable';`,
    apis: [`createJournalAuditSink(journal) — writes every authorization decision permanently to the journal`, `readJournalAudit(journal) — returns written AuditEvents, newest first`, `AuditEvent — { ts, principalId?, orgId?, path, method, action, allowed }`],
    example: `const auth = createEnterpriseAuth({
  licenseKey,
  audit: createJournalAuditSink(toJournal(storage.runs)),
  fallback,
});
// Studio's own management-action log: GET /audit?limit=200&action=policy.update`,
  },
];

/** slug -> DocFeature quick lookup map. */
export const FEATURES_BY_SLUG: Record<string, DocFeature> = Object.fromEntries(
  FEATURES.map((f) => [f.slug, f]),
);
