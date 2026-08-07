// Whose fault is it, and what should the caller do about it.
//
// Every error the taxonomy knew about was ours — a limit we enforced, a lock we held, a retry we
// refused. A failure from the model provider matched none of them and fell through to a generic 400,
// which was measured on a live rig: a free endpoint answering 429 reached the caller as
// `400 {"error":"Failed after 3 attempts. Last error: Too Many Requests"}`. 400 means "your request
// was malformed". The request was fine, and a client with retry logic reads 400 as "never retry" —
// the opposite of what a 429 is asking for.
//
// The errors are built by hand rather than imported: @gnldev/durable does not depend on the AI SDK
// and should not start, so the classifier duck-types on `name`/`statusCode` and these fixtures copy
// that shape. If the SDK ever changes it, that is a real break and this file is where it shows.
import { describe, it, expect } from 'vitest';
import { upstreamFailure } from '../src/errors.js';
import { RunBusyError } from '../src/errors.js';

/** The shape @ai-sdk/provider's APICallError presents. */
function apiCallError(statusCode?: number, responseHeaders?: Record<string, string>) {
  return Object.assign(new Error('upstream said no'), { name: 'AI_APICallError', statusCode, responseHeaders });
}

/** The shape `ai`'s RetryError presents — it wraps the failure that actually happened. */
function retryError(last: unknown) {
  return Object.assign(new Error('Failed after 3 attempts. Last error: Too Many Requests'), {
    name: 'AI_RetryError',
    lastError: last,
    errors: [last],
  });
}

describe('upstreamFailure', () => {
  it('429 stays 429, and carries the delay the upstream asked for', () => {
    const up = upstreamFailure(apiCallError(429, { 'retry-after': '30' }));
    expect(up).toEqual({ status: 429, code: 'upstream_rate_limited', upstreamStatus: 429, retryAfter: 30 });
  });

  it('sees through the retry wrapper to the failure underneath', () => {
    // This is the exact shape that produced the 400 in the field: the wrapper's own name says
    // nothing about what went wrong, and classifying the wrapper is how the status got lost.
    const up = upstreamFailure(retryError(apiCallError(429, { 'retry-after': '5' })));
    expect(up?.status).toBe(429);
    expect(up?.retryAfter).toBe(5);
  });

  it('accepts an HTTP-date Retry-After, not only a delta', () => {
    const inTen = new Date(Date.now() + 10_000).toUTCString();
    const up = upstreamFailure(apiCallError(429, { 'retry-after': inTen }));
    expect(up?.retryAfter).toBeGreaterThanOrEqual(9);
    expect(up?.retryAfter).toBeLessThanOrEqual(11);
  });

  it('a rejected credential is 502, never 401', () => {
    // The key that failed is the OPERATOR's. Answering 401 would tell the caller to fix an API key
    // it has never seen and cannot reach.
    for (const s of [401, 403]) {
      expect(upstreamFailure(apiCallError(s))).toEqual({ status: 502, code: 'upstream_unauthorized', upstreamStatus: s });
    }
    expect(upstreamFailure(Object.assign(new Error('no key'), { name: 'AI_LoadAPIKeyError' })))
      .toEqual({ status: 502, code: 'upstream_unauthorized' });
  });

  it('a timeout is 504, other upstream statuses are 502', () => {
    expect(upstreamFailure(apiCallError(408))?.status).toBe(504);
    expect(upstreamFailure(apiCallError(504))?.status).toBe(504);
    expect(upstreamFailure(apiCallError(500))?.status).toBe(502);
    expect(upstreamFailure(apiCallError(503))?.status).toBe(502);
  });

  it('a 4xx the provider blamed on the body is still 502', () => {
    // The request the provider rejected is the one WE built from the caller's prompt, not the one
    // the caller sent. Passing 400 through would blame the wrong party.
    expect(upstreamFailure(apiCallError(400))).toEqual({ status: 502, code: 'upstream_unavailable', upstreamStatus: 400 });
  });

  it('a transport failure with no status is 502', () => {
    expect(upstreamFailure(apiCallError(undefined))).toEqual({ status: 502, code: 'upstream_unavailable' });
  });

  it('leaves our own errors alone', () => {
    // The taxonomy must not swallow the errors that already have correct answers — a run lock is a
    // 409, not a bad gateway.
    expect(upstreamFailure(new RunBusyError('r1'))).toBeUndefined();
    expect(upstreamFailure(new Error('plain'))).toBeUndefined();
    expect(upstreamFailure(null)).toBeUndefined();
    expect(upstreamFailure('nope')).toBeUndefined();
  });
});
