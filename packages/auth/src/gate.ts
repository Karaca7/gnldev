// The shared gate: hosts (server/studio) don't rewrite allow/deny logic.
//
// Takes a web-standard `Request`, not a framework's context object. A host writing an auth callback
// Used to need Hono's `Context` type in its own signature, which quietly tied its Hono version to
// Ours — the same coupling the factories dropped when they stopped returning a Hono app. Everything
// The gate reads (method, path, headers, query) is on `Request`; nothing was lost by narrowing.
import type { AuthProvider, Decision, Principal } from './types.js';
import { isCrossSiteStateChange } from './same-site.js';

export interface Gate {
  /** Is access allowed? true if there's no provider (opt-in: gate not set up → open; see makeGate in production). */
  allow(req: Request, action: 'read' | 'write', resource?: string): Promise<boolean>;
  /**
   * Fine-grained variant of allow(): checks a SPECIFIC permission (e.g. 'agents:run', 'users:write').
   *   • No provider (auth off) → true (unchanged opt-in behavior).
   *   • EE / RBAC provider → the permission is passed through `AuthContext.permission` and matched against
   *     The principal's EFFECTIVE permissions (explicit `permissions[]` ?? role grants) — see rbac.ts.
   *   • Free / read-write provider → the permission is REDUCED to read/write (`:read` suffix → read, else
   *     Write) and evaluated coarsely. This makes `allowP(req,'X:write') ≡ allow(req,'write')` and
   *     `allowP(req,'*:read') ≡ allow(req,'read')` in the free tier → no regression.
   * A denial records its decision against the request (like allow) so `deny()` can surface status/reason.
   */
  allowP(req: Request, permission: string): Promise<boolean>;
  /** Return the denial. If allow() attached its last decision to the context, use its status/reason. */
  deny(req: Request, action: 'read' | 'write'): Response;
}

// Per-request state, keyed by the request itself rather than stashed as a property on it. A Request
// Is somebody else's object; writing hidden fields onto it worked, but it also meant two libraries
// Could pick the same key. A WeakMap cannot collide and cannot leak — the entry dies with the request.
const principals = new WeakMap<Request, Principal>();
const decisions = new WeakMap<Request, Decision>();

/**
 * The principal authenticated during allow() (within the same request). Hosts derive the organization
 * Scope and audit actor from here → closed to header spoofing. Null if allow() hasn't been called yet.
 */
export function principalOf(req: Request): Principal | null {
  return principals.get(req) ?? null;
}

export interface GateOptions {
  /**
   * DELIBERATE permission for a providerless gate in production. Auth stays opt-in; but silent
   * Fail-open is impossible under NODE_ENV=production — either a provider is given or this flag is
   * Explicitly set to true (audit #2).
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
  let warnedCrossSite = false;
  return {
    async allow(req, action, resource) {
      if (!provider) {
        // Open to this machine is not open to every page this machine's browser visits. Without a
        // provider there is no token to ride, so a state change initiated by another site is never
        // something the operator asked for — see same-site.ts for what was measured.
        if (isCrossSiteStateChange(req)) {
          if (!warnedCrossSite) {
            warnedCrossSite = true;
            console.warn(
              '@gnldev/auth: blocked a cross-site write to an open (providerless) surface. A page on ' +
              'another site attempted a state-changing request. Configure auth if this surface is ' +
              'meant to be reachable by other origins.',
            );
          }
          return false;
        }
        if (!warnedOpen && process.env.NODE_ENV !== 'production') {
          warnedOpen = true;
          console.warn(
            '@gnldev/auth: no provider given → ALL endpoints are open (opt-in gate not set up). Add auth before production; for deliberate open access use allowOpenAccess: true.',
          );
        }
        return true;
      }
      const principal = await provider.authenticate(req);
      if (principal) principals.set(req, principal);
      const decision = await provider.authorize(principal, req, {
        path: new URL(req.url).pathname,
        method: req.method,
        action,
        resource,
      });
      if (!decision.allow) decisions.set(req, decision);
      return decision.allow;
    },
    async allowP(req, permission) {
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
      const principal = await provider.authenticate(req);
      if (principal) principals.set(req, principal);
      // Free-tier reduction: anything ending in ':read' is a read, everything else is a write. An RBAC
      // Provider ignores `action` and matches `permission` exactly; a free provider uses this reduced action.
      const action: 'read' | 'write' = permission.endsWith(':read') ? 'read' : 'write';
      const decision = await provider.authorize(principal, req, {
        path: new URL(req.url).pathname,
        method: req.method,
        action,
        permission,
      });
      if (!decision.allow) decisions.set(req, decision);
      return decision.allow;
    },
    deny(req, action) {
      const d = decisions.get(req);
      const denied = d && d.allow === false ? d : undefined;
      const status = denied?.status ?? (action === 'write' ? 403 : 401);
      const reason = denied?.reason ?? (action === 'write' ? 'unauthorized (admin required)' : 'unauthorized');
      return Response.json({ error: reason }, { status });
    },
  };
}
