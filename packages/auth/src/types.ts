// @gnldev/auth — stable auth contract. The free core defines this; @gnldev/auth-ee (paid) implements the
// same interface → premium (RBAC/SSO/multi-organization/audit) plugs in without touching the core.
import type { Context } from 'hono';

/**
 * The authenticated subject. The free tier only uses `roles`; the `permissions`/`orgId` fields are
 * ALREADY reserved for EE (fine-grained RBAC + multi-organization) → the schema won't break later.
 */
export interface Principal {
  id?: string;
  roles: string[];
  /** The field name identifying an organization — auth-ee/server/studio and stored records use this name. */
  orgId?: string;
  permissions?: string[];
  [k: string]: unknown;
}

/** Description of what's being accessed — the provider can decide based on path/method/action/resource. */
export interface AuthContext {
  path: string;
  method: string;
  action: 'read' | 'write';
  resource?: string;
  /**
   * EE fine-grained permission (e.g. 'agents:run', 'users:write'). Set by the gate's `allowP`. When
   * present, an RBAC provider matches THIS exact permission instead of deriving one from resource/action
   * (see @gnldev/auth-ee rbac.ts `requiredPermission`). A free/read-write provider ignores it and falls back
   * to `action` (the gate already reduces the permission to read/write) → coarse but backward-compatible.
   */
  permission?: string;
}

/** The authorization decision. A denial carries `status` (401 identity / 403 authorization) + an optional reason. */
export type Decision = { allow: true } | { allow: false; status?: 401 | 403; reason?: string };

/** Capabilities declared by the provider → studio `/capabilities` → opens premium UI surfaces. */
export interface AuthCapabilities {
  sso: boolean;
  rbac: boolean;
  audit: boolean;
  multiOrganization: boolean;
  users: boolean;
  /** EE: license plan name ('pro'/'enterprise'/'dev') — UI badge. Not present in the free tier. */
  plan?: string;
  /** EE: license expiry (epoch ms) — UI expiry warning. Not present when unlimited/free. */
  licenseExp?: number;
}

/**
 * Auth provider contract. The host (server/studio) calls `authenticate` first, then `authorize`.
 * `capabilities` is optional (the free tier declares all of them false).
 */
export interface AuthProvider {
  authenticate(c: Context): Promise<Principal | null> | Principal | null;
  authorize(principal: Principal | null, c: Context, ctx: AuthContext): Promise<Decision> | Decision;
  capabilities?(): Partial<AuthCapabilities>;
}

/**
 * Credentials for a single role: bearer token and/or basic user+pass. If `orgId` is given, the
 * identity is BOUND to that organization: hosts (server/studio) derive the organization scope from
 * the principal instead of the header; a different `x-gnl-org` request gets a 403 (organization
 * isolation is enforced by identity, it cannot be spoofed).
 */
export type Cred = {
  token?: string;
  user?: string;
  pass?: string;
  orgId?: string;
  /**
   * EXPLICIT platform-admin grant (scope: 'platform') — see @gnldev/auth scope.ts. Injects the reserved
   * `platform-admin` role into the principal. Use it to bootstrap a statically-configured root admin
   * that the strict (EE multi-org) model must recognise as cross-org; WITHOUT it, an unbound identity
   * is denied under the strict model (fail-closed). Harmless in the free tier (the role is inert there).
   */
  platformAdmin?: boolean;
};
