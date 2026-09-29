// @gnldev/auth — stable auth contract. The free core defines this; @gnldev/auth-ee (paid) implements the
// same interface → premium (RBAC/SSO/multi-organization/audit) plugs in without touching the core.

/**
 * The authenticated subject. The free tier only uses `roles`; the `permissions`/`orgId` fields are
 * ALREADY reserved for EE (fine-grained RBAC + multi-organization) → the schema won't break later.
 */
export interface Principal {
  /**
   * WHAT this caller is. Stamped by whoever MINTED the principal — a credential in the deployment's
   * config, a user record, a verifier the deployment configured — and never read from the request.
   *
   *   operator     staff: works across its scope (an organization, or the platform) and names nobody
   *   application  a server that speaks FOR a user it names on each request (roleAuth's `client`)
   *   subject      a user: speaks for itself, and only itself
   *
   * Required, because the alternative was measured: hosts inferred "operator" from the ABSENCE of
   * `id`, so a named org admin was treated as a user and a nameless end user as staff. Read it through
   * `callerKind` (scope.ts), which reads an unstamped principal fail-closed.
   */
  kind: PrincipalKind;
  id?: string;
  /**
   * WHICH CREDENTIAL spoke, never WHO — the two are different questions and this field exists because
   * one field could not answer both.
   *
   * `id` is a SUBJECT: it answers "whose data is this", and `resolveResourceId`
   * (packages/server/src/index.ts) hands it straight to the memory layer as `ThreadRecord.resourceId`,
   * overriding any subject the request named. `credentialId` is a BUDGET KEY: it answers "who is
   * spending", and is safe to synthesize precisely because nothing reads it as an owner.
   *
   * Measured, which is why the separation is enforced rather than advised: filling `id` with a token
   * fingerprint made `resolveResourceId` return that fingerprint for a caller that had explicitly sent
   * `resourceId: 'user-42'`, collapsing `user-42` and `user-99` into ONE bucket with no error — the
   * shared-bucket regression that function's own comment records as measured and fixed, and a silent
   * drop where its stated rule is "an INVALID value is a 400, not a silent drop".
   *
   * So: rate limiting, admission control and quota accounting may key on this. Memory scoping,
   * ownership and access-control decisions MUST NOT — for those, an absent `id` means the deployment
   * genuinely has no per-caller identity, and that absence is load-bearing information.
   */
  credentialId?: string;
  roles: string[];
  /** The field name identifying an organization — auth-ee/server/studio and stored records use this name. */
  orgId?: string;
  permissions?: string[];
  [k: string]: unknown;
}

/** See `Principal.kind`. Granting anything but `subject` is an operator's decision (`assertAssignablePrivileges`). */
export const PRINCIPAL_KINDS = ['operator', 'application', 'subject'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

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
  authenticate(req: Request): Promise<Principal | null> | Principal | null;
  authorize(principal: Principal | null, req: Request, ctx: AuthContext): Promise<Decision> | Decision;
  capabilities?(): Partial<AuthCapabilities>;
  /**
   * `false` declares that this provider has NO principal model — `authenticate()` returns null for
   * every request, by construction, not because a token was missing. Hosts that scope organizations
   * by identity reject that combination instead of letting a header pick the scope. Omit it (the
   * normal case): a provider that can authenticate needs to say nothing. See `bindsIdentity()`.
   */
  bindsIdentity?: boolean;
  /**
   * Called once per request, when the host has ANSWERED it, with the outcome the caller actually got.
   *
   * `authorize` is asked before the host's own gates (ownership, organization, resource), so its verdict
   * is not the answer: a request `authorize` allowed can still be refused. This hook is where a record of
   * decisions belongs — @gnldev/auth-ee's audit trail is written here, not in `authorize`.
   *
   * A host that answers requests calls it (@gnldev/server, @gnldev/studio, and the chat and AG-UI routes
   * when given `onDecision`). A host that never calls it leaves no record; a provider cannot see answers
   * it is not told about. If it throws, the host answers 500 instead of the response it built — a request
   * whose decision could not be recorded is not delivered.
   */
  onDecision?(decision: AccessDecision): void | Promise<void>;
}

/**
 * Why a request was refused. The first refusal a host records for a request is the one reported.
 *
 *   unauthenticated  no usable identity: no credential, a principal with no name to hold it to, or an
 *                    application credential that named no user
 *   rbac             the provider's role/permission verdict, or the caller's kind does not reach the surface
 *   ownership        the run or thread belongs to someone else (often answered as a 404, to hide it exists)
 *   organization     the organization scope refused it: another organization, no scope, not registered
 *   resource         a resource-level check (the host's `resourceAuth`, e.g. auth-ee FGA) refused it
 *   policy           another host rule answered 401/403 and recorded no finer reason
 */
export type RefusalReason = 'unauthenticated' | 'rbac' | 'ownership' | 'organization' | 'resource' | 'policy';

/** The outcome of one request, as the caller got it. See `AuthProvider.onDecision`. */
export interface AccessDecision {
  principal: Principal | null;
  /** `callerKind(principal)`: a subject and an operator with the same `id` are different callers. */
  kind: PrincipalKind | 'unnamed';
  orgId?: string;
  path: string;
  method: string;
  action: 'read' | 'write';
  /** The fine-grained permission the gate asked, when it asked one. */
  permission?: string;
  resource?: string;
  /** False whenever the caller was refused — including a refusal answered as 404 to hide what exists. */
  allowed: boolean;
  reason?: RefusalReason;
  /** The refusing rule's own words, when it gave any. */
  detail?: string;
  /** The HTTP status the caller got. */
  status: number;
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
