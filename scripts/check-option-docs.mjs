// Every option a deployment can set must be NAMED in the documentation.
//
// `check-doc-samples.mjs` typechecks the code blocks that ARE written — its header records the three
// defects it was built for, and all three are "documented but wrong". The other direction had no gate,
// and the cost was measured: `subjectBinding` was the switch that closed a cross-subject read, and
// the string appeared in ZERO .md files. No README, no CHANGELOG, no docs/. A deployment could not
// learn the switch existed without reading the type definition — and the protections matrix printed
// `✓ identity bound` meanwhile. (The switch is gone since: end users are bound by default.)
//
// BASELINE, not zero. Repo-wide there are 386 exported `*Options` fields and 54 were unnamed when this
// was written; failing on all of them would have meant the gate could not land, which is how a gate
// becomes a `|| true` in CI. The list below is that debt, written down. It may only SHRINK: a field
// added to it fails review, a field removed from it is documentation that got written. A NEW option
// that nobody documented fails immediately, which is the case that cost us the switch above.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Documented nowhere when this gate was written. Shrinks only. See the header. */
const BASELINE = new Set([
  'auth-ee/Auth0SsoOptions.clientSecret', 'auth-ee/Auth0SsoOptions.redirectUri',
  'auth-ee/Auth0SsoOptions.claimMap', 'auth-ee/Auth0SsoOptions.validateState',
  'auth-ee/Auth0SsoOptions.jwks', 'auth-ee/Auth0SsoOptions.jwksTtlMs',
  'auth-ee/WorkOsSsoOptions.redirectUri', 'auth-ee/WorkOsSsoOptions.validateState',
  'auth-ee/JwtSsoOptions.claimMap', 'cli/ScaffoldOptions.hostMode',
  'deploy/NodeAdapterOptions.onListen', 'deploy/BundleOptions.esTarget',
  'deploy/TargetOptions.exportName', 'durable/ToolCallingModelOptions.doneText',
  'durable/RunNetworkOptions.routerModel', 'durable/RedisStorageOptions.replicationWarning',
  'durable/RunOptions.topP', 'durable/RunOptions.abortSignal', 'durable/LogSweepOptions.markerFor',
  'durable/AssertSuiteConsistentOptions.onMismatch', 'durable/AssertSuiteConsistentOptions.fromDir',
  'evals/EvalDatasetOptions.itemTimeoutMs', 'evals/LlmJudgeOptions.sampleFields',
  'evals/TrajectoryScorerOptions.expectedTools', 'evals/TrajectoryScorerOptions.requiredTools',
  'evals/TrajectoryScorerOptions.forbiddenTools', 'mcp/RateWindowOptions.sweepAt',
  'otel/LiveObservabilityOptions.sampleRate', 'otel/LiveObservabilityOptions.onCost',
  'otel/LiveObservabilityOptions.maxPendingRuns', 'otel/ToOtlpMetricsOptions.startTime',
  'otel/OtlpRetryOptions.retryOn', 'processors/TokenLimiterOptions.maxInputTokens',
  'processors/TokenLimiterOptions.countTokens', 'processors/TokenLimiterOptions.keepSystem',
  'processors/ToolSearchOptions.minScore', 'rag/GraphRagOptions.hops', 'rag/GraphRagOptions.decay',
  'rag/GraphRagOptions.seeds', 'rag/PostgresVectorStoreOptions.dimension', 'rag/QueryOptions.minScore',
  'rag/QueryOptions.keywordWeight', 'scheduler/WorkflowWakerOptions.jitterMs',
  'scheduler/WorkflowWakerOptions.wakeEvented', 'semantic-qualify/QualifyOptions.onProgress',
  'server/OrgOptions.requireRegistration', 'server/OrgOptions.maxInstances',
  'server/RestApiOptions.protectionsBanner', 'studio/MakeRunnerOptions.toJsonSchema',
  'studio/StudioApiOptions.evalGate', 'studio/StudioApiOptions.modelSuggestions',
  'studio/StudioApiOptions.regressionModel', 'studio/StudioApiOptions.otelExport',
]);

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.comprehension']);
const docs = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) docs.push(readFileSync(p, 'utf8'));
  }
})('.');
const prose = docs.join('\n');

const unnamed = [];
let total = 0;
for (const pkg of readdirSync('packages')) {
  const dir = join('packages', pkg, 'src');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    // Top-level fields only (two-space indent): a nested shape's members are documented with their
    // parent, and matching them would flag `retention.olderThanMs` as if it were its own option.
    for (const iface of src.matchAll(/export interface (\w*Options)\s*\{([\s\S]*?)\n\}/g)) {
      for (const field of iface[2].matchAll(/^ {2}(\w+)\??[?:]/gm)) {
        total++;
        const id = `${pkg}/${iface[1]}.${field[1]}`;
        if (new RegExp(`\\b${field[1]}\\b`).test(prose)) continue;
        if (BASELINE.has(id)) continue;
        unnamed.push(id);
      }
    }
  }
}

const stale = [...BASELINE].filter((id) => {
  const field = id.slice(id.lastIndexOf('.') + 1);
  return new RegExp(`\\b${field}\\b`).test(prose);
});

if (unnamed.length) {
  console.error(`\ncheck-option-docs: ${unnamed.length} option(s) a deployment can set are named in no .md file.\n`);
  for (const id of unnamed) console.error(`  ${id}`);
  console.error('\nName each one in a README, a guide, or docs/. An option nobody can discover is an option\nnobody turns on — and the one that cost us this gate closed a cross-subject read.\n');
  process.exit(1);
}
if (stale.length) {
  console.error(`\ncheck-option-docs: ${stale.length} baseline entr(ies) are documented now — delete them from BASELINE.\n`);
  for (const id of stale) console.error(`  ${id}`);
  console.error('\nThe baseline may only shrink; a stale entry lets the next undocumented option hide behind it.\n');
  process.exit(1);
}
console.log(`check-option-docs: ${total} options, all named (${BASELINE.size} carried in the baseline).`);
