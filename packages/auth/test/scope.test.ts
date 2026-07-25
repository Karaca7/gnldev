// Pure scope/platform-admin helpers (see src/scope.ts). Two axes stay separate: SCOPE (where) vs ROLE
// (what). The platform grant is EXPLICIT (the `platform-admin` role) — NEVER inferred from a missing orgId.
import { describe, it, expect } from 'vitest';
import { isPlatformAdmin, principalScope, PLATFORM_ADMIN_ROLE, roleAuth, assertAssignablePrivileges } from '../src/index.js';
import type { Principal } from '../src/index.js';

describe('@gnldev/auth scope helpers', () => {
  it('isPlatformAdmin: ONLY the explicit platform-admin role grants it (org-less alone does NOT)', () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
    expect(isPlatformAdmin({ roles: ['admin'] })).toBe(false);            // org-less admin ≠ platform admin
    expect(isPlatformAdmin({ roles: ['admin'], orgId: 'acme' })).toBe(false);
    expect(isPlatformAdmin({ roles: [PLATFORM_ADMIN_ROLE] })).toBe(true);
    expect(isPlatformAdmin({ roles: ['admin', 'platform-admin'] })).toBe(true);
  });

  it('principalScope: platform grant wins > org binding > none', () => {
    expect(principalScope(null)).toEqual({ kind: 'none' });
    expect(principalScope({ roles: ['admin'] })).toEqual({ kind: 'none' });          // fail-closed under strict
    expect(principalScope({ roles: ['viewer'], orgId: 'acme' })).toEqual({ kind: 'org', orgId: 'acme' });
    expect(principalScope({ roles: ['platform-admin'] })).toEqual({ kind: 'platform' });
    // explicit platform grant intentionally overrides an org binding (cross-org actor)
    expect(principalScope({ roles: ['platform-admin'], orgId: 'acme' })).toEqual({ kind: 'platform' });
  });

  it('roleAuth injects the platform-admin role ONLY when Cred.platformAdmin is set (back-compat otherwise)', () => {
    const plain = roleAuth({ admin: { token: 'a' } })!;
    const plat = roleAuth({ admin: { token: 'a', platformAdmin: true } })!;
    // authenticate returns a Principal for a matching bearer via a fake Hono-ish context
    const ctx = (tok: string): any => ({ req: { header: (h: string) => (h === 'authorization' ? `Bearer ${tok}` : undefined), query: () => undefined } });
    expect((plain.authenticate(ctx('a')) as Principal).roles).toEqual(['admin']);
    expect((plat.authenticate(ctx('a')) as Principal).roles).toEqual(['admin', PLATFORM_ADMIN_ROLE]);
    expect(isPlatformAdmin(plat.authenticate(ctx('a')) as Principal)).toBe(true);
  });

  it('assertAssignablePrivileges: a non-platform-admin CANNOT mint platform-admin or "*" (privilege ceiling)', () => {
    const orgAdmin: Principal = { roles: ['admin'], orgId: 'acme' };
    // the CRIT: org-admin tries to self-grant / create a platform super-admin → rejected
    expect(assertAssignablePrivileges(orgAdmin, { roles: ['platform-admin'] }).ok).toBe(false);
    expect(assertAssignablePrivileges(orgAdmin, { roles: ['admin', 'platform-admin'] }).ok).toBe(false);
    // the permission-axis equivalent super-grant is equally rejected
    expect(assertAssignablePrivileges(orgAdmin, { permissions: ['*'] }).ok).toBe(false);
    // ordinary org roles/permissions stay assignable (target keeps its orgId → no cross-org escalation)
    expect(assertAssignablePrivileges(orgAdmin, { roles: ['viewer'] }).ok).toBe(true);
    expect(assertAssignablePrivileges(orgAdmin, { roles: ['member'], permissions: ['agents:run'] }).ok).toBe(true);
    expect(assertAssignablePrivileges(orgAdmin, {}).ok).toBe(true);
  });

  it('assertAssignablePrivileges: a platform-admin may assign anything (incl. platform-admin and "*")', () => {
    const platAdmin: Principal = { roles: ['platform-admin'] };
    expect(assertAssignablePrivileges(platAdmin, { roles: ['platform-admin'] }).ok).toBe(true);
    expect(assertAssignablePrivileges(platAdmin, { permissions: ['*'] }).ok).toBe(true);
    // a null/unauthenticated assigner is NOT platform-admin → held to the ceiling
    expect(assertAssignablePrivileges(null, { roles: ['platform-admin'] }).ok).toBe(false);
  });
});
