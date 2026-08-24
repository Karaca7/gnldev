// Free default auth provider: four credential CLASSES, bearer + basic.
// (The paid @gnldev/auth-ee implements the same AuthProvider with SSO/RBAC.)
//
// The classes exist because "admin" was doing two unrelated jobs, and measurement showed the cost of
// each. (1) An application's day-to-day calls — running an agent, sending a prompt — required the
// `admin` token, the SAME token that cancels runs, reads the whole organization's history and reads
// `/usage`. A customer's backend therefore carried the deployment's management key to do routine work.
// (2) The operator who runs the PLATFORM belongs to no single organization by construction, so the
// org-isolation fail-closed rule (server/studio `orgIsolationActive`) denied it along with the
// accidental unbound admin it was written to stop — 39 tests across 11 files were that persona.
//
//   superAdmin  the platform operator. Unbound BY DESIGN → carries `platform-admin` (scope.ts).
//   admin       an organization's manager. Studio, governance, everything inside one org.
//   client      an application's server-to-server credential. Runs agents; manages nothing.
//   viewer      read-only.
//
// `client` is deliberately a WHITELIST, not "admin minus a few things": a write whose permission this
// file does not name is denied. A route added later without a name costs a 403 (visible, reported)
// instead of silently widening what every deployed application credential can reach.
import type { AuthProvider, Principal, Decision, AuthContext, Cred } from './types.js';
import { safeEqual } from './safe-equal.js';
import { PLATFORM_ADMIN_ROLE } from './scope.js';

/** The reserved role naming the application credential class (see `CLIENT_WRITES`). */
export const CLIENT_ROLE = 'client';

/**
 * The ONLY writes an application credential may perform — running work, and stopping work it started.
 * Everything else (organization/user/pricing/policy administration, the agent registry, retention)
 * belongs to `admin`.
 *
 * Named permissions only: `AuthContext.permission` is set by the gate's `allowP`, so a route gated
 * with the coarse `allow(req, 'write')` arrives here with `permission: undefined` and is DENIED for
 * this class. That is the point — see the whitelist note in the module header.
 */
export const CLIENT_WRITES: ReadonlySet<string> = new Set([
  'agents:run',
  'workflow:run',
  'run:cancel',
]);

/** Basic auth header value (same base64 logic as studio basicAuth). */
function basicValue(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Accepted Authorization header values + bearer token set for a role (for SSE query fallback). */
function credValues(cred?: Cred): { headers: Set<string>; tokens: Set<string> } {
  const headers = new Set<string>();
  const tokens = new Set<string>();
  if (cred?.token) {
    headers.add(`Bearer ${cred.token}`);
    tokens.add(cred.token);
  }
  if (cred?.user && cred?.pass) headers.add(basicValue(cred.user, cred.pass));
  return { headers, tokens };
}

/**
 * Role-based free auth. Each class can be configured with a bearer token and/or basic user+pass (both
 * fall into the same class). If NO class is given, returns `undefined` → OPT-IN: the gate isn't set
 * up, the existing open behavior is preserved.
 *
 * `{ admin, viewer }` behaves exactly as it did before `superAdmin`/`client` existed — the two new
 * classes are additive, and a config that names neither produces byte-identical decisions.
 */
export function roleAuth(cfg: {
  /**
   * The PLATFORM operator: sees and manages every organization. Unbound by design, and says so —
   * this class carries the reserved `platform-admin` role, which is what the strict/org-isolation
   * models check. `scope.ts` refuses to INFER the platform scope from a missing `orgId`, because
   * forgetting an orgId would then mint a super-admin; naming the class is that grant made explicit.
   */
  superAdmin?: Cred;
  admin?: Cred;
  /** An application's server-to-server credential: runs agents, manages nothing (see `CLIENT_WRITES`). */
  client?: Cred;
  viewer?: Cred;
}): AuthProvider | undefined {
  const superAdmin = credValues(cfg.superAdmin);
  const admin = credValues(cfg.admin);
  const client = credValues(cfg.client);
  const viewer = credValues(cfg.viewer);
  if (superAdmin.headers.size === 0 && admin.headers.size === 0 && client.headers.size === 0 && viewer.headers.size === 0) {
    return undefined;
  }

  // SafeEqual loop instead of Set.has (===): so the secret comparison is constant-time (the number of
  // Accepted tokens/basics per role is small — loop cost is negligible).
  const matchRole = (req: Request, role: { headers: Set<string>; tokens: Set<string> }): boolean => {
    const h = req.headers.get('authorization') ?? undefined;
    if (h && [...role.headers].some((v) => safeEqual(h, v))) return true;
    /**
     * EventSource can't send headers → ?token= bearer fallback (bearer tokens only).
     * SECURITY NOTE — log-leak risk: a token carried in the query string can leak into web
     * Server/proxy access logs, browser history, and (if the URL is shared/redirected) the
     * `Referer` header. This fallback only remains because of the EventSource constraint; prefer
     * @gnldev/studio's short-lived (60s TTL) one-time `POST /auth/sse-ticket` → `?ticket=` flow where
     * Possible (see the `/events` endpoint in packages/studio/src/server.ts) — the persistent secret
     * Is never carried in the URL.
     */
    // GET only. The constraint this exists for is EventSource, which cannot send headers and only
    // ever issues a GET — so accepting it on POST/DELETE bought nothing, and it authenticated an
    // admin retention purge from a URL, which lands in proxy logs, browser history and `Referer`.
    // The short-lived `?ticket=` flow named above is the preferred path even for the GET.
    if (req.method.toUpperCase() !== 'GET') return false;
    const q = new URL(req.url).searchParams.get('token') ?? undefined;
    return !!q && [...role.tokens].some((v) => safeEqual(q, v));
  };

  /**
   * Principal of the matched class: id (if basic user is present) + organization bound to the identity
   * (Cred.orgId).
   *
   * `superAdmin` carries `admin` too, so every existing `roles.includes('admin')` check — here, in
   * @gnldev/server, in @gnldev/studio — keeps working without knowing the class exists; the added
   * `platform-admin` is what widens its SCOPE (scope.ts `principalScope`).
   *
   * The pre-existing `platformAdmin: true` cred flag still injects the same role on any class, so
   * configs written before `superAdmin` existed are unaffected. Prefer the class: it says which
   * credential this IS, rather than adding a privilege to one that reads as an ordinary admin.
   */
  const principalOfRole = (role: 'admin' | 'viewer' | typeof CLIENT_ROLE, cred?: Cred, platform = false): Principal => {
    const roles = role === 'admin' && platform ? ['admin', PLATFORM_ADMIN_ROLE] : [role];
    return {
      roles: cred?.platformAdmin && !roles.includes(PLATFORM_ADMIN_ROLE) ? [...roles, PLATFORM_ADMIN_ROLE] : roles,
      ...(cred?.user ? { id: cred.user } : {}),
      ...(cred?.orgId ? { orgId: cred.orgId } : {}),
    };
  };

  return {
    authenticate(req: Request): Principal | null {
      // Most-privileged first: a token configured for two classes resolves to the stronger one, which
      // is the safe direction for `authenticate` (the weaker class would silently under-authorize a
      // credential the host declared as an operator).
      if (superAdmin.headers.size && matchRole(req, superAdmin)) return principalOfRole('admin', cfg.superAdmin, true);
      if (admin.headers.size && matchRole(req, admin)) return principalOfRole('admin', cfg.admin);
      if (client.headers.size && matchRole(req, client)) return principalOfRole(CLIENT_ROLE, cfg.client);
      if (viewer.headers.size && matchRole(req, viewer)) return principalOfRole('viewer', cfg.viewer);
      return null;
    },
    authorize(principal: Principal | null, _req: Request, ctx: AuthContext): Decision {
      const roles = principal?.roles ?? [];
      if (ctx.action === 'write') {
        if (roles.includes('admin')) return { allow: true };
        // An application credential may only perform writes this file NAMES. `ctx.permission` is
        // undefined for a route gated with the coarse `allow(req,'write')` — denied, deliberately.
        if (roles.includes(CLIENT_ROLE)) {
          return ctx.permission && CLIENT_WRITES.has(ctx.permission)
            ? { allow: true }
            : { allow: false, status: 403, reason: `unauthorized (client credentials cannot ${ctx.permission ?? 'perform this write'})` };
        }
        return { allow: false, status: 403, reason: 'unauthorized (admin required)' };
      }
      return roles.includes('admin') || roles.includes(CLIENT_ROLE) || roles.includes('viewer')
        ? { allow: true }
        : { allow: false, status: 401, reason: 'unauthorized' };
    },
    capabilities() {
      return { sso: false, rbac: false, audit: false, multiOrganization: false, users: false };
    },
  };
}
