// normalizeAuth: the boundary that turns a mis-shaped `auth` option into an error while it can still
// be fixed — at startup — instead of a silent hole or a request-time crash.
import { describe, it, expect } from 'vitest';
import { normalizeAuth } from '../src/adapter.js';

// A half-written {read, write} pair must fail at STARTUP, not on the first request.
//
// The check was `read is a function OR write is a function`, which short-circuits. So a config with one
// direction written as a predicate and the other still a credential map —
// `{ read: fn, write: { admin: { token } } }`, exactly what half-finished work looks like — was
// accepted here and threw at REQUEST time on the first write, in production. Moving that to startup is
// the entire reason this function exists.
describe('normalizeAuth and a half-written pair', () => {
  it.each([
    ['write', { read: () => true, write: { admin: { token: 't' } } }],
    ['read', { read: { admin: { token: 't' } }, write: () => true }],
  ])('refuses a %s side that is not a function, and names it', (side, cfg) => {
    expect(() => normalizeAuth(cfg as never)).toThrow(new RegExp(`auth\\.${side}`));
    expect(() => normalizeAuth(cfg as never)).toThrow(/roleAuth/);
  });

  it('still accepts a complete pair', () => {
    expect(normalizeAuth({ read: () => true, write: () => true } as never)).toBeTruthy();
  });

  it('still accepts one side alone — the other is simply unrestricted', () => {
    // Supported on purpose: a deployment that only gates writes writes only `write`.
    expect(normalizeAuth({ read: () => true } as never)).toBeTruthy();
    expect(normalizeAuth({ write: () => true } as never)).toBeTruthy();
  });

  it('still refuses a bare credential map, with the wrapping advice', () => {
    expect(() => normalizeAuth({ admin: { token: 't' } } as never)).toThrow(/roleAuth/);
  });

  it('still treats undefined as "no restrictions", which is the expressible intent', () => {
    expect(normalizeAuth(undefined)).toBeUndefined();
  });
});
