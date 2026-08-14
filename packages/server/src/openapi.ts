// Generate an OpenAPI 3.1 schema from the createGnl agent + workflow registry (auto-docs).

export function buildOpenApi(agentNames: string[], workflowNames: string[] = [], title = 'gnl agents'): any {
  const runBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['runId'],
          properties: {
            runId: { type: 'string', description: 'Idempotency key (exactly-once)' },
            prompt: { type: 'string' },
            messages: { type: 'array', items: { type: 'object' } },
            threadId: { type: 'string' },
            approvals: { type: 'object', additionalProperties: { type: 'boolean' } },
          },
        },
      },
    },
  };
  const runResponse = {
    '200': {
      description: 'Durable run result',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              runId: { type: 'string' },
              text: { type: 'string' },
              interrupts: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
    // Decision #1: run-limit exceeded — the request is valid but couldn't be processed with the given
    // `limits`; deterministic (retry DOESN'T HELP), `limits` can be raised and resumed with the SAME runId (resumable:true).
    '422': {
      description: 'Run limit exceeded (RunLimitExceededError/ToolLoopDetectedError) — can continue with the same runId after raising limits',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              code: { type: 'string', enum: ['run_limit_exceeded', 'tool_loop_detected'] },
              detail: { type: 'object' },
              resumable: { type: 'boolean' },
            },
          },
        },
      },
    },
  };

  const paths: Record<string, any> = {};
  // Documented as unauthenticated on purpose — see the route comments in index.ts. An orchestrator
  // Reading this spec needs to know it can probe these without arranging a credential first.
  paths['/health'] = {
    get: {
      summary: 'Liveness — is the process alive? No storage access; unauthenticated',
      description: 'Point LIVENESS probes here. Deliberately independent of storage: a failing database must not cause a healthy process to be killed and restarted.',
      responses: { '200': { description: '{ status: "ok", uptimeSec }' } },
    },
  };
  paths['/ready'] = {
    get: {
      summary: 'Readiness — can it serve traffic? Touches storage; unauthenticated',
      description: 'Point READINESS/traffic probes here. Returns 503 when the journal is unreachable or does not answer within the probe budget, so the instance leaves the load balancer while staying alive to recover. The underlying error is never returned (it can carry connection details) — it goes to the logs.',
      responses: {
        '200': { description: '{ status: "ready" }' },
        '503': { description: '{ status: "unavailable", storage: "unreachable" }' },
      },
    },
  };
  paths['/agents'] = {
    get: { summary: 'List of registered agent metadata', responses: { '200': { description: 'AgentMeta list' } } },
  };
  for (const n of agentNames) {
    paths[`/agents/${n}/run`] = {
      post: { summary: `Run the '${n}' agent durably`, requestBody: runBody, responses: runResponse },
    };
    paths[`/agents/${n}/stream`] = {
      post: {
        summary: `Run the '${n}' agent durably + streaming (SSE)`,
        requestBody: runBody,
        responses: {
          '200': {
            description: 'SSE stream: text-delta/tool-call/tool-result/interrupt/done events',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    };
    paths[`/agents/${n}/resume`] = {
      post: {
        summary: `Resume the '${n}' agent with runId + approvals`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['runId'],
                properties: {
                  runId: { type: 'string' },
                  approvals: { type: 'object', additionalProperties: { type: 'boolean' } },
                },
              },
            },
          },
        },
        responses: runResponse,
      },
    };
  }
  if (workflowNames.length) {
    paths['/workflows'] = {
      get: { summary: 'List of registered workflows (name + steps)', responses: { '200': { description: 'WorkflowMeta list' } } },
    };
    const wfRunBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              runId: { type: 'string', description: 'Idempotency key (optional; if given, can be resumed)' },
              input: { description: 'Workflow input (workflow-specific)' },
            },
          },
        },
      },
    };
    const wfRunResponse = {
      '200': {
        description: 'WorkflowRunResult',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                runId: { type: 'string' },
                output: { description: 'Workflow output (if completed)' },
                suspended: { type: 'boolean' },
                stepId: { type: 'string' },
                steps: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
    };
    for (const w of workflowNames) {
      paths[`/workflows/${w}/run`] = {
        post: { summary: `Run the '${w}' workflow durably (suspend/resume safe)`, requestBody: wfRunBody, responses: wfRunResponse },
      };
    }
  }

  paths['/runs/{id}'] = {
    get: {
      summary: "A run's journal timeline",
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Journal entry list' } },
    },
  };
  // P0.3 documents the opt-in pagination/filter query params — with none given
  // The response is still the legacy RunSummary array (see createRestApi's GET /runs JSDoc).
  paths['/runs'] = {
    get: {
      summary: 'Run summaries — legacy array with no params, or a {items,nextCursor} page when ?limit/?cursor/?status/?agent is given',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['completed', 'suspended'] } },
        { name: 'agent', in: 'query', schema: { type: 'string' } },
      ],
      responses: { '200': { description: 'RunSummary list, or {items: RunSummary[], nextCursor?: string}' } },
    },
  };
  paths['/runs/{id}/cancel'] = {
    post: {
      summary: 'Cancel in-flight generation for a run on THIS server instance (best-effort, single-instance only — see JSDoc)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: '{ok:true, cancelled:number}' }, '404': { description: 'run not found / not visible in this scope' } },
    },
  };

  return { openapi: '3.1.0', info: { title, version: '0.0.0' }, paths };
}
