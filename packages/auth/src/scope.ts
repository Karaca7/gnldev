// Authorization AXES (kept deliberately SEPARATE):
//   • SCOPE — WHERE an identity can act: a single organization (`org:<id>`) OR the whole `platform`.
//   • ROLE  — WHAT it can do: viewer(read) / member(run) / admin(manage) — the existing `roles[]`.
//   • KIND  — WHOSE data it acts on: its own (subject), a user it names (application), or anyone's in
//             its scope (operator). `Principal.kind`, read through `callerKind`.
//
// The platform scope is an EXPLICIT grant, expressed with the reserved `platform-admin` role. It is
// NEVER derived from "the identity happens to have no orgId" — that inference is the classic
// fail-OPEN footgun (forgetting an orgId accidentally minted a super-admin). Hosts that run the strict
// (paid/EE multi-org) model treat an unbound identity WITHOUT this grant as fail-CLOSED (no access).
//
// This module is pure (no host/Hono coupling) → unit-testable in isolation and reusable by
// @gnldev/server, @gnldev/studio and @gnldev/auth-ee.
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from './types.js';

/** The reserved role that grants PLATFORM scope (sees/manages every organization). */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';

/**
 * True if the principal carries the EXPLICIT platform-admin grant (the `platform-admin` role).
 * Being unbound (no `orgId`) alone is NOT enough — that is exactly the accidental-super-admin bug
 * the strict model closes.
 */
export function isPlatformAdmin(principal: Principal | null | undefined): boolean {
  // Staff only. The role is a grant of SCOPE, and a user holding it (only a platform admin can hand
  // it out, but nothing stopped handing it to a subject) could pick any organization by header —
  // measured. A role never makes a caller staff; `kind` does.
  return !!principal?.roles?.includes(PLATFORM_ADMIN_ROLE) && callerKind(principal) === 'operator';
}

/** The resolved SCOPE of an identity (the "where", independent of the role/"what"). */
export type PrincipalScope =
  /** Sees/manages every organization (explicit platform-admin grant). */
  | { kind: 'platform' }
  /** Bound to exactly one organization. */
  | { kind: 'org'; orgId: string }
  /** No organization AND no platform grant → the strict model denies (fail-closed). */
  | { kind: 'none' };

/**
 * Pure scope derivation. Precedence: an EXPLICIT platform grant wins over an org binding (a
 * platform-admin is intentionally cross-org); otherwise a bound `orgId` gives org scope; otherwise
 * `none` (which the strict EE model rejects, and the free model treats as the legacy operator).
 */
export function principalScope(principal: Principal | null | undefined): PrincipalScope {
  if (isPlatformAdmin(principal)) return { kind: 'platform' };
  const orgId = principal?.orgId;
  if (orgId) return { kind: 'org', orgId };
  return { kind: 'none' };
}

/**
 * WHAT this caller is — the one reading every host's ownership decision goes through.
 *
 * `unnamed` is not a kind a principal can carry; it is the answer for a caller that cannot be held to
 * anything: no principal at all, or a subject with no name to bind its data to.
 *
 * An UNSTAMPED principal — a provider written in JavaScript, or a cast — reads fail-closed: a user if
 * it has a name, unnamed if not. It never reads as an operator: staff is declared where the principal
 * is minted, and a missing declaration is the absence of that grant.
 */
export function callerKind(principal: Principal | null | undefined): PrincipalKind | 'unnamed' {
  if (!principal) return 'unnamed';
  if (principal.kind === 'operator' || principal.kind === 'application') return principal.kind;
  // A subject's id is checked HERE, where every consumer asks what a caller is — not only in the one
  // provider that happened to check it. SSO, Auth0/WorkOS and a user store could each mint a user
  // named `operator:ops`, the actor name of the operator `ops`.
  return typeof principal.id === 'string' && subjectIdProblem(principal.id) === null ? 'subject' : 'unnamed';
}

const MAX_SUBJECT_ID = 200;

/**
 * Why a string cannot be an end user's id, or `null` when it can: empty or over 200 characters,
 * a control character (C0, DEL, C1) or a line/paragraph separator — each breaks a log line or a key
 * round-trip, or hides in one — or a prefix reserved for staff and synthetic ids.
 */
export function subjectIdProblem(id: string): 'length' | 'control characters' | 'reserved prefix' | null {
  if (id.length === 0 || id.length > MAX_SUBJECT_ID) return 'length';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(id)) return 'control characters';
  if (isReservedSubjectId(id)) return 'reserved prefix';
  return null;
}

/**
 * Staff and end users share ONE string space for `id` (a basic-auth login, a token's `sub`). Anything
 * that COMPARES an identity across kinds — the engine's actor lock, an ownership stamp — must not let
 * `sub: 'ops'` equal the operator whose login is `ops`. So a non-subject's name is kind-qualified
 * (`operator:ops`, `application:ops`), a subject's name stays exactly the application's user id (it
 * is also the `resourceId`, which applications already store), and these prefixes are RESERVED: a
 * subject id may not start with one (`isReservedSubjectId`), so no user can be minted into them.
 */
export const RESERVED_SUBJECT_PREFIXES: readonly string[] = ['operator:', 'application:', 'role:', 'token:'];

/** True when a would-be subject id sits in a namespace reserved for staff/synthetic ids. */
export function isReservedSubjectId(id: string): boolean {
  return RESERVED_SUBJECT_PREFIXES.some((p) => id.startsWith(p));
}

/** The name an identity comparison uses: a subject's own id, a kind-qualified id for staff, else undefined. */
export function actorIdOf(principal: Principal | null | undefined): string | undefined {
  if (!principal || typeof principal.id !== 'string' || principal.id === '') return undefined;
  const kind = callerKind(principal);
  if (kind === 'unnamed') return undefined; // a subject id that is no user's names nobody
  return kind === 'subject' ? principal.id : `${kind}:${principal.id}`;
}

/** True for exactly the three kinds. For a value that crossed a trust boundary: a body, a row, a callback. */
export function isPrincipalKind(x: unknown): x is PrincipalKind {
  return (PRINCIPAL_KINDS as readonly unknown[]).includes(x);
}

/** Outcome of a privilege-ceiling check (see {@link assertAssignablePrivileges}). */
export type AssignabilityResult = { ok: true } | { ok: false; reason: string };

/**
 * PRIVILEGE CEILING for user-management (create/update). An assigner must NEVER be able to hand out a
 * privilege it does not itself hold — otherwise an org-bound admin could mint itself (or a new user)
 * the reserved `platform-admin` role and walk out of its own org as a cross-org super-admin. The
 * user-management surfaces (@gnldev/studio POST/PATCH /users) validate only the target's ORG, not the
 * ROLE/PERMISSION VALUES; this closes that gap.
 *
 * Rule (deliberately minimal + scope-aware): a platform-admin may assign anything. Anyone else may
 * NOT grant the `platform-admin` role (a cross-org SCOPE escalation) nor the `'*'` all-permissions
 * grant (its permission-axis equivalent). Ordinary org roles/permissions stay inside the assigner's
 * org (the target keeps its `orgId`), so they are not a cross-org escalation and remain assignable.
 */
export function assertAssignablePrivileges(
  assigner: Principal | null | undefined,
  requested: { roles?: string[] | undefined; permissions?: string[] | undefined; kind?: PrincipalKind | undefined },
): AssignabilityResult {
  // KIND first, and for everyone: a platform-admin ROLE on a principal that is not staff is still not
  // staff. Only an operator can create a caller that acts on other people's data.
  if (requested.kind && requested.kind !== 'subject' && callerKind(assigner) !== 'operator') {
    return { ok: false, reason: `only an operator can create a caller of kind '${requested.kind}'` };
  }
  // A platform-admin is already cross-org: it can assign any role/permission.
  if (isPlatformAdmin(assigner)) return { ok: true };
  // The reserved cross-org grant — never mintable by a non-platform-admin.
  if (requested.roles?.includes(PLATFORM_ADMIN_ROLE)) {
    return { ok: false, reason: `only a platform-admin can grant the '${PLATFORM_ADMIN_ROLE}' role` };
  }
  // The all-permissions super-grant on the permission axis — same escalation by another name.
  if (requested.permissions?.includes('*')) {
    return { ok: false, reason: "only a platform-admin can grant the '*' (all-permissions) grant" };
  }
  return { ok: true };
}

/**
 * "Who is this request?", answered once by the application and handed to every door the same way:
 * the REST API, the chat and AG-UI routes, MCP. It reads a session cookie, a verified token or a
 * user store — never the request body — and returns the principal, or nothing for an anonymous one.
 */
export type Identify = (req: Request) => Principal | null | undefined | Promise<Principal | null | undefined>;

/**
 * The engine's caller (@gnldev/durable `Caller`), written structurally so this package keeps depending
 * on nothing. The shapes must stay equal to durable's; a test in each package holds them to it.
 */
export type EngineCaller = { kind: 'user'; id: string; orgId?: string } | { kind: 'staff'; orgId?: string } | { kind: 'unknown' };

/**
 * A principal as the engine's caller — the one mapping every door uses (ADR-0002).
 *
 *   subject      → user, its own id
 *   operator     → staff, in its organization
 *   application  → the user it names on this request (`named`), when that id can be a user's;
 *                  unknown otherwise — an application speaks FOR somebody, never as staff
 *   unnamed      → unknown
 *
 * `unknown` is closed in the engine: it reaches no user's and no staff's record.
 */
export function engineCallerOf(principal: Principal | null | undefined, named?: string): EngineCaller {
  const orgId = principal?.orgId;
  const withOrg = <T extends object>(c: T): T & { orgId?: string } => (orgId ? { ...c, orgId } : c);
  switch (callerKind(principal)) {
    case 'subject':
      return withOrg({ kind: 'user' as const, id: principal!.id! });
    case 'operator':
      return withOrg({ kind: 'staff' as const });
    case 'application':
      return typeof named === 'string' && subjectIdProblem(named) === null ? withOrg({ kind: 'user' as const, id: named }) : { kind: 'unknown' };
    default:
      return { kind: 'unknown' };
  }
}
