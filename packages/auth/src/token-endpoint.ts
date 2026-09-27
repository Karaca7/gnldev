// The application's half of end-user token refresh. GNL is stateless: it verifies a token and keeps
// nothing, so there is no GNL refresh token. The application already HAS the state that decides
// whether a user is still logged in — its own session — and this handler turns "session still valid"
// into a fresh short-lived token, and "no session" into a 401 the browser client surfaces.
import { randomUUID } from 'node:crypto';
import { MAX_SUBJECT_TTL_SEC, MIN_SUBJECT_SECRET_BYTES, signSubjectToken } from './jwt.js';
import { isCrossSiteStateChange } from './same-site.js';

/** What the application's session says about the caller: the user, and optionally the session's id. */
export interface SubjectSession {
  sub: string;
  /** Becomes the token's `jti`, so `endUsers.isRevoked` can refuse every token of a logged-out session. */
  sid?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    // A bearer in a response must never be cached by the browser or a proxy.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' },
  });

/**
 * A `Request → Response` handler for the application's own `/gnl-token` route. POST only; refuses a
 * cross-site request (Fetch Metadata / Origin), because the route is authenticated by the app's
 * cookie and answers with a bearer. It sets NO CORS headers — do not add any.
 *
 * `sessionOf` is the application's session lookup; `null` means logged out → 401.
 */
export function subjectTokenEndpoint(
  sessionOf: (req: Request) => SubjectSession | null | Promise<SubjectSession | null>,
  secret: string,
  opts: { ttlSec?: number } = {},
): (req: Request) => Promise<Response> {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SUBJECT_SECRET_BYTES) {
    throw new Error(`@gnldev/auth: subjectTokenEndpoint needs a secret of at least ${MIN_SUBJECT_SECRET_BYTES} bytes`);
  }
  const ttlSec = opts.ttlSec ?? 300;
  if (!(ttlSec > 0) || ttlSec > MAX_SUBJECT_TTL_SEC) {
    throw new Error(`@gnldev/auth: subjectTokenEndpoint ttlSec must be in (0, ${MAX_SUBJECT_TTL_SEC}]`);
  }
  return async (req) => {
    if (req.method.toUpperCase() !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (isCrossSiteStateChange(req)) return json(403, { error: 'cross_site' });
    let session: SubjectSession | null;
    try {
      session = await sessionOf(req);
    } catch {
      session = null; // a lookup that fails does not mint
    }
    if (!session || typeof session.sub !== 'string' || session.sub === '') return json(401, { error: 'no_session' });
    const now = Date.now();
    const token = signSubjectToken({ sub: session.sub, jti: session.sid ?? randomUUID() }, secret, { ttlSec, now });
    return json(200, { token, expiresAt: Math.floor(now / 1000) + ttlSec });
  };
}
