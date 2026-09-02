// F6.2: pure session-rejection logic (401/403 detection + when to bounce back to login).
// NODE environment — no DOM needed, no react-query hooks are called (only pure functions are imported).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, isAuthError, isCredentialError, isScopeError, shouldForceReauth, queryRetry, api } from '../src/api';

// The whole point of the rule, stated as the outcome rather than as a predicate: a valid token must
// survive being told "no" about a resource. Measured before this held: a principal whose grants omit
// `threads:read` lands on the default route, its hook 403s, the token is cleared — and signing in
// again returns them to the same page and the same 403, forever.
describe('a valid token survives every refusal that is about the RESOURCE', () => {
  const authed = { authRequired: true, hasToken: true };
  // Not because a 403 can never indicate a bad credential — on the free roleAuth path a WRITE with
  // No identity answers 403 (role-auth.ts:202). Because every READ answers 401, and every screen reads.
  const refusals = [
    new ApiError(403, 'permission denied: threads:read'),               // auth-ee/rbac.ts:73
    new ApiError(403, 'unauthorized (admin required)'),                  // auth/role-auth.ts:202
    new ApiError(403, 'unauthorized (client credentials cannot write)'), // auth/role-auth.ts:200
    new ApiError(403, 'access denied: this run belongs to a different resourceId'),
    new ApiError(403, 'agent not approved to serve'),
    new ApiError(403, 'writes are not supported in an org context', { code: 'org_scope_refused', error: 'x' }),
    new ApiError(403, 'Forbidden'), // an unlabelled one, e.g. from a proxy
  ];
  it('none of them ends the session', () => {
    for (const err of refusals) {
      expect(shouldForceReauth({ err, ...authed }), err.message).toBe(false);
      expect(isCredentialError(err), err.message).toBe(false);
    }
  });
  // The mirror, so the above cannot pass by nothing ever forcing a re-login.
  it('...but a 401 still does — that IS the credential being rejected', () => {
    const dead = new ApiError(401, 'not authenticated'); // auth-ee/rbac.ts:68
    expect(isCredentialError(dead)).toBe(true);
    expect(shouldForceReauth({ err: dead, ...authed })).toBe(true);
  });
});

describe('isAuthError (F6.2)', () => {
  it('ApiError 401/403 → true', () => {
    expect(isAuthError(new ApiError(401, 'unauthorized'))).toBe(true);
    expect(isAuthError(new ApiError(403, 'forbidden'))).toBe(true);
  });
  it('other HTTP statuses → false', () => {
    expect(isAuthError(new ApiError(500, 'server'))).toBe(false);
    expect(isAuthError(new ApiError(404, 'not found'))).toBe(false);
  });
  it('non-ApiError values → false', () => {
    expect(isAuthError(new Error('401'))).toBe(false); // even if "401" appears in the text, it's not an ApiError
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('401')).toBe(false);
  });
});

describe('a scope refusal is not a bad token', () => {
  // The nav hides a row whose capability is off, but every route stays registered — so typing `/cache`
  // mounts the view anyway. `useCacheStats` then polls `GET /cache/stats`, which answers 403 to an
  // organization-bound admin because the host's cache has no organization boundary. Matching on status
  // alone, this signed them out: token cleared, cache flushed, back to Login. Every 5s, on every login.
  //
  // The refusal is about WHERE the caller is, not WHO they are. The server labels it; this must read
  // the label, or a correctly-authenticated user is thrown out for opening a page.
  const scopeErr = new ApiError(403, 'reaches `cache` …', { code: 'org_scope_refused' });

  it('is recognised by its code, not its status', () => {
    expect(isScopeError(scopeErr)).toBe(true);
    expect(isScopeError(new ApiError(403, 'forbidden'))).toBe(false);
    expect(isAuthError(scopeErr), 'still a 403 — the status test is unchanged').toBe(true);
  });

  it('does not bounce the user back to login', () => {
    expect(shouldForceReauth({ err: scopeErr, authRequired: true, hasToken: true })).toBe(false);
  });

  // This used to assert the opposite — that an uncoded 403 forces re-login. Dropping it is safe not
  // Because 403 never means a bad credential (on the free roleAuth path a WRITE with no identity
  // Answers 403), but because every READ answers 401 and every screen reads: a revoked token still
  // Ends the session within the first render.
  //
  // The cost of the old assertion: a principal without `threads:read` lands on the default route,
  // Its hook 403s, and a valid token is thrown away — on every login, forever.
  it('a plain 403 does NOT — a permission denial is not a bad credential', () => {
    expect(shouldForceReauth({ err: new ApiError(403, 'forbidden'), authRequired: true, hasToken: true })).toBe(false);
    // The shape the server actually sends for a withheld grant.
    const denied = new ApiError(403, 'permission denied: threads:read');
    expect(shouldForceReauth({ err: denied, authRequired: true, hasToken: true })).toBe(false);
  });
});

describe('shouldForceReauth (F6.2)', () => {
  const authErr = new ApiError(401, 'revoked');
  it('auth on + token present + 401 → true (clean login)', () => {
    expect(shouldForceReauth({ err: authErr, authRequired: true, hasToken: true })).toBe(true);
  });
  it('when NO token → false (do not create a 401 loop on the Login screen)', () => {
    expect(shouldForceReauth({ err: authErr, authRequired: true, hasToken: false })).toBe(false);
  });
  it('when auth is OFF → false', () => {
    expect(shouldForceReauth({ err: authErr, authRequired: false, hasToken: true })).toBe(false);
  });
  it('non-auth error → false (do not log out on a 500)', () => {
    expect(shouldForceReauth({ err: new ApiError(500, 'x'), authRequired: true, hasToken: true })).toBe(false);
  });
});

describe('queryRetry (bug investigation #4 — react-query retry decision)', () => {
  it('401/403 → never retries (false even on attempt 0, does not delay triggering reauth)', () => {
    expect(queryRetry(0, new ApiError(401, 'unauthorized'))).toBe(false);
    expect(queryRetry(0, new ApiError(403, 'forbidden'))).toBe(false);
  });
  it('for other errors (e.g. 500) retries once more on the first attempt', () => {
    expect(queryRetry(0, new ApiError(500, 'server'))).toBe(true);
  });
  it('for other errors, stops after the second attempt (at most 1 retry)', () => {
    expect(queryRetry(1, new ApiError(500, 'server'))).toBe(false);
  });
  it('for non-ApiError errors (e.g. network exception), the normal retry rule applies', () => {
    expect(queryRetry(0, new Error('network'))).toBe(true);
    expect(queryRetry(1, new Error('network'))).toBe(false);
  });
});

// API-05 regression: http()'s error path used to fold the server's JSON error body down to just
// `.error` (message-only) — machine-readable fields like `code`/`resumable`/`detail`/`aggregate`
// were silently dropped, so callers had no way to branch on error TYPE (e.g. offer "Resume" on a
// resumable run_limit_exceeded, or read a 412 eval-gate's `aggregate`). ApiError now also carries
// `code` and the full parsed `body`.
describe('ApiError carries the server JSON body (API-05)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('422 { error, code, detail, resumable } → ApiError keeps status, message, code and body intact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'run limit exceeded', code: 'run_limit_exceeded', detail: { limit: 10 }, resumable: true }),
      clone() { return this; },
    })));
    await expect(api.capabilities()).rejects.toMatchObject({
      status: 422,
      message: 'run limit exceeded',
      code: 'run_limit_exceeded',
      body: { error: 'run limit exceeded', code: 'run_limit_exceeded', detail: { limit: 10 }, resumable: true },
    });
  });

  it('body without a `.error` string falls back to the generic status message, but `body`/`code` still survive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      headers: { get: () => 'application/json' },
      json: async () => ({ code: 'tool_loop_detected', resumable: true }),
      clone() { return this; },
    })));
    let caught: unknown;
    try { await api.capabilities(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('tool_loop_detected');
    expect(err.body).toEqual({ code: 'tool_loop_detected', resumable: true });
  });

  it('non-JSON/empty body → code and body stay undefined (old generic-message behavior unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => 'text/plain' },
      json: async () => { throw new Error('not JSON'); },
      clone() { return this; },
    })));
    let caught: unknown;
    try { await api.capabilities(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(500);
    expect(err.message).toBe('500 Internal Server Error @ /capabilities');
    expect(err.code).toBeUndefined();
    expect(err.body).toBeUndefined();
  });
});
