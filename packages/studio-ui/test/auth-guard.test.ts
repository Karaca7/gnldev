// F6.2: pure session-rejection logic (401/403 detection + when to bounce back to login).
// NODE environment — no DOM needed, no react-query hooks are called (only pure functions are imported).
import { describe, it, expect } from 'vitest';
import { ApiError, isAuthError, shouldForceReauth, queryRetry } from '../src/api';

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
