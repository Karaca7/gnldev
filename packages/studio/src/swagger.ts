// OpenAPI spec (compact, hand-written) + Swagger UI HTML (CDN). createStudioApp/Admin serves /openapi.json + /swagger.
// apiBase is known (the mount prefix) → spec.servers + the swagger url get the correct prefix (e.g. /studio/api).

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

export function openapiSpec(apiBase = '') {
  const base = (apiBase ? apiBase.replace(/\/$/, '') : '') + '/api';
  return {
    openapi: '3.0.0',
    info: { title: 'gnl studio API', version: '1', description: 'Durable run inspector + playground API' },
    servers: [{ url: base }],
    paths: {
      '/capabilities': P('get', 'Studio capabilities'),
      '/metrics': P('get', 'Aggregate metrics (run/cost/token)'),
      '/runs': P('get', 'Run summaries'),
      '/runs/{id}': P('get', 'Run journal entries', idParam),
      '/runs/{id}/state': P('get', 'Step N state (time-travel)', [...idParam, { name: 'step', in: 'query', schema: { type: 'integer' } }]),
      '/runs/{id}/diff': P('get', 'Step N vs N-1 diff', idParam),
      '/runs/{id}/cost': P('get', 'Cost/tokens', idParam),
      '/runs/{id}/trace': P('get', 'OTEL trace spans', idParam),
      '/runs/{id}/fork': P('post', 'Fork a run from a step', idParam, true),
      '/runs/{id}/resume': P('post', 'Approval → resume', idParam, true),
      '/runs/{id}/score': P('post', 'Score a run with scorers', idParam, true),
      '/agents': P('get', 'Agent list'),
      '/agents/{name}/run': P('post', 'Run an agent', nameParam, true),
      '/agents/{name}/stream': P('post', 'Agent streaming (SSE)', nameParam, true),
      '/tools': P('get', 'Tool list'),
      '/tools/{name}/execute': P('post', 'Tool test-run', nameParam, true),
      '/workflows': { ...P('get', 'Workflow list (code + managed)'), ...P('post', 'Create a managed workflow', [], true) },
      '/workflows/{name}/run': P('post', 'Run a workflow (code or managed)', nameParam, true),
      '/workflows/{name}/run-stream': P('post', 'Run a workflow live (SSE)', nameParam, true),
      '/workflows/run/{runId}': P('get', 'Workflow run state (step outputs + suspend)', [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }]),
      '/workflows/{name}/runs': P('get', 'Workflow run history', [...nameParam, { name: 'limit', in: 'query', schema: { type: 'integer' } }]),
      '/workflows/{name}/def': P('get', 'Managed workflow definition', nameParam),
      '/workflows/{name}': { ...P('put', 'Update a managed workflow', nameParam, true), ...P('delete', 'Delete a managed workflow', nameParam) },
      '/threads': P('get', 'Memory thread list'),
      '/threads/{id}': { ...P('patch', 'Rename a thread', idParam, true), ...P('delete', 'Delete a thread', idParam) },
      '/threads/{id}/messages': P('get', 'Thread messages', idParam),
      '/threads/{id}/working-memory': P('get', 'Thread working memory', idParam),
      '/jobs': P('get', 'Queue/jobs list'),
      '/jobs/{id}/retry': P('post', 'Re-queue a failed (dead-letter) job', idParam, true),
      '/knowledge/search': P('post', 'Vector search', [], true),
      '/scorers': P('get', 'Scorer list'),
      '/datasets': P('get', 'Eval dataset list'),
      '/datasets/{id}/run': P('post', 'Run a dataset eval suite', idParam, true),
      '/a2a-network': P('get', 'A2A call edges'),
      '/mcp-servers': P('get', 'MCP server + tool list'),
    },
  };
}

export function swaggerHtml(apiBase = '') {
  const specUrl = (apiBase ? apiBase.replace(/\/$/, '') : '') + '/openapi.json';
  return `<!doctype html><html><head><meta charset="utf-8"><title>gnl studio · API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>body{margin:0}</style></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:'${specUrl}',dom_id:'#ui'});</script>
</body></html>`;
}
