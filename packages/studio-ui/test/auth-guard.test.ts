// F6.2: pure session-rejection logic (401/403 detection + when to bounce back to login).
// NODE environment — no DOM needed, no react-query hooks are called (only pure functions are imported).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, isAuthError, shouldForceReauth, queryRetry, api } from '../src/api';

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
