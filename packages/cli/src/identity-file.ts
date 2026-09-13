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
export const IDENTITY_FILE = `// WHO IS EACH RUN FOR?
//
// One function, called by whichever surface is in front of the engine, answering one question: which
// of your users is this request acting for. Its answer becomes the run's \`resourceId\` — the key
// conversation memory scopes on, the value every ownership gate compares against, and the id
// \`purgeResource\` erases by.
//
// THE ONE WRONG ANSWER, said out loud because it is the one people reach for first:
//
//     // NEVER:
//     const resourceId = (await req.json()).resourceId;
//
// A subject read out of the request body is the caller naming whoever they like. That is not a
// smaller version of authentication, it is the absence of it — and it is precisely the hole the
// engine's context seal exists to close. Read it from something the SERVER established: a session
// cookie you verified, a JWT you checked the signature of, \`principalOf(req)?.id\` when @gnldev/auth is
// in front.
//
// (The REST host is the documented exception, and only for an APPLICATION credential: a bearer token
// carries no per-caller identity, so a customer's backend naming its own end user in the body IS the
// channel. See docs/errors/run_actor_mismatch.md.)

/** Your own session lookup. Replace this — it is the only part of this file that is a placeholder. */
async function sessionOf(_req: Request): Promise<{ userId: string; conversationId?: string } | undefined> {
  // e.g. const sid = parseCookie(req.headers.get('cookie'))?.sid;
  //      return sid ? await sessions.get(sid) : undefined;
  return undefined;
}

/**
 * Hand this to @gnldev/chat-adapter's \`createChatRoute\` or @gnldev/agui's route — both take the same
 * hook, and neither has any auth of its own, which is exactly why naming the subject is yours to do.
 *
 * Returning \`undefined\` is honest and safe: the run is born with no owner rather than a forged one,
 * and the ownership gates stay fail-open for it. It is not a way to skip the question — a run with no
 * owner is a run nobody can be told apart from anybody else.
 */
export async function identity(req: Request): Promise<{ resourceId: string; threadId?: string } | undefined> {
  const session = await sessionOf(req);
  if (!session) return undefined;
  return {
    resourceId: session.userId,
    ...(session.conversationId ? { threadId: session.conversationId } : {}),
  };
}

// WIRING IT UP — in src/app.ts, next to the REST surface:
//
//   import { createChatRoute } from '@gnldev/chat-adapter';
//   import { identity } from './identity.js';
//
//   export const chat = createChatRoute(config, { identity });
//
// On the REST host (@gnldev/server) there is nothing to wire: with \`auth\` configured, the
// authenticated principal IS the subject, and a body field cannot override it.
//
// ERASING ONE PERSON — the request you answer in days, not by waiting for a sweep. Retention
// (\`gnl sweep --older-than 30d\`) deletes by AGE and knows nothing about people:
//
//   import { purgeResource } from '@gnldev/durable';
//   await purgeResource(storage, userId);   // every run, thread and message that names them
//
// That call is only possible because the runs were born with an owner. It is the concrete reason this
// file is worth writing on day one rather than on the day somebody asks to be forgotten.
`;
