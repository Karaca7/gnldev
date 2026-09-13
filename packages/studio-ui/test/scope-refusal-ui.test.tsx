// @vitest-environment jsdom
// Three consequences of ONE server contract: a 403 that says "not for your scope"
// (`code: 'org_scope_refused'`) is a property of WHERE the caller is, not of WHO they are.
//
//   A2  api.ts   — `isScopeError`/`shouldForceReauth` must not sign the user out for it, and the code
//                  must survive the trip through the real fetch wrapper (not just the constructor).
//   A3  Playground — with memory OFF the run body carries NO threadId; the inert `threadId: runId` it
//                  used to send is exactly what the server now refuses for an org-bound caller.
//   A4  Workflows — a 403 while READING a definition must not open an empty draft that Save would
//                  write over the real one; only a 404 ("there is no definition yet") may.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { ApiError, api, isScopeError, shouldForceReauth, isAuthError } from '../src/api';
import { Playground } from '../src/views/Playground';
import { Workflows, isMissingDefinition } from '../src/views/Workflows';
import enPlayground from '../src/i18n/locales/en/playground.json';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// Assigned directly rather than through vi.stubGlobal: the afterEach above calls unstubAllGlobals()
// (it must, to drop the fetch stub), which would otherwise remove these after the very first test and
// leave react-flow/framer-motion without the observers they construct on mount.
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IntersectionObserver = class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const CAPS_OFF = {
  resume: false, chat: false, fork: false, playground: false, stream: false, compensate: false,
  tools: false, toolExec: false, toolExecDurable: false, memory: false, workflows: false,
  workflowExec: false, scorers: false, datasets: false, mcp: false, a2a: false, queue: false,
  knowledge: false, workflowManage: false,
};

// ── A2: scope refusal vs. a bad token ────────────────────────────────────────
describe('org_scope_refused is a place, not an identity', () => {
  // The decision itself. Only a 401 means "your credential is no good"; every 403 means "identified,
  // not allowed" and must leave the session alone.
  //
  // This test used to require the opposite for an uncoded 403, which narrowed the exclusion to
  // refusals CARRYING `org_scope_refused` — and a permission denial carries no code, so it fell into
  // the loop the exclusion existed to prevent. That is the common case, not a corner: composing
  // narrow grants is what the Users screen is for.
  it('shouldForceReauth is false for every 403 — coded or not — and true only for a 401', () => {
    const authed = { authRequired: true, hasToken: true };
    const scoped = new ApiError(403, 'writes are not supported in an org context', { code: 'org_scope_refused', error: 'nope' });
    const denied = new ApiError(403, 'permission denied: threads:read'); // auth-ee/rbac.ts:73, no code
    const plain403 = new ApiError(403, 'Forbidden');
    const plain401 = new ApiError(401, 'Unauthorized');
    expect(shouldForceReauth({ err: scoped, ...authed })).toBe(false);
    expect(shouldForceReauth({ err: denied, ...authed })).toBe(false);
    expect(shouldForceReauth({ err: plain403, ...authed })).toBe(false);
    expect(shouldForceReauth({ err: plain401, ...authed })).toBe(true);
    // The scope label is still parsed and still used elsewhere (the views below read it to explain
    // WHY a card is empty); it just no longer carries the whole burden of not destroying the session.
    expect(isScopeError(scoped)).toBe(true);
    expect(isScopeError(plain403)).toBe(false);
    expect(isScopeError(new Error('network down'))).toBe(false);
    expect(isScopeError(null)).toBe(false);
  });

  // The half that catches a server/UI contract drift: the constructor-only test above would keep
  // passing if `http()` stopped parsing the JSON error body, and then EVERY scope refusal would come
  // back as a plain 403 and sign the user out again. Drive the real wrapper end to end.
  it('a real 403 JSON body {code:"org_scope_refused"} arrives on the thrown ApiError as .code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, statusText: 'Forbidden',
      headers: { get: () => 'application/json' },
      clone: () => ({ json: async () => ({ code: 'org_scope_refused', error: 'this store has no org boundary' }) }),
      json: async () => ({ code: 'org_scope_refused', error: 'this store has no org boundary' }),
    })));
    const err = await api.cacheStats().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe('org_scope_refused');
    expect((err as ApiError).message).toBe('this store has no org boundary');
    // and therefore the whole chain, not just the field, reaches the right verdict
    expect(shouldForceReauth({ err, authRequired: true, hasToken: true })).toBe(false);
  });

  // A 403 whose body is NOT JSON (a proxy's HTML page, an empty body) must stay a plain 403 — a
  // gateway error must not masquerade as a labelled scope refusal, because views read that label to
  // explain WHY a card is empty.
  it('a 403 with an unparseable body yields no .code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, statusText: 'Forbidden',
      headers: { get: () => 'text/html' },
      clone: () => ({ json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    })));
    const err = await api.cacheStats().then(() => null, (e) => e);
    expect((err as ApiError).code).toBeUndefined();
    // It does not end the session either. This line used to require the opposite, on the reasoning
    // that an unlabelled 403 might mean a dead session — but a dead session is answered 401. A proxy
    // returning 403 says nothing about the credential, so throwing it away helps nobody.
    expect(shouldForceReauth({ err, authRequired: true, hasToken: true })).toBe(false);
  });
});

// ── A3: Playground run body ──────────────────────────────────────────────────
/**
 * `stream: false` keeps the run on `api.runAgent`, i.e. an ordinary POST through the same fetch stub —
 * the SSE path parses a ReadableStream and cannot be observed this way. The assertion is on the parsed
 * request body of the POST to /agents/<name>/run.
 */
function stubPlaygroundFetch(caps: Record<string, unknown>) {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) });
    let body: unknown = [];
    if (u.includes('/capabilities')) body = { ...CAPS_OFF, playground: true, ...caps };
    else if (u.endsWith('/agents')) body = [{ name: 'alpha', model: 'm', hasTools: false }];
    else if (u.includes('/me')) body = { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' };
    else if (u.includes('/model-providers')) body = { providers: [], models: [] };
    else if (u.includes('/threads')) body = [];
    // /cost BEFORE /run: the cost path is `/runs/<id>/cost`, which also contains '/run'.
    else if (u.endsWith('/cost')) body = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };
    else if (u.endsWith('/run')) body = { ok: true, runId: 'pg-1', text: 'hi' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  }));
  return posts;
}

async function sendPrompt() {
  const textarea = await screen.findByPlaceholderText(enPlayground.messagePlaceholder);
  fireEvent.change(textarea, { target: { value: 'charge order-1' } });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(enPlayground.sendButton, 'i') }));
}

describe('Playground run body vs. memory capability', () => {
  // The regression: `threadId: runId` was sent even with memory off. It reached nothing (runDurable
  // gates every memory read/write on `memory && threadId`) until the server started refusing a named
  // thread whose store has no org boundary — then it 403'd the whole run, on every prompt.
  it('with caps.memory false the POSTed run body has NO threadId key at all', async () => {
    const posts = stubPlaygroundFetch({ memory: false });
    wrap(<Playground />);
    await sendPrompt();
    await waitFor(() => expect(posts.some((p) => p.url.includes('/agents/alpha/run'))).toBe(true));
    const body = posts.find((p) => p.url.includes('/agents/alpha/run'))!.body;
    // `in`, not falsiness: `threadId: undefined` would serialize away, but `threadId: runId` — the
    // actual bug — is a truthy string, and a `toBeFalsy` here would not have caught the ORIGINAL
    // shape either way. The key must simply not exist.
    expect('threadId' in body).toBe(false);
    expect('resourceId' in body).toBe(false);
    expect(body.prompt).toBe('charge order-1');
    expect(typeof body.runId).toBe('string');
  });

  // The counterpart — without it, a Playground that never POSTs anything would pass the test above.
  it('with caps.memory true the POSTed run body DOES carry a threadId and a resourceId', async () => {
    const posts = stubPlaygroundFetch({ memory: true });
    wrap(<Playground />);
    await sendPrompt();
    await waitFor(() => expect(posts.some((p) => p.url.includes('/agents/alpha/run'))).toBe(true));
    const body = posts.find((p) => p.url.includes('/agents/alpha/run'))!.body;
    expect('threadId' in body).toBe(true);
    expect(typeof body.threadId).toBe('string');
    expect(body.threadId.length).toBeGreaterThan(0);
    // and it is a real thread id, not the runId wearing a thread's name (the shape that regressed)
    expect(body.threadId).not.toBe(body.runId);
    expect(typeof body.resourceId).toBe('string');
  });
});

// ── A4: Workflows editor gate ────────────────────────────────────────────────
describe('isMissingDefinition', () => {
  // Only "there is no stored definition" may open an empty draft. Everything else is a failure to
  // READ one that exists — and an empty draft is one Save away from deleting it.
  it('is true only for an ApiError 404 — 403, 500, network Error, non-ApiError and null are false', () => {
    expect(isMissingDefinition(new ApiError(404, 'Not Found'))).toBe(true);
    expect(isMissingDefinition(new ApiError(403, 'Forbidden', { code: 'org_scope_refused' }))).toBe(false);
    expect(isMissingDefinition(new ApiError(500, 'Internal Server Error'))).toBe(false);
    expect(isMissingDefinition(new TypeError('Failed to fetch'))).toBe(false);
    expect(isMissingDefinition({ status: 404 })).toBe(false); // duck-typed lookalike, not an ApiError
    expect(isMissingDefinition(null)).toBe(false);
    expect(isMissingDefinition(undefined)).toBe(false);
  });
});

/** Managed workflow + workflowManage on = the pencil (edit) affordance exists in the list. */
function stubWorkflowsFetch(defStatus: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/workflows\/[^/]+\/def$/.test(u)) {
      return {
        ok: false, status: defStatus, statusText: defStatus === 404 ? 'Not Found' : 'Forbidden',
        headers: { get: () => 'application/json' },
        clone: () => ({ json: async () => ({ error: 'refused', ...(defStatus === 403 ? { code: 'org_scope_refused' } : {}) }) }),
      };
    }
    let body: unknown = [];
    if (u.includes('/capabilities')) body = { ...CAPS_OFF, workflows: true, workflowManage: true };
    else if (u.endsWith('/workflows')) body = [{ name: 'billing', steps: [{ id: 's1', kind: 'step' }], source: 'managed' }];
    else if (u.includes('/workflows/runs')) body = { items: [] };
    else if (u.endsWith('/agents')) body = [{ name: 'alpha', model: 'm', hasTools: false }];
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  }));
}

describe('Workflows: editing a definition that could not be read', () => {
  // Observable behaviour, not "a toast function was called": if the editor opened, its Save control
  // would be on screen — and that control is the one that overwrites the real definition.
  it('a 403 on /workflows/:name/def does NOT open the editor (no Save control appears)', async () => {
    stubWorkflowsFetch(403);
    wrap(<Workflows />);
    // two edit affordances render for a managed workflow (list pencil + detail header); both call
    // startEdit — the list one is the one a user clicks from the sidebar.
    const [edit] = await screen.findAllByTitle('Edit');
    fireEvent.click(edit);
    // give the rejected request time to settle and any state update time to flush
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    // still on the list screen
    expect(screen.getAllByTitle('Edit').length).toBeGreaterThan(0);
  });

  // The mirror: a genuine 404 must still open the empty draft, otherwise "never open" would pass the
  // test above while breaking the one case the empty draft exists for.
  it('a 404 on /workflows/:name/def DOES open the editor (Save control present)', async () => {
    stubWorkflowsFetch(404);
    wrap(<Workflows />);
    const [edit] = await screen.findAllByTitle('Edit');
    fireEvent.click(edit);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy());
  });
});
