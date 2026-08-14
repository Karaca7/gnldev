// Authorization AXES (kept deliberately SEPARATE):
//   • SCOPE — WHERE an identity can act: a single organization (`org:<id>`) OR the whole `platform`.
//   • ROLE  — WHAT it can do: viewer(read) / member(run) / admin(manage) — the existing `roles[]`.
//
// The platform scope is an EXPLICIT grant, expressed with the reserved `platform-admin` role. It is
// NEVER derived from "the identity happens to have no orgId" — that inference is the classic
// Fail-OPEN footgun (forgetting an orgId accidentally minted a super-admin). Hosts that run the strict
// (paid/EE multi-org) model treat an unbound identity WITHOUT this grant as fail-CLOSED (no access).
//
// This module is pure (no host/Hono coupling) → unit-testable in isolation and reusable by
// @gnldev/server, @gnldev/studio and @gnldev/auth-ee.
import type { Principal } from './types.js';

/** The reserved role that grants PLATFORM scope (sees/manages every organization). */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';

/**
 * True if the principal carries the EXPLICIT platform-admin grant (the `platform-admin` role).
 * Being unbound (no `orgId`) alone is NOT enough — that is exactly the accidental-super-admin bug
 * The strict model closes.
 */
export function isPlatformAdmin(principal: Principal | null | undefined): boolean {
  return !!principal?.roles?.includes(PLATFORM_ADMIN_ROLE);
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
 * Platform-admin is intentionally cross-org); otherwise a bound `orgId` gives org scope; otherwise
 * `none` (which the strict EE model rejects, and the free model treats as the legacy operator).
 */
export function principalScope(principal: Principal | null | undefined): PrincipalScope {
  if (isPlatformAdmin(principal)) return { kind: 'platform' };
  const orgId = principal?.orgId;
  if (orgId) return { kind: 'org', orgId };
  return { kind: 'none' };
}

/** Outcome of a privilege-ceiling check (see {@link assertAssignablePrivileges}). */
export type AssignabilityResult = { ok: true } | { ok: false; reason: string };

/**
 * PRIVILEGE CEILING for user-management (create/update). An assigner must NEVER be able to hand out a
 * Privilege it does not itself hold — otherwise an org-bound admin could mint itself (or a new user)
 * The reserved `platform-admin` role and walk out of its own org as a cross-org super-admin. The
 * User-management surfaces (@gnldev/studio POST/PATCH /users) validate only the target's ORG, not the
 * ROLE/PERMISSION VALUES; this closes that gap.
 *
 * Rule (deliberately minimal + scope-aware): a platform-admin may assign anything. Anyone else may
 * NOT grant the `platform-admin` role (a cross-org SCOPE escalation) nor the `'*'` all-permissions
 * Grant (its permission-axis equivalent). Ordinary org roles/permissions stay inside the assigner's
 * Org (the target keeps its `orgId`), so they are not a cross-org escalation and remain assignable.
 */
export function assertAssignablePrivileges(
  assigner: Principal | null | undefined,
  requested: { roles?: string[] | undefined; permissions?: string[] | undefined },
): AssignabilityResult {
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
