// OpenAPI spec (compact, hand-written) + Swagger UI HTML (CDN). createStudioApp/Admin serves /openapi.json + /swagger.
// ApiBase is known (the mount prefix) → spec.servers + the swagger url get the correct prefix (e.g. /studio/api).

const P = (method: string, summary: string, params: any[] = [], body = false) => ({
  [method]: {
    summary,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
    responses: { '200': { description: 'OK' } },
  },
});
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
const nameParam = [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }];
const otherIdParam = [{ name: 'otherId', in: 'path', required: true, schema: { type: 'string' } }];
const versionParam = [{ name: 'version', in: 'path', required: true, schema: { type: 'integer' } }];
const runIdParam = [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }];
/** Query-parameter shorthand (default type: string). */
const q = (name: string, type = 'string') => ({ name, in: 'query', schema: { type } });

/**
 * `cursor` is an OPAQUE continuation token: send back exactly what `nextCursor` gave you, and never
 * construct, parse or do arithmetic on one.
 *
 * It was published here as `integer`, which was true of the implementation and false as a contract.
 * A reader who took that at face value could compute `cursor = page * limit` — and the server has
 * already stopped meaning that once (`/runs` now anchors from the other end of the list), while the
 * fix that actually closes paging drift moves it to a `created_at`+`runId` key, i.e. a string. Every
 * such change is breaking for anyone who believed the `integer`, and free for anyone who believed
 * this. Declaring the narrower type bought nothing and mortgaged the wider one.
 *
 * `@gnldev/server` already declares it `string` (see `packages/server/src/openapi.ts`); this makes
 * the two specs agree.
 */
const cursorParam = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque continuation token — pass back the `nextCursor` from the previous page verbatim. Do not parse or compute it.',
  schema: { type: 'string' },
};

export function openapiSpec(apiBase = '') {
  const base = (apiBase ? apiBase.replace(/\/$/, '') : '') + '/api';
  return {
    openapi: '3.0.0',
    info: { title: 'gnl studio API', version: '1', description: 'Durable run inspector + playground API' },
    servers: [{ url: base }],
    paths: {
      '/capabilities': P('get', 'Studio capabilities'),
      '/metrics': P('get', 'Aggregate metrics (run/cost/token)', [q('days', 'integer')]),
      '/metrics/runs': P('get', 'Per-run metric rows (time-series + latency table)', [q('limit', 'integer')]),
      // API-09: status/agent/q filter the run set; total in the response reflects the FILTERED count.
      '/runs': P('get', 'Run summaries (paginated with ?limit; total reflects status/agent/q filters when set)', [q('limit', 'integer'), cursorParam, q('status'), q('agent'), q('q')]),
      '/runs/{id}': { ...P('get', 'Run journal entries', idParam), ...P('delete', 'GDPR/PII purge — permanently delete all trace of a run', idParam) },
      '/runs/{id}/state': P('get', 'Step N state (time-travel)', [...idParam, q('step', 'integer')]),
      '/runs/{id}/memory-context': P('get', 'Memory provenance for the turn (recall hits + similarity, recent window, WM/OM, echo-trim) — null when not recorded', idParam),
      '/runs/{id}/diff': P('get', 'Step N vs N-1 diff', idParam),
      '/runs/{id}/cost': P('get', 'Cost/tokens', idParam),
      '/runs/{id}/scores': P('get', 'Runtime scorer results (memoized proc:eval records)', idParam),
      '/runs/{id}/processors': P('get', 'Compliance/processor findings (pii/moderation/prompt-injection)', idParam),
      '/runs/{id}/incidents': P('get', 'Guard incidents (loop detection/duplicate guard/maxToolCalls)', idParam),
      '/runs/{id}/network': P('get', 'Dynamic agent network trace (router → agent → result)', idParam),
      '/runs/{id}/trace': P('get', 'OTEL trace spans', idParam),
      '/runs/{id}/regression/{otherId}': P('get', 'Diff two existing runs (decision-point level, read-only)', [...idParam, ...otherIdParam]),
      '/runs/{id}/fork': P('post', 'Fork a run from a step', idParam, true),
      '/runs/{id}/resume': P('post', 'Approval → resume', idParam, true),
      '/runs/{id}/cancel': P('post', 'Durably cancel a run (cross-worker flag, checked at the next model step)', idParam),
      '/runs/{id}/compensate': P('post', "Unwind an abandoned run's side effects (saga compensation); dryRun previews only", idParam, true),
      '/runs/{id}/regression': P('post', 'Replay a run with a new model/system + decision-point diff', idParam, true),
      '/runs/{id}/otel-export': P('post', 'Export a run trace to the host-configured OTLP target', idParam),
      '/runs/{id}/score': P('post', 'Score a run with scorers', idParam, true),
      '/approvals': P('get', 'Pending tool approvals across all suspended runs (inbox)'),
      '/audit': P('get', 'Audit trail (governance log), newest first', [q('limit', 'integer'), q('action'), q('q'), q('org')]),
      '/retention/sweep': P('post', 'Retention sweep — permanently purge old runs per policy', [], true),
      '/organizations': { ...P('get', 'Organization list (usage/cost + budget status)'), ...P('post', 'Register a new organization', [], true) },
      '/organizations/{id}': P('delete', 'GDPR/cleanup — permanently delete an organization', idParam),
      '/organizations/{id}/budget': P('put', "Set/clear an organization's budget ('default' = fallback for all orgs)", idParam, true),
      '/me': P('get', 'The logged-in principal (identity + org scope)'),
      '/permissions/catalog': P('get', 'Fine-grained permission catalog + role presets (read-only)'),
      '/users': { ...P('get', 'User (member) list'), ...P('post', 'Create a user (token returned once)', [], true) },
      '/users/{id}': { ...P('patch', "Update a user's roles/explicit permissions", idParam, true), ...P('delete', 'Delete a user', idParam) },
      '/users/{id}/revoke': P('post', "Revoke a user's token without deleting the user", idParam),
      '/auth/sse-ticket': P('post', 'Issue a single-use SSE ticket (60s TTL, for /events)'),
      // API-04: informative payload — event `change`, data `{"runIds":[...],"at":<epoch ms>}` naming
      // The runs that changed (added/edited/removed) since the last event; a legacy plain `data:'runs'`
      // Is still sent when the journal has no cheap countRunsByStatus aggregate to diff against.
      '/events': P('get', "SSE — event 'change', data {runIds,at} naming the runs that changed (legacy plain 'runs' payload as a fallback)", [q('ticket')]),
      '/policy': { ...P('get', 'Get the global tool policy'), ...P('put', "Update the global tool policy ({ rules, ifVersion? }); 409 version_conflict if ifVersion is stale", [], true) },
      '/chat': P('post', 'Live chat (admin)', [], true),
      '/agents': P('get', 'Agent list'),
      '/agents/registry': P('get', 'Agent approval registry (code-defined agents recorded at boot)'),
      '/agents/registry/{name}/approve': P('post', 'Approve a registered agent', nameParam, true),
      '/agents/registry/{name}/block': P('post', 'Block a registered agent', nameParam, true),
      '/agents/{name}/run': P('post', 'Run an agent', nameParam, true),
      '/agents/{name}/stream': P('post', 'Agent streaming (SSE)', nameParam, true),
      '/tools': P('get', 'Tool list'),
      '/tools/{name}/execute': P('post', 'Tool test-run', nameParam, true),
      '/workflows': { ...P('get', 'Workflow list (code + managed)'), ...P('post', 'Create a managed workflow', [], true) },
      '/workflows/{name}/run': P('post', 'Run a workflow (code or managed)', nameParam, true),
      '/workflows/{name}/run-stream': P('post', 'Run a workflow live (SSE)', nameParam, true),
      '/workflows/{name}/runs/{id}/fork': P('post', 'What-if fork a workflow run from step N', [...nameParam, ...idParam], true),
      '/workflows/run/{runId}': P('get', 'Workflow run state (step outputs + suspend)', runIdParam),
      '/workflows/{name}/runs': P('get', 'Workflow run history', [...nameParam, q('limit', 'integer')]),
      // D3-A: cross-workflow run registry; items may carry an optional workflowName (mirrored from the wfrun: record).
      // API-03: `limit`/`cursor` opt into a bounded, paged `{items,nextCursor}` response; omitted → the
      // Legacy flat array (backward-compatible for older callers).
      '/workflows/runs': P('get', 'Cross-workflow run registry (suspended/completed/canceled); items may include workflowName; paginated with ?limit (flat array when omitted)', [q('status'), q('limit', 'integer'), cursorParam]),
      '/workflows/runs/{id}/cancel': P('post', 'Durably cancel a workflow run', idParam),
      '/workflows/{name}/def': P('get', 'Managed workflow definition', nameParam),
      '/workflows/{name}': { ...P('put', 'Update a managed workflow', nameParam, true), ...P('delete', 'Delete a managed workflow', nameParam) },
      '/threads': P('get', 'Memory thread list', [q('resourceId')]),
      '/threads/{id}': { ...P('patch', 'Rename a thread', idParam, true), ...P('delete', 'Delete a thread', idParam) },
      '/threads/{id}/messages': {
        ...P('get', 'Thread messages', idParam),
        // AfterIndex is INCLUSIVE (the message at afterIndex + every one after it is deleted); -1 = the whole thread.
        ...P('delete', "Truncate a thread from a message index onward ({ afterIndex }, inclusive; -1 = all); 200 { ok, removed } / 400 if afterIndex missing / 501 if not supported", idParam, true),
      },
      '/threads/{id}/working-memory': P('get', 'Thread working memory', idParam),
      '/jobs': P('get', 'Queue/jobs list'),
      '/jobs/{id}/retry': P('post', 'Re-queue a failed (dead-letter) job', idParam, true),
      '/cache/stats': P('get', 'Cache hit/miss ratio + size'),
      '/cache/invalidate': P('post', 'Invalidate a cache key (or all known keys if omitted)', [], true),
      '/scheduler/triggers': P('get', 'Scheduler trigger introspection (read-only)'),
      '/knowledge/search': P('post', 'Vector search', [], true),
      '/scorers': P('get', 'Scorer list'),
      '/datasets': P('get', 'Eval dataset list'),
      '/datasets/{id}/run': P('post', 'Run a dataset eval suite', idParam, true),
      '/managed-agents': { ...P('get', 'Managed agent version list'), ...P('post', 'Create a new managed agent version', [], true) },
      '/managed-agents/{name}/promote': P('post', 'Promote a managed agent version to prod (runs the eval gate if configured)', nameParam, true),
      '/managed-agents/{name}': P('delete', 'Delete a managed agent record (all versions)', nameParam),
      '/managed-agents/{name}/versions/{version}': P('delete', 'Delete a single managed agent version (409 if it is the active one)', [...nameParam, ...versionParam]),
      '/a2a-network': P('get', 'A2A call edges'),
      '/mcp-servers': P('get', 'MCP server + tool list'),
    },
  };
}

/**
 * Swagger UI is third-party code executing on the SAME ORIGIN as the studio admin API, and the studio
 * Keeps its bearer token in localStorage there (studio-ui/src/auth.ts). So whatever this page loads can
 * Read that token and drive the admin API — purge runs, promote managed agents, invalidate caches.
 *
 * It used to load `swagger-ui-dist@5` — a FLOATING major — from unpkg, with no integrity check and no
 * CSP. Anyone able to publish a 5.x, or to tamper with what unpkg served, would have been running code
 * In that position. Pinned to an exact version and bound by SRI, the browser now refuses any bytes that
 * Are not the ones these hashes describe; the CSP below then admits, as script, only that one file (by
 * Its hash) and the one nonced bootstrap.
 *
 * TO UPGRADE: change SWAGGER_UI_VERSION and recompute BOTH hashes, or the page will (correctly) refuse
 * To load:
 *   curl -sL https://unpkg.com/swagger-ui-dist@<version>/<file> | openssl dgst -sha384 -binary | openssl base64 -A
 *
 * Residual risk, stated plainly: this closes tampering, not availability — if unpkg is unreachable the
 * Page does not render. A deployment that wants no third-party origin at all should vendor
 * `swagger-ui-dist` and serve it locally; the spec at /openapi.json is complete on its own and can be
 * Pointed at any external OpenAPI client.
 */
export const SWAGGER_UI_VERSION = '5.32.13';
const SWAGGER_UI_CSS_SRI = 'sha384-tRpWwikYYdk1+1Mu0osh0Tz/Ay5xgS+s/Nf2Aa7GVAFtZLFdJlAbozfrq4g+xHBK';
const SWAGGER_UI_JS_SRI = 'sha384-PsJla434CobCNv3y1K4wRavOqkUAvwGEQEfbUmI98CCqqGCJsmuDsgIjM6ZQQODP';
const SWAGGER_UI_ORIGIN = 'https://unpkg.com';

/**
 * The page's own CSP, carried in a meta tag so it applies wherever the HTML is served from (the studio
 * Mounts /swagger on two routes) without depending on a proxy to add a header. `connect-src 'self'`
 * Keeps the spec fetch (and any "try it out" call) on this origin: injected code cannot exfiltrate to
 * An outside host. `object-src`/`base-uri` 'none' close the usual bypasses.
 *
 * `script-src` names no origin at all. An origin allowlist (`script-src https://unpkg.com`) would have
 * Admitted ANY path on unpkg — an injected `<script src="https://unpkg.com/…">` runs, because an origin
 * Source does not require integrity. Nothing can inject here today (the template is static and apiBase
 * Is operator config), so this is defence in depth rather than a live hole; it costs one constant.
 * Instead the policy carries the bundle's own sha384 as a CSP3 hash-source. For an EXTERNAL script a
 * Hash-source only matches when the tag carries an `integrity` attribute whose digest equals it (CSP3
 * "external hashes"), so the tag below must keep its integrity= — the same hash, named once.
 *
 * Deliberate asymmetry: `style-src` still names the origin. Hash-sources for external stylesheets have
 * Spottier CSP3 support, and a stylesheet cannot reach the bearer token the way a script can.
 *
 * Browser support: hash-sources for external scripts land in current Chrome/Firefox/Safari. A browser
 * That does not implement them ignores the hash, matches nothing, and BLOCKS the bundle — the page
 * Fails closed (no Swagger UI, the spec still readable at /openapi.json) rather than open. For an admin
 * Page holding the token that is the right side to fail on.
 */
function swaggerCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src '${SWAGGER_UI_JS_SRI}' 'nonce-${nonce}'`,
    `style-src ${SWAGGER_UI_ORIGIN} 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function swaggerHtml(apiBase = '', nonce = randomNonce()) {
  const specUrl = (apiBase ? apiBase.replace(/\/$/, '') : '') + '/openapi.json';
  const base = `${SWAGGER_UI_ORIGIN}/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>gnl studio · API</title>
<meta http-equiv="Content-Security-Policy" content="${swaggerCsp(nonce)}">
<link rel="stylesheet" href="${base}/swagger-ui.css" integrity="${SWAGGER_UI_CSS_SRI}" crossorigin="anonymous">
<style>body{margin:0}</style></head><body><div id="ui"></div>
<script src="${base}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_JS_SRI}" crossorigin="anonymous"></script>
<script nonce="${nonce}">window.ui=SwaggerUIBundle({url:'${specUrl}',dom_id:'#ui'});</script>
</body></html>`;
}

/** Per-response nonce — a constant would let injected markup simply reuse it. */
function randomNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^a-zA-Z0-9]/g, '');
}
