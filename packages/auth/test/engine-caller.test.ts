// ADR-0002: every door hands the engine the same caller for the same principal. This is the mapping.
import { describe, it, expect } from 'vitest';
import { engineCallerOf, type Principal } from '../src/index.js';

const p = (x: Partial<Principal> & Pick<Principal, 'kind'>): Principal => ({ roles: [], ...x }) as Principal;

describe('engineCallerOf — one mapping from a principal to the engine caller', () => {
  it('a subject is that user, in its organization', () => {
    expect(engineCallerOf(p({ kind: 'subject', id: 'ayse', orgId: 'acme' }))).toEqual({ kind: 'user', id: 'ayse', orgId: 'acme' });
    expect(engineCallerOf(p({ kind: 'subject', id: 'ayse' }))).toEqual({ kind: 'user', id: 'ayse' });
  });

  it('an operator is staff, even with a name of its own', () => {
    expect(engineCallerOf(p({ kind: 'operator', id: 'ops', orgId: 'acme' }))).toEqual({ kind: 'staff', orgId: 'acme' });
    expect(engineCallerOf(p({ kind: 'operator' }))).toEqual({ kind: 'staff' });
    expect(engineCallerOf(p({ kind: 'operator' }), '')).toEqual({ kind: 'staff' });
  });

  it('an operator naming a user speaks for that user — and a name no user can carry is nobody', () => {
    const ops = p({ kind: 'operator', id: 'ops', orgId: 'acme' });
    expect(engineCallerOf(ops, 'ayse')).toEqual({ kind: 'user', id: 'ayse', orgId: 'acme' });
    expect(engineCallerOf(ops, 'operator:ops')).toEqual({ kind: 'unknown' });
    expect(engineCallerOf(ops, 'a\u0085b')).toEqual({ kind: 'unknown' });
  });

  it('a subject naming someone else is still itself', () => {
    expect(engineCallerOf(p({ kind: 'subject', id: 'mallory' }), 'ayse')).toEqual({ kind: 'user', id: 'mallory' });
  });

  it('an application is the user it names — never staff', () => {
    const app = p({ kind: 'application', id: 'backend', orgId: 'acme' });
    expect(engineCallerOf(app, 'ayse')).toEqual({ kind: 'user', id: 'ayse', orgId: 'acme' });
    expect(engineCallerOf(app)).toEqual({ kind: 'unknown' });
    expect(engineCallerOf(app, '')).toEqual({ kind: 'unknown' });
    // a name no user can carry does not become one
    expect(engineCallerOf(app, 'operator:ops')).toEqual({ kind: 'unknown' });
  });

  it('nothing, a subject with an impossible id, and an unstamped principal are unknown or held to their name', () => {
    expect(engineCallerOf(null)).toEqual({ kind: 'unknown' });
    expect(engineCallerOf(p({ kind: 'subject', id: 'operator:ops' }))).toEqual({ kind: 'unknown' });
    expect(engineCallerOf(p({ kind: 'subject' }))).toEqual({ kind: 'unknown' });
    // unstamped: read fail-closed by callerKind — a named one is a user, never staff
    expect(engineCallerOf({ id: 'x', roles: ['admin'] } as unknown as Principal)).toEqual({ kind: 'user', id: 'x' });
  });
});
