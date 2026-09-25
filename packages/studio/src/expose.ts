// How the Studio CLI reads its own flags and gnl.config — the DECISION itself lives in
// `@gnldev/auth`'s exposure.ts.
//
// This file used to own that decision, and `packages/cli/src/bind.ts` owned a second copy of it. Run
// against the same hosts the two disagreed four ways, and this copy was the one that treated
// `127.0.0.1.evil.com` as loopback and answered "auth: protected" for `admin-dev` — a token published
// in this project's own npm tarball. Both holes are closed by deferring to the one decision; read
// exposure.ts's header for the measurements and for why @gnldev/cli still carries a pinned copy.
//
// What stays here is what is genuinely Studio's: how gnl.config's `auth` field becomes a provider, and
// the remedy sentence naming Studio's own flags.

import { roleAuth, decideExposure, isLoopbackHost, type AuthProvider, type Cred, type ExposureDecision } from '@gnldev/auth';

export { isLoopbackHost };
export type { ExposureDecision };

/** The remedy sentence for this surface: Studio reads auth from gnl.config, which needs --config. */
const STUDIO_AUTH_REMEDY =
  'Configure auth in gnl.config (`auth: { admin: { token: ... } }`) and pass --config.';

export interface StudioExposureInput {
  /** The `--host` value as given, before normalisation. */
  host: string;
  /** Did an auth provider actually RESOLVE — not "was one configured". */
  authed: boolean;
  /** `--allow-open-network` was passed. */
  allowOpenNetwork: boolean;
  /**
   * The literal token values gnl.config's `auth` was built from, when there are any. Forwarded so the
   * shared decision can apply the published-credential rule — the rule this file used to lack.
   */
  credentialTokens?: Iterable<string | undefined>;
}

export function decideStudioExposure(input: StudioExposureInput): ExposureDecision {
  return decideExposure({
    host: input.host,
    authed: input.authed,
    allowOpenNetwork: input.allowOpenNetwork,
    credentialTokens: input.credentialTokens,
    surface: 'gnl studio',
    authRemedy: STUDIO_AUTH_REMEDY,
  });
}

/**
 * gnl.config's `auth`, in either shape it legitimately takes, as a provider.
 *
 * There are two, and conflating them was a fail-open. An AuthProvider (roleAuth(...),
 * @gnldev/auth-ee) passes through. A credential MAP is what `gnl add auth` scaffolds and what the
 * config type declares (`{ admin?: Cred; viewer?: Cred }`) — and forwarding THAT raw to the app was
 * worse than dropping it: normalizeAuth finds no `.authorize` on it, wraps it as a legacy
 * {read,write} pair whose two predicates are both undefined, and adapter.ts then answers
 * `{ allow: true }` for read and write alike. Every endpoint open — while `authed`, computed from
 * the presence of the object, read TRUE, so the banner said "protected" and the non-loopback refusal
 * was skipped. Measured: normalizeAuth({admin:{token:'s3cret'}}).authorize(...) → {"allow":true}.
 *
 * Returns undefined when nothing resolves, so `authed` stays false and the refusal still fires: a
 * provider that cannot authenticate must never read as auth.
 */
export function resolveConfigAuth(auth: unknown): AuthProvider | undefined {
  if (!auth || typeof auth !== 'object') return undefined;
  if (typeof (auth as AuthProvider).authorize === 'function') return auth as AuthProvider;
  const creds = auth as { admin?: Cred; viewer?: Cred };
  if (!creds.admin && !creds.viewer) return undefined;
  return roleAuth({ admin: creds.admin, viewer: creds.viewer });
}

/**
 * The literal token values in gnl.config's `auth`, for the published-credential rule.
 *
 * Only the credential-MAP shape can be read this way; a real AuthProvider keeps its secrets to itself,
 * and returning nothing for one is correct — a provider that authenticates for real is not the case
 * this rule is about.
 */
export function configCredentialTokens(auth: unknown): (string | undefined)[] {
  if (!auth || typeof auth !== 'object') return [];
  if (typeof (auth as AuthProvider).authorize === 'function') return [];
  const creds = auth as { admin?: { token?: string }; viewer?: { token?: string } };
  return [creds.admin?.token, creds.viewer?.token];
}
