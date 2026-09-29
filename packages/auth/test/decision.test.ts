// The one rule for what a host reports to `onDecision`: the outcome the caller got.
import { describe, it, expect } from 'vitest';
import { makeGate, markRefusal, outcomeOf, markCredentialRejected, credentialRejected, callerOfRequest, CREDENTIAL_REJECTED, CREDENTIAL_NOT_ACCEPTED, type AccessDecision, type AuthProvider, type Principal } from '../src/index.js';

const ayse: Principal = { kind: 'subject', id: 'ayse', orgId: 'acme', roles: [] };
function provider(allow: boolean, seen: AccessDecision[]): AuthProvider {
  return {
    authenticate: (req) => (req.headers.get('authorization') ? ayse : null),
    authorize: (p) => (allow && p ? { allow: true } : { allow: false, status: p ? 403 : 401, reason: 'no' }),
    onDecision: (d) => { seen.push(d); },
  };
}
const req = (auth = true) => new Request('http://x/runs/r1', { headers: auth ? { authorization: 'Bearer t' } : {} });

describe('onDecision reports the answer, not the first verdict', () => {
  it('allowed by the provider, then refused by a host gate: the refusal is what is reported', async () => {
    const seen: AccessDecision[] = [];
    const gate = makeGate(provider(true, seen));
    const r = req();
    expect(await gate.allowP(r, 'runs:read')).toBe(true);
    markRefusal(r, 'ownership');
    await gate.settle(r, 404);
    expect(seen).toEqual([expect.objectContaining({ kind: 'subject', orgId: 'acme', permission: 'runs:read', allowed: false, reason: 'ownership', status: 404 })]);
  });

  it('the first refusal wins, and settle reports once', async () => {
    const seen: AccessDecision[] = [];
    const gate = makeGate(provider(true, seen));
    const r = req();
    await gate.allow(r, 'read');
    markRefusal(r, 'organization');
    markRefusal(r, 'ownership');
    await gate.settle(r, 403);
    await gate.settle(r, 403);
    expect(seen.map((d) => d.reason)).toEqual(['organization']);
  });

  it('the provider\'s own denial: 401 without a principal is unauthenticated, 403 with one is rbac', async () => {
    const seen: AccessDecision[] = [];
    const gate = makeGate(provider(false, seen));
    const anon = req(false);
    await gate.allow(anon, 'read');
    await gate.settle(anon, 401);
    const named = req();
    await gate.allow(named, 'read');
    await gate.settle(named, 403);
    expect(seen.map((d) => [d.kind, d.reason, d.status])).toEqual([['unnamed', 'unauthenticated', 401], ['subject', 'rbac', 403]]);
  });

  it('a 403 nobody explained is never reported as allowed; a plain 404 is a miss, not a refusal', async () => {
    const gate = makeGate(provider(true, []));
    const unexplained = req();
    await gate.allow(unexplained, 'read');
    expect(outcomeOf(unexplained, 403)).toMatchObject({ allowed: false, reason: 'policy' });
    const miss = req();
    await gate.allow(miss, 'read');
    expect(outcomeOf(miss, 404)).toMatchObject({ allowed: true, status: 404 });
    expect(outcomeOf(req(), 403)).toBeUndefined(); // nothing decided about it: no row at all
  });

  it('a request nothing decided about (no gate, no refusal) reports nothing', async () => {
    const seen: AccessDecision[] = [];
    const gate = makeGate(provider(true, seen));
    await gate.settle(req(), 200);
    expect(seen).toEqual([]);
  });
});

describe('a presented credential the provider rejected', () => {
  const identifyRejecting = (r: Request) => {
    if (r.headers.get('authorization')) markCredentialRejected(r);
    return undefined;
  };

  it('a door refuses it with 401 and the row names it; no credential stays anonymous', async () => {
    const dead = req();
    expect(await callerOfRequest(identifyRejecting, dead)).toEqual({ refused: CREDENTIAL_NOT_ACCEPTED, status: 401 });
    expect(outcomeOf(dead, 401)).toMatchObject({ allowed: false, reason: 'unauthenticated', detail: CREDENTIAL_REJECTED });

    const anon = req(false);
    expect(await callerOfRequest(identifyRejecting, anon)).toMatchObject({ principal: undefined, caller: { kind: 'unknown' } });
    expect(outcomeOf(anon, 200)).toMatchObject({ allowed: true });
    expect(outcomeOf(anon, 200)?.detail).toBeUndefined();
  });

  it('an identify that never notes a rejection (the `() => undefined` opt-out) keeps a header anonymous', async () => {
    const r = req();
    expect(await callerOfRequest(() => undefined, r)).toMatchObject({ caller: { kind: 'unknown' } });
    expect(credentialRejected(r)).toBe(false);
  });

  it('a gated route: the 401 row carries the rejection instead of the verdict\'s generic reason', async () => {
    const r = req();
    markCredentialRejected(r);
    const gate = makeGate({ authenticate: () => null, authorize: (p) => (p ? { allow: true } : { allow: false, status: 401, reason: 'no' }) });
    await gate.allow(r, 'read');
    expect(outcomeOf(r, 401)).toMatchObject({ allowed: false, reason: 'unauthenticated', detail: CREDENTIAL_REJECTED });
  });
});
