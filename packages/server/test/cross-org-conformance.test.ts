// CROSS-ORG CONFORMANCE for @gnldev/server — the same discipline as the studio suite, over all 18
// routes the router reports.
//
// The table is the point: a route with no verdict FAILS, because an unexamined route is how every
// isolation gap in this repo has shipped. `/openapi.json` is the local example — it published the
// complete agent list next door to `agentGate`, which answers the same 404 for "no such agent" and
// "not yours" precisely so a non-owning organization cannot learn an agent exists.
//
// The probe drives every route as globex while substituting ACME's identifiers into every parameter,
// then checks two directions: no acme marker in any response, and no acme journal key changed.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const MARKER = 'ACME-CONFIDENTIAL-PAYLOAD';
const ACME_AGENT = 'acme-only-agent';

type Verdict = 'org-scoped' | 'global' | 'self' | 'platform-admin' | 'undecided';

const VERDICTS: Record<string, { verdict: Verdict; why: string }> = {
  // Liveness: about the process, not about any organization's data.
  'GET /health': { verdict: 'self', why: 'process liveness; deliberately unauthenticated' },
  'GET /ready': { verdict: 'self', why: 'process readiness; deliberately unauthenticated' },

  // Code-defined, identical for every caller.
  'GET /workflows': { verdict: 'global', why: 'code-defined workflow list; workflows carry no org dimension in the config' },

  // Platform-level agent governance — "may this agent serve at all" is never a per-org decision.
  'GET /agents/registry': { verdict: 'platform-admin', why: 'platform-level agent governance' },
  'POST /agents/registry/:name/approve': { verdict: 'platform-admin', why: 'platform-level agent governance' },
  'POST /agents/registry/:name/block': { verdict: 'platform-admin', why: 'platform-level agent governance' },

  // Everything that reads or writes one organization's data.
  'GET /agents': { verdict: 'org-scoped', why: 'filtered through agentVisibleToOrg' },
  'GET /openapi.json': { verdict: 'org-scoped', why: 'publishes agent names, which agentGate withholds' },
  'POST /agents/:name/run': { verdict: 'org-scoped', why: 'runs under the caller\'s org, gated by agentGate' },
  'POST /agents/:name/stream': { verdict: 'org-scoped', why: 'runs under the caller\'s org, gated by agentGate' },
  'POST /agents/:name/resume': { verdict: 'org-scoped', why: 'continues a run belonging to one org' },
  'GET /runs': { verdict: 'org-scoped', why: 'the run list is org data' },
  'GET /runs/:id': { verdict: 'org-scoped', why: 'a run belongs to one organization' },
  'POST /runs/:id/cancel': { verdict: 'org-scoped', why: 'terminally stops a run' },
  'GET /usage': { verdict: 'org-scoped', why: 'spend is metered per organization' },
  'POST /workflows/:name/run': { verdict: 'org-scoped', why: 'journals under the caller\'s org' },
  'GET /workflows/runs': { verdict: 'org-scoped', why: 'workflow run registry is org data' },
  'POST /workflows/runs/:id/cancel': { verdict: 'org-scoped', why: 'terminally stops a workflow run' },
};

// NESTED, the shape AI SDK 7 reads. Flat counts made the run route answer 400 "Cannot read properties
// of undefined (reading 'inputTokens')" to both callers — the other half of the same v4→v7 migration
// as the finish reason below.
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  // `{unified, raw}`, not a bare string: AI SDK 7 reads `finishReason.unified`, and a bare string made
  // `POST /agents/:name/run` answer 400 "Cannot read properties of undefined" for BOTH callers — which
  // parked two routes in the uncontrolled pile for a reason with nothing to do with organizations.
  // Same defect this suite's sibling found in the scaffold templates.
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: async () => ({
    stream: new ReadableStream({
      start(c: any) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
        c.close();
      },
    }),
  }),
};

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };

/** Acme's identifiers, substituted into every parameter. */
/** `:name` means an AGENT under `/agents/*` and a WORKFLOW under `/workflows/*` — one mapping asked
 *  the workflow routes for an agent, so they 404'd for both callers and read as isolation. */
const concrete = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, (m) => {
  if (m === ':runId' || m === ':id') return 'r-acme';
  if (m === ':name') return p.startsWith('/workflows') ? 'code-wf' : ACME_AGENT;
  return 'r-acme';
});

async function makeApi() {
  const journal = new InMemoryJournal();
  // `usage` included: the run routes REPLAY this record, and a journaled step without it made
  // `POST /agents/:name/run` answer 400 "reading 'inputTokens'" to both callers — the route was
  // uncontrollable because of the seed, not because of anything about organizations.
  await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: MARKER }], finishReason: { unified: 'stop', raw: 'stop' }, usage });
  await journal.put('org:acme:r-acme:input', { prompt: MARKER, at: Date.now() });
  await journal.put('org:acme:r-acme:outcome', { status: 'completed', at: Date.now() });
  await journal.put('org:acme:__metrics__run:r-acme', { runId: 'r-acme', agentName: MARKER, status: 'completed', costUsd: 3, totalTokens: 7 });
  await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'GLOBEX-OWN' }], finishReason: { unified: 'stop', raw: 'stop' }, usage });
  await journal.put('org:globex:r-globex:input', { prompt: 'GLOBEX-OWN', at: 1 });
  await journal.put('org:globex:r-globex:outcome', { status: 'completed', at: 3 });
  await journal.put('org:globex:__metrics__run:r-globex', { runId: 'r-globex', agentName: 'GLOBEX-OWN', status: 'completed', costUsd: 1, totalTokens: 2 });
  // Workflow run registry records, so the workflow read surface has something to differ about.
  await journal.put('org:acme:wfrun:r-acme', { runId: 'r-acme', workflowName: MARKER, status: 'completed', at: 1 });
  await journal.put('org:globex:wfrun:r-globex', { runId: 'r-globex', workflowName: 'GLOBEX-OWN', status: 'completed', at: 1 });

  const api = createRestApi(
    {
      journal,
      // One agent owned by acme — its NAME is the thing agentGate withholds — and one global agent.
      agents: { [ACME_AGENT]: { model, orgs: ['acme'] }, shared: { model } },
      workflows: { 'code-wf': { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) } },
    } as never,
    { org: {}, auth: authProvider } as never,
  );
  return { api, journal };
}

async function bodyOf(res: Response, ms = 1200): Promise<string> {
  try {
    return await Promise.race([res.text(), new Promise<string>((r) => setTimeout(() => r('<<stream>>'), ms))]);
  } catch { return '<<unreadable>>'; }
}

async function drive(api: any, route: { method: string; path: string }, who: Record<string, string>) {
  const init: RequestInit = { method: route.method, headers: { ...who } };
  if (!['GET', 'HEAD'].includes(route.method)) {
    init.headers = { ...who, 'content-type': 'application/json' };
    init.body = JSON.stringify({ runId: 'r-acme', prompt: 'x', input: {} });
  }
  const res: Response = await Promise.race([
    api(new Request(`http://x${concrete(route.path)}`, init)),
    new Promise<Response>((r) => setTimeout(() => r(new Response('<<no response>>', { status: 599 })), 4000)),
  ]);
  return { status: res.status, body: await bodyOf(res) };
}

const snapshot = async (j: InMemoryJournal) => {
  const out: Record<string, string> = {};
  for (const k of (await j.listKeys('')).filter((x) => x.startsWith('org:acme:')).sort()) out[k] = JSON.stringify(await j.get(k));
  return out;
};

describe('the conformance table covers the router exactly', () => {
  it('every route the handler serves has a verdict', async () => {
    const { api } = await makeApi();
    const inventory = api.routeTable.map((r: { method: string; path: string }) => `${r.method} ${r.path}`);

    expect(inventory.length, 'the inventory is empty — the suite would pass vacuously').toBe(18);
    expect(inventory.filter((r: string) => !(r in VERDICTS)),
      'a route has no cross-org verdict. An unexamined route is exactly how every isolation gap here '
      + 'shipped — add it to VERDICTS with a reason rather than letting it pass silently.').toEqual([]);
  });

  it('and no verdict names a route that no longer exists', async () => {
    const { api } = await makeApi();
    const inventory = new Set(api.routeTable.map((r: { method: string; path: string }) => `${r.method} ${r.path}`));
    expect(Object.keys(VERDICTS).filter((k) => !inventory.has(k)), 'a stale verdict outlived its route').toEqual([]);
  });

  it('and nothing is left as "we did not check"', () => {
    expect(Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'undecided').map(([k]) => k)).toEqual([]);
  });
});

describe("one organization's request cannot reach another's data", () => {
  it('no route returns acme data to globex', async () => {
    const { api } = await makeApi();
    const leaks: string[] = [];
    for (const r of api.routeTable) {
      const { status, body } = await drive(api, r, AS.globex);
      if (body.includes(MARKER)) leaks.push(`${r.method} ${r.path} -> ${status} leaked the payload`);
      // The agent NAME is the fact `agentGate` exists to withhold, so it counts as a leak — but ONLY
      // where the caller did not supply it. A route with `:name` in its path answers
      // `{"error":"agent 'acme-only-agent' not found"}`, which echoes the caller's own input and tells
      // them nothing they did not already type. Measured: four routes flagged that way, all 404 echoes.
      // Counting them would have made this probe cry wolf on correct behaviour.
      if (!r.path.includes(':name') && body.includes(ACME_AGENT)) {
        leaks.push(`${r.method} ${r.path} -> ${status} leaked the agent name`);
      }
    }
    expect(leaks, 'a route served one organization the contents of another').toEqual([]);
  }, 60_000);

  it('no globex request modifies an acme journal key', async () => {
    const { api, journal } = await makeApi();
    const before = await snapshot(journal);
    for (const r of api.routeTable) await drive(api, r, AS.globex);
    const after = await snapshot(journal);

    expect(Object.keys(before).filter((k) => before[k] !== after[k] || !(k in after)),
      "a request from one organization altered another's stored data").toEqual([]);
  }, 60_000);
});

describe('platform-admin routes refuse an organization-bound caller', () => {
  const platform = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'platform-admin').map(([k]) => k);

  it('there are some, or this block is vacuous', () => expect(platform.length).toBeGreaterThan(2));

  it.each(platform)('%s', async (key) => {
    const { api } = await makeApi();
    const [method, ...rest] = key.split(' ');
    const { status } = await drive(api, { method: method!, path: rest.join(' ') }, AS.globex);
    expect(status, 'an organization-bound caller reached a platform-level surface').toBe(403);
  }, 30_000);
});

describe('the ownership control — acme must SEE what globex must not', () => {
  const CONTROLLED = ['GET /runs', 'GET /runs/:id', 'GET /agents', 'GET /openapi.json', 'GET /usage',
    'GET /workflows/runs', 'POST /workflows/runs/:id/cancel', 'POST /runs/:id/cancel',
    'POST /agents/:name/run', 'POST /agents/:name/resume', 'POST /agents/:name/stream'];

  it.each(CONTROLLED)('%s answers its owner, and differently from a stranger', async (key) => {
    const { api } = await makeApi();
    const [method, ...rest] = key.split(' ');
    const route = { method: method!, path: rest.join(' ') };
    const owner = await drive(api, route, AS.acme);
    const stranger = await drive(api, route, AS.globex);

    expect(owner.status, `${key} refused the organization that owns the data`).toBeLessThan(400);
    // A body that never ended is not an answer. Without this, two timed-out streams compare as
    // "different from nothing" or, worse, equal — and the control passes having compared nothing.
    // `POST /agents/:name/stream` is in this list precisely because its stream DOES end (the mock
    // closes it); studio's `GET /events` is not, because it never does.
    for (const [who, r] of [['owner', owner], ['stranger', stranger]] as const) {
      expect(r.body, `${key}: the ${who}'s body never ended, so there is nothing to compare`)
        .not.toContain('<<stream>>');
    }
    expect(owner.body, `${key} answers owner and stranger identically — the leak probe passes for the wrong reason`)
      .not.toBe(stranger.body);
  }, 30_000);

  // The specific regression that motivated the inventory: the schema route must show acme its own
  // agent and must not name it to globex.
  it('GET /openapi.json names the acme agent to acme only', async () => {
    const { api } = await makeApi();
    const owner = await drive(api, { method: 'GET', path: '/openapi.json' }, AS.acme);
    const stranger = await drive(api, { method: 'GET', path: '/openapi.json' }, AS.globex);

    expect(owner.body, 'the owning organization lost its own agent from the schema').toContain(ACME_AGENT);
    expect(stranger.body, 'the schema published a name that agentGate withholds').not.toContain(ACME_AGENT);
    expect(stranger.body, 'the global agent disappeared for a non-owning caller').toContain('shared');
  });

  /** Every gap carries a reason. An unexplained one is the same failure as an unclassified route. */
  const UNCONTROLLED_REASONS: Record<string, string> = {
    'POST /workflows/:name/run': 'the stub workflow answers {ok:true} identically to both callers; '
      + 'controlling it needs a workflow whose OUTPUT depends on the caller, which is a fixture with a '
      + 'real engine behind it rather than a seam in production',
  };

  it('names the org-scoped routes that are leak-checked but not ownership-controlled', () => {
    const orgScoped = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'org-scoped').map(([k]) => k);
    const uncontrolled = orgScoped.filter((k) => !CONTROLLED.includes(k));
    // eslint-disable-next-line no-console
    console.log(`[cross-org/server] ${CONTROLLED.length}/${orgScoped.length} org-scoped routes have an ownership control.\n`
      + `[cross-org/server] NOT ownership-controlled (${uncontrolled.length}):\n`
      + uncontrolled.map((k) => `  ${k} — ${UNCONTROLLED_REASONS[k] ?? 'UNEXPLAINED'}`).join('\n'));

    expect(uncontrolled.filter((k) => !UNCONTROLLED_REASONS[k]),
      'an org-scoped route is uncontrolled with no reason recorded — say why, or control it').toEqual([]);
    expect(CONTROLLED.length, 'ownership coverage went backwards').toBeGreaterThanOrEqual(11);
  });
});

