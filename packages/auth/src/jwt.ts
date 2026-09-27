// Verifying and minting the tokens GNL accepts. Free: an end user holding a credential of its own is
// not a paid feature (see `roleAuth`'s `endUsers`). @gnldev/auth-ee's SSO providers verify through the
// same `verifyJwt`.
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { Principal, PrincipalKind } from './types.js';
import { isPrincipalKind } from './scope.js';

/** JWT header (only `alg` is used — cross-checked below against the key type to prevent alg-confusion). */
interface JwtHeader { alg: string; typ?: string; }
/** Standard + custom claims. */
interface JwtClaims {
  exp?: number;
  /** Not-before (NumericDate). Optional per RFC 7519 — absent means no lower bound. */
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  [claim: string]: unknown;
}

export interface JwtVerifyOptions {
  /** Shared secret for HS256 verification. If `secret` is given, only HS256 is accepted. */
  secret?: string;
  /**
   * Public key for RS256/Ed25519 verification: PEM (`-----BEGIN...`) or, following the license.ts
   * pattern, base64url DER (spki). The expected `alg` is auto-selected from the key type (rsa→RS256, ed25519→EdDSA).
   */
  publicKey?: string;
  /** Expected issuer (`iss` claim); unchecked if unset. */
  issuer?: string;
  /** Expected audience (`aud` claim, can be a string or string[]); unchecked if unset. */
  audience?: string;
  /** JWT claim name → Principal field mapping. Default: id←sub, roles←roles, orgId←orgId. */
  claimMap?: { id?: string; roles?: string; orgId?: string };
  /**
   * Which verified tokens are STAFF. Default: none — every login is a `subject` (a user), and a `kind`
   * claim in the token is never read on its own: whoever controls a claim nobody configured would be
   * choosing their own grant. Write this to name the claims your identity provider uses for staff,
   * e.g. `(c) => c.groups?.includes('gnl-ops') ? 'operator' : 'subject'`. A return value that is not a
   * kind reads as `subject`. See @gnldev/auth `Principal.kind`.
   */
  kindOf?: (claims: Record<string, unknown>) => PrincipalKind;
  /** Receives the verified claims (after signature/exp/nbf/iss/aud pass), for a caller that checks more than a Principal carries. */
  onClaims?: (claims: Record<string, unknown>) => void;
}

/** Shortest HS256 secret `endUsers`/`signSubjectToken` accept (RFC 7518 §3.2: key >= hash output). */
export const MIN_SUBJECT_SECRET_BYTES = 32;
/** Default ceiling on an end-user token's remaining lifetime, in seconds — and the hard one without `isRevoked`. */
export const MAX_SUBJECT_TTL_SEC = 3600;
/**
 * Ceiling when the deployment can revoke (`endUsers.isRevoked`). A token that can be taken back may
 * live longer: a credential pasted into an MCP client's config, a link in an email. 30 days.
 */
export const MAX_REVOCABLE_SUBJECT_TTL_SEC = 30 * 24 * 3600;

/**
 * Decodes a base64url segment into a Buffer. @gnldev/auth-ee's Auth0 provider reads the id_token
 * header with it — exported so a second decoder is not maintained; its behavior must not change.
 */
export const b64uDecode = (s: string): Buffer => Buffer.from(s, 'base64url');

function loadPublicKey(pub: string): KeyObject {
  // If PEM, use directly; otherwise assume base64url DER (spki) following the license.ts pattern.
  if (pub.includes('BEGIN')) return createPublicKey(pub);
  return createPublicKey({ key: b64uDecode(pub), format: 'der', type: 'spki' });
}

/** Extracts the JWT from the request: a custom header (if given, the `Bearer ` prefix is optional) or Authorization: Bearer. */
export function jwtFromRequest(req: Request, headerName?: string): string | undefined {
  if (headerName) {
    const v = req.headers.get(headerName);
    if (!v) return undefined;
    return v.startsWith('Bearer ') ? v.slice(7) : v;
  }
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/**
 * Verifies a JWT (signature + exp + iss/aud) and derives a Principal from its claims. Invalid/expired/malformed
 * → `null` (falls into the fallback chain) — never throws.
 *
 * ONE verifier for every token GNL accepts: `roleAuth`'s `endUsers` class here, and @gnldev/auth-ee's
 * `createJwtSso`, Auth0 and WorkOS-session providers, which pass a JWKS-derived PEM as `publicKey`.
 * It lived in auth-ee alone until the free tier needed to verify an end user's token too; it was
 * MOVED here, not copied, so a fix to it is a fix everywhere.
 */
export function verifyJwt(token: string, opts: JwtVerifyOptions, now: number): Principal | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(b64uDecode(headerB64).toString('utf8')) as JwtHeader;
    const claims = JSON.parse(b64uDecode(payloadB64).toString('utf8')) as JwtClaims;
    const sig = b64uDecode(sigB64);
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');

    // Signature: alg is derived from the EXPECTED key type (the token header's alg is never blindly
    // trusted → this is how the classic "alg confusion" attack is prevented).
    let verified: boolean;
    if (opts.secret != null) {
      if (header.alg !== 'HS256') return null;
      const expected = createHmac('sha256', opts.secret).update(signingInput).digest();
      verified = expected.length === sig.length && timingSafeEqual(expected, sig);
    } else if (opts.publicKey != null) {
      const key = loadPublicKey(opts.publicKey);
      if (key.asymmetricKeyType === 'ed25519') {
        if (header.alg !== 'EdDSA') return null;
        verified = verifySignature(null, signingInput, key, sig);
      } else if (key.asymmetricKeyType === 'rsa') {
        if (header.alg !== 'RS256') return null;
        verified = verifySignature('sha256', signingInput, key, sig);
      } else {
        return null; // unsupported key type
      }
    } else {
      throw new Error('@gnldev/auth: verifyJwt requires `secret` or `publicKey`');
    }
    if (!verified) return null;

    // exp: seconds per the JWT standard (NumericDate) — REQUIRED for an SSO session token
    // (a perpetual session token is a security hole).
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
    if (now > claims.exp * 1000) return null;

    // nbf: the other half of the same sentence, and it was missing. RFC 7519 §4.1.5 — the current
    // time MUST be at or after `nbf`, or the token is not yet valid. Unlike `exp` this one is
    // OPTIONAL (an issuer that omits it is not saying "valid since forever", it is saying nothing),
    // so absence passes and only a present, future `nbf` refuses.
    //
    // Why it matters here: `exp` is not merely checked but REQUIRED above, because a session token
    // that never expires is a hole. A token that is not yet valid is the same hole pointed the other
    // way — an issuer that pre-mints credentials ("this one activates Monday") had them working
    // immediately. Measured before this line existed: a token with nbf one YEAR out verified fine.
    //
    // The small leeway the RFC allows is deliberately NOT taken: this verifier has no clock-skew
    // budget anywhere else (see `exp` above), and inventing one here would make two time claims
    // disagree about how much the clock can lie.
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) return null;
      if (now < claims.nbf * 1000) return null;
    }

    if (opts.issuer != null && claims.iss !== opts.issuer) return null;
    if (opts.audience != null) {
      const aud = claims.aud;
      const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
      if (!audOk) return null;
    }

    const map = {
      id: opts.claimMap?.id ?? 'sub',
      roles: opts.claimMap?.roles ?? 'roles',
      orgId: opts.claimMap?.orgId ?? 'orgId',
    };
    const idVal = claims[map.id];
    const rolesVal = claims[map.roles];
    const roles = Array.isArray(rolesVal) ? rolesVal.map(String) : typeof rolesVal === 'string' ? [rolesVal] : [];
    const orgVal = claims[map.orgId];

    opts.onClaims?.(claims);
    const principal: Principal = { kind: declaredKind(opts.kindOf, claims), roles };
    if (typeof idVal === 'string') principal.id = idVal;
    if (typeof orgVal === 'string') principal.orgId = orgVal;
    return principal;
  } catch {
    return null; // malformed base64/JSON, an unrecognized error, etc. → treated as invalid, never thrown.
  }
}

/** `kindOf` applied fail-closed: absent, throwing, or returning a non-kind all mean `subject`. */
export function declaredKind<T>(kindOf: ((x: T) => PrincipalKind) | undefined, x: T): PrincipalKind {
  if (!kindOf) return 'subject';
  try {
    const k = kindOf(x);
    return isPrincipalKind(k) ? k : 'subject';
  } catch {
    return 'subject';
  }
}

/**
 * Mints an HS256 token for ONE end user — what an application calls when its user logs in, to hand
 * that user a credential for `roleAuth({ endUsers: { secret } })`.
 *
 * `exp` is always set (`ttlSec`, default 15 minutes): the verifier refuses a token without one, and a
 * credential held by a browser should die on its own. Only `sub` names the user. Other claims are
 * carried but NOT read by `endUsers`: kind, roles and organization come from the deployment's config.
 */
export function signSubjectToken(
  claims: { sub: string } & Record<string, unknown>,
  secret: string,
  opts: { ttlSec?: number; now?: number } = {},
): string {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SUBJECT_SECRET_BYTES) {
    throw new Error(`@gnldev/auth: signSubjectToken needs a secret of at least ${MIN_SUBJECT_SECRET_BYTES} bytes`);
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const input = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iat: now, ...claims, exp: now + (opts.ttlSec ?? 900) })}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
