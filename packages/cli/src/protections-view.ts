// The identity row, decided ONCE for every surface in this CLI that prints the protections matrix.
//
// `describeProtections` deliberately refuses to guess this one (see its own header): whether a run is
// born with an owner is a property of the ROUTE in front of the config, and durable cannot see a
// route. So the caller fills it in — and there are two callers here, `gnl dev` and `gnl doctor`.
//
// Two callers is exactly one more than it takes to drift. The whole reason the matrix lives in
// @gnldev/durable rather than in the CLI is that this repository already shipped a hand-maintained
// protection banner that said "protected" because a provider existed, while the provider's only
// credential was a token published in the npm tarball. Re-creating that banner's failure mode inside
// the fix, for one row, would be a poor joke.
import type { GnlDevConfig } from './config.js';

/** Shaped like `ProtectionContext['identity']`, without importing the type from an optional peer. */
export interface IdentityRow {
  bound: boolean | 'unknown';
  via?: string;
  from?: 'preset' | 'explicit' | 'default' | 'unknown';
  note?: string;
}

/**
 * What this process can honestly say about who a run belongs to.
 *
 * THE DECLARATION DOES NOT BIND ANYTHING, and the order below is what says so. A config that declares
 * `subjects: 'end-users'` still gets `bound: false` unless a real resolver is in front of it — the
 * declaration is a statement of intent, and treating intent as a protection is how a matrix starts
 * lying. What the declaration DOES buy is the difference between `○` and `?`: an internal tool that
 * said it has no owners is a decision; a config that said nothing is an open question.
 *
 * @param authBound whether the surface in front really resolves a subject (an auth provider with
 *                  credentials that are not the shipped defaults, a route with an `identity` hook).
 */
export function identityRow(config: GnlDevConfig, authBound: boolean): IdentityRow {
  // Read from the CONFIG, so `gnl dev` and `gnl doctor` — which read the same file — say the same
  // thing. `authBound` alone said ✓ whenever a provider existed, while the provider's credentials
  // (admin/viewer tokens) were staff, whose runs have no owner: measured, `gnl dev` printed ✓ and
  // `gnl doctor` ○ for one project.
  if (config.auth?.endUsers || process.env.GNL_END_USER_SECRET) {
    return { bound: true, via: 'end-user tokens (`auth.endUsers`): each user is bound to itself', from: 'explicit' };
  }
  if (config.license || process.env.GNL_LICENSE_KEY) {
    return {
      bound: 'unknown',
      from: 'explicit',
      note: 'the paid provider binds users its user store or SSO minted as subjects; staff it minted are not bound',
    };
  }
  if (authBound && (config.auth?.client || process.env.GNL_CLIENT_TOKEN)) {
    return {
      bound: 'unknown',
      via: 'the application credential, which names the user it acts for',
      from: 'explicit',
      note: 'the `client` credential is trusted to name its user; give end users their own token with `auth.endUsers`',
    };
  }

  if (config.subjects === 'end-users') {
    return {
      bound: false,
      from: 'explicit',
      // Said as a gap rather than as a failure: the project declared end users and this SURFACE is not
      // the one binding them. That is normal — the resolver is wired into the chat/AG-UI route, which
      // `gnl dev`'s REST mount is not. It stops being normal in production, which is why it is a row.
      note: "declared `subjects: 'end-users'` — but no end-user credential is configured; set GNL_END_USER_SECRET (≥32 bytes) or `auth.endUsers` in gnl.config.ts — see src/identity.ts",
    };
  }
  if (config.subjects === 'internal') {
    return {
      bound: false,
      from: 'explicit',
      note: "declared `subjects: 'internal'` — no owner by design, so ownership gates refuse nobody (that is the trade, not a bug)",
    };
  }
  if (authBound) {
    return {
      bound: false,
      from: 'explicit',
      note: 'staff credentials only: a run belongs to the user a request names, or to nobody — add `auth.endUsers` for users with their own token',
    };
  }
  return {
    bound: false,
    from: 'default',
    note: 'no real auth in front: the subject comes from `body.resourceId`, so ownership gates are only as good as the caller',
  };
}
