// `src/identity.ts` — written when `gnl init` is told the project has end users.
//
// A NEW FILE, which is what the iron rule (init-answers.ts) permits: nothing that already exists is
// rewritten, so there is no second version of anything to keep correct. It is also why the answer
// writes a file rather than editing `src/app.ts` — the app file is the host's, and a scaffold that
// reaches into it produces two shapes of app.ts depending on an answer given once, months ago.
//
// WHY IT IS WORTH A FILE AT ALL. Ownership is the one protection that cannot be switched on later
// without rework: a journal full of runs that were born without an owner cannot be retro-fitted with
// one, because nothing recorded who they were for. Every other row in the protections matrix is a
// config line you can add on the day you need it. This one is a decision about what gets written.

/** The skeleton itself. Exported as a string for the same reason the recipes are: it is generated
 *  code, it is never compiled here, and the tests read the text a user actually receives. */
export const IDENTITY_FILE = `// WHO IS EACH RUN FOR? Your users — each holding a short-lived token of their own.
//
// GNL keeps no session. Your app already knows who is logged in; this file turns that into a token
// GNL verifies. The REST API (and the chat surface on it) reads ONLY the token's \`sub\`: the run
// belongs to that user, a request body cannot rename it, and another user reading it gets 404.
//
// SETUP
//   GNL_END_USER_SECRET   at least 32 random bytes, the same value for your app and for GNL
//                         (\`gnl dev\`, and a server from \`--serving own\`, read it as \`auth.endUsers\`).
//   Mount \`gnlToken\` below as POST /gnl-token on YOUR app's own origin.
//   In the browser: new GnlClient({ baseUrl, getToken: tokenFrom('/gnl-token') }) (@gnldev/client),
//   which refreshes before the token expires. APP_ORIGIN lets that browser call GNL directly (CORS;
//   read by \`gnl dev\` and by a server from \`--serving own\`).
//
// THE ONE WRONG ANSWER, said out loud because it is the one people reach for first:
//
//     // NEVER:
//     const userId = (await req.json()).userId;
//
// A user read out of the request body is the caller naming whoever they like. Read it from something
// the SERVER established: a session cookie you verified.
import { subjectTokenEndpoint } from '@gnldev/auth';

/** Your own session lookup. Replace this — it is the only part of this file that is a placeholder.
 *  The token's \`jti\` is \`sessionTokenId(sid)\` — a one-way id, so the cookie's value never reaches
 *  the browser's JavaScript — and logging a session out can revoke its tokens (below). */
async function sessionOf(_req: Request): Promise<{ sub: string; sid?: string } | null> {
  // e.g. const sid = parseCookie(req.headers.get('cookie'))?.sid;
  //      const s = sid ? await sessions.get(sid) : undefined;
  //      return s ? { sub: s.userId, sid } : null;
  return null;
}

/** POST /gnl-token on your app: a fresh 5-minute token while the session lasts, 401 once it does not. */
export async function gnlToken(req: Request): Promise<Response> {
  const secret = process.env.GNL_END_USER_SECRET;
  if (!secret) return new Response('GNL_END_USER_SECRET is not set', { status: 500 });
  return subjectTokenEndpoint(sessionOf, secret, { ttlSec: 300 })(req);
}

// LOGGING OUT. Without more, a token lives until it expires (5 minutes above). To cut it at logout,
// give GNL a revocation check — in gnl.config.ts:
//
//   auth: { endUsers: { secret: process.env.GNL_END_USER_SECRET, isRevoked: ({ jti }) => loggedOut.has(jti) } }
//
// and at logout: loggedOut.add(sessionTokenId(sid))   — sessionTokenId from '@gnldev/auth'
//
// ERASING ONE PERSON — the request you answer in days, not by waiting for a sweep. Retention
// (\`gnl sweep --older-than 30d\`) deletes by AGE and knows nothing about people:
//
//   import { eraseSubject } from '@gnldev/durable';
//   // every run, thread, message, working memory and document that is theirs, in every store the storage holds
//   await eraseSubject(storage, userId);
//
// That call is only possible because the runs were born with an owner. It is the concrete reason this
// file is worth writing on day one rather than on the day somebody asks to be forgotten.
`;
