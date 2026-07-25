// Shared Hono gate: hosts (server/studio) don't rewrite allow/deny logic.
// (Generalized form of the allow/deny pattern in studio/src/server.ts:292-297.)
import type { Context } from 'hono';
import type { AuthProvider, Decision, Principal } from './types.js';

export interface Gate {
  /** Is access allowed? true if there's no provider (opt-in: gate not set up → open; see makeGate in production). */
  allow(c: Context, action: 'read' | 'write', resource?: string): Promise<boolean>;
  /**
   * Fine-grained variant of allow(): checks a SPECIFIC permission (e.g. 'agents:run', 'users:write').
   *   • No provider (auth off) → true (unchanged opt-in behavior).
   *   • EE / RBAC provider → the permission is passed through `AuthContext.permission` and matched against
   *     the principal's EFFECTIVE permissions (explicit `permissions[]` ?? role grants) — see rbac.ts.
   *   • Free / read-write provider → the permission is REDUCED to read/write (`:read` suffix → read, else
   *     write) and evaluated coarsely. This makes `allowP(c,'X:write') ≡ allow(c,'write')` and
   *     `allowP(c,'*:read') ≡ allow(c,'read')` in the free tier → no regression.
   * A denial attaches its decision to the context (like allow) so `deny()` can surface status/reason.
   */
  allowP(c: Context, permission: string): Promise<boolean>;
  /** Return the denial. If allow() attached its last decision to the context, use its status/reason. */
  deny(c: Context, action: 'read' | 'write'): Response;
}

const DECISION_KEY = '__gnlAuthDecision';
const PRINCIPAL_KEY = '__gnlPrincipal';

/**
 * The principal authenticated during allow() (within the same request). Hosts derive the organization
 * scope and audit actor from here → closed to header spoofing. Null if allow() hasn't been called yet.
 */
export function principalOf(c: Context): Principal | null {
  const p = (c as unknown as Record<string, unknown>)[PRINCIPAL_KEY];
  return (p as Principal | undefined) ?? null;
}

export interface GateOptions {
  /**
   * DELIBERATE permission for a providerless gate in production. Auth stays opt-in; but silent
   * fail-open is impossible under NODE_ENV=production — either a provider is given or this flag is
   * explicitly set to true (audit #2).
   */
  allowOpenAccess?: boolean;
}

export function makeGate(provider?: AuthProvider, opts?: GateOptions): Gate {
  // Fail-open audit at SETUP time: in production, a providerless gate can only be set up with the deliberate flag.
  // (If left to request time, the error would blow up on the first request after deploy — an early, clear failure was preferred.)
  if (!provider && process.env.NODE_ENV === 'production' && opts?.allowOpenAccess !== true) {
    throw new Error(
      'auth is required in production; for deliberately open access, set allowOpenAccess: true (see @gnldev/auth makeGate / host options)',
    );
  }
  // Non-production providerless gate: warn ONCE on the first request (no silent openness), then open.
  let warnedOpen = false;
  return {
    async allow(c, action, resource) {
      if (!provider) {
        if (!warnedOpen && process.env.NODE_ENV !== 'production') {
          warnedOpen = true;
          console.warn(
            '@gnldev/auth: no provider given → ALL endpoints are open (opt-in gate not set up). Add auth before production; for deliberate open access use allowOpenAccess: true.',
          );
        }
        return true;
      }
      const principal = await provider.authenticate(c);
      if (principal) (c as unknown as Record<string, unknown>)[PRINCIPAL_KEY] = principal;
      const decision = await provider.authorize(principal, c, {
        path: c.req.path,
        method: c.req.method,
        action,
        resource,
      });
      if (!decision.allow) (c as unknown as Record<string, unknown>)[DECISION_KEY] = decision;
      return decision.allow;
    },
    async allowP(c, permission) {
      if (!provider) {
        // Same opt-in fail-open path as allow(): warn once outside production, then open.
        if (!warnedOpen && process.env.NODE_ENV !== 'production') {
          warnedOpen = true;
          console.warn(
            '@gnldev/auth: no provider given → ALL endpoints are open (opt-in gate not set up). Add auth before production; for deliberate open access use allowOpenAccess: true.',
          );
        }
        return true;
      }
      const principal = await provider.authenticate(c);
      if (principal) (c as unknown as Record<string, unknown>)[PRINCIPAL_KEY] = principal;
      // Free-tier reduction: anything ending in ':read' is a read, everything else is a write. An RBAC
      // provider ignores `action` and matches `permission` exactly; a free provider uses this reduced action.
      const action: 'read' | 'write' = permission.endsWith(':read') ? 'read' : 'write';
      const decision = await provider.authorize(principal, c, {
        path: c.req.path,
        method: c.req.method,
        action,
        permission,
      });
      if (!decision.allow) (c as unknown as Record<string, unknown>)[DECISION_KEY] = decision;
      return decision.allow;
    },
    deny(c, action) {
      const d = (c as unknown as Record<string, unknown>)[DECISION_KEY] as Decision | undefined;
      const denied = d && d.allow === false ? d : undefined;
      const status = denied?.status ?? (action === 'write' ? 403 : 401);
      const reason = denied?.reason ?? (action === 'write' ? 'unauthorized (admin required)' : 'unauthorized');
      return c.json({ error: reason }, status);
    },
  };
}
