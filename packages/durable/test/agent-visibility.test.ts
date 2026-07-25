// Unit test for the org-scoped agent visibility helper (shared by @gnldev/server + @gnldev/studio).
// Opt-in: no `orgs` → GLOBAL (everyone sees it); a caller with no org (operator / auth off) sees
// everything; otherwise the caller's org must be in the agent's `orgs` list.
import { describe, it, expect } from 'vitest';
import { agentVisibleToOrg } from '../src/registry.js';

describe('agentVisibleToOrg', () => {
  it('global agent (no orgs) → visible to everyone', () => {
    expect(agentVisibleToOrg({}, undefined)).toBe(true); // operator / auth off
    expect(agentVisibleToOrg({}, 'acme')).toBe(true); // org-bound caller
    expect(agentVisibleToOrg({ orgs: [] }, 'acme')).toBe(true); // empty list == global
  });

  it('operator (no org) → sees every agent, even org-scoped ones', () => {
    expect(agentVisibleToOrg({ orgs: ['acme'] }, undefined)).toBe(true);
    expect(agentVisibleToOrg({ orgs: ['acme', 'globex'] }, undefined)).toBe(true);
  });

  it('org-scoped agent: visible only when the caller org matches', () => {
    expect(agentVisibleToOrg({ orgs: ['acme'] }, 'acme')).toBe(true); // match
    expect(agentVisibleToOrg({ orgs: ['acme'] }, 'globex')).toBe(false); // mismatch
    expect(agentVisibleToOrg({ orgs: ['acme', 'globex'] }, 'globex')).toBe(true); // multi-org match
  });
});
