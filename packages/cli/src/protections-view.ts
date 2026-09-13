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
  bound: boolean;
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
  if (authBound) return { bound: true, via: 'the authenticated principal', from: 'explicit' };

  if (config.subjects === 'end-users') {
    return {
      bound: false,
      from: 'explicit',
      // Said as a gap rather than as a failure: the project declared end users and this SURFACE is not
      // the one binding them. That is normal — the resolver is wired into the chat/AG-UI route, which
      // `gnl dev`'s REST mount is not. It stops being normal in production, which is why it is a row.
      note: "declared `subjects: 'end-users'` — but nothing in front of THIS surface resolves one; wire src/identity.ts into your route",
    };
  }
  if (config.subjects === 'internal') {
    return {
      bound: false,
      from: 'explicit',
      note: "declared `subjects: 'internal'` — no owner by design, so ownership gates refuse nobody (that is the trade, not a bug)",
    };
  }
  return {
    bound: false,
    from: 'default',
    note: 'no real auth in front: the subject comes from `body.resourceId`, so ownership gates are only as good as the caller',
  };
}
