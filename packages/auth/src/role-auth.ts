// Free default auth provider: viewer/admin roles, bearer + basic, read/write.
// (The paid @gnldev/auth-ee implements the same AuthProvider with SSO/RBAC.)
import type { AuthProvider, Principal, Decision, AuthContext, Cred } from './types.js';
import { safeEqual } from './safe-equal.js';
import { PLATFORM_ADMIN_ROLE } from './scope.js';

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
 * Role-based free auth: `admin` can write+read, `viewer` can only read. Each role can be configured
 * With a bearer token and/or basic user+pass (both fall into the same role). If no role is given,
 * Returns `undefined` → OPT-IN: the gate isn't set up, the existing open behavior is preserved.
 */
export function roleAuth(cfg: { admin?: Cred; viewer?: Cred }): AuthProvider | undefined {
  const admin = credValues(cfg.admin);
  const viewer = credValues(cfg.viewer);
  if (admin.headers.size === 0 && viewer.headers.size === 0) return undefined;

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
   * Principal of the matched role: id (if basic user is present) + organization bound to the identity
   * (Cred.orgId). An EXPLICIT `platformAdmin: true` cred also injects the reserved `platform-admin`
   * Role (scope: 'platform') so the strict EE model recognises the bootstrap root admin — otherwise
   * The roles array is left EXACTLY `[role]` (backward-compat: no extra role appears unless asked for).
   */
  const principalOfRole = (role: 'admin' | 'viewer', cred?: Cred): Principal => ({
    roles: cred?.platformAdmin ? [role, PLATFORM_ADMIN_ROLE] : [role],
    ...(cred?.user ? { id: cred.user } : {}),
    ...(cred?.orgId ? { orgId: cred.orgId } : {}),
  });

  return {
    authenticate(req: Request): Principal | null {
      if (admin.headers.size && matchRole(req, admin)) return principalOfRole('admin', cfg.admin);
      if (viewer.headers.size && matchRole(req, viewer)) return principalOfRole('viewer', cfg.viewer);
      return null;
    },
    authorize(principal: Principal | null, _req: Request, ctx: AuthContext): Decision {
      const roles = principal?.roles ?? [];
      if (ctx.action === 'write') {
        return roles.includes('admin') ? { allow: true } : { allow: false, status: 403, reason: 'unauthorized (admin required)' };
      }
      return roles.includes('admin') || roles.includes('viewer')
        ? { allow: true }
        : { allow: false, status: 401, reason: 'unauthorized' };
    },
    capabilities() {
      return { sso: false, rbac: false, audit: false, multiOrganization: false, users: false };
    },
  };
}
