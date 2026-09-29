// The one reading every standalone door makes of a request: who is calling, as the engine's caller.
//
// A door (the chat and AG-UI routes, an MCP server) has a web Request and the application's `identify`.
// It asks `identify` once and maps the answer with `engineCallerOf` — the one mapping (ADR-0002) — so
// the same principal is the same caller whichever door the request came in through.
import type { Principal } from './types.js';
import { callerKind, engineCallerOf, type EngineCaller, type Identify } from './scope.js';
import { markRefusal, notePrincipal, credentialRejected, CREDENTIAL_REJECTED } from './decision.js';

/**
 * Why a door refuses an application that names no user. The sentence @gnldev/server answers an
 * application credential that sends no `resourceId`, so the doors have one vocabulary for it.
 */
export const APPLICATION_NAMES_NO_USER = 'resourceId is required: this request used an application credential and named no end user.';

/**
 * Why a door refuses a request whose credential the provider rejected (`markCredentialRejected`).
 * Sent with 401: the caller said who they are and it was not true, so serving them as anonymous would
 * quietly turn them into somebody else.
 */
export const CREDENTIAL_NOT_ACCEPTED = 'the credential this request carried was not accepted (revoked, expired, deleted or never issued). Send a valid one — or none, to call as an anonymous caller.';

export type RequestCaller =
  /** `principal` is what `identify` returned (undefined for an anonymous request); `caller` is the engine's. */
  | { principal: Principal | undefined; caller: EngineCaller }
  /**
   * Nothing runs. `status` 401: the request carried a credential the provider rejected. Absent (400):
   * an application that named no user, or a name no user can carry.
   */
  | { refused: string; status?: 401 };

/**
 * Who a request is, for the engine.
 *
 *   subject      → that user; a name in the request is ignored — a user speaks only for itself
 *   operator     → staff; a name in the request is ignored too — staff is staff, not a user
 *   application  → the user it names in `named`; REFUSED when it names nobody (never staff, never unknown)
 *   nothing      → unknown, which the engine keeps closed
 *
 * `named` is read for an application ONLY. It comes from the request, because an application is the one
 * caller trusted to say which of its users it acts for on each request — the same rule, and the same
 * field (`resourceId`), as @gnldev/server's REST routes. The organization always comes from the
 * principal, never from the request.
 *
 * `identify` absent means the door was built without one: every request is unknown.
 */
export async function callerOfRequest(identify: Identify | undefined, req: Request, named?: unknown): Promise<RequestCaller> {
  const principal = (await identify?.(req)) ?? undefined;
  // Noted for the door's `onDecision` (settleDecision): the record names who asked, whatever came of it.
  notePrincipal(req, principal);
  // A credential was presented and rejected: refused, not served as anonymous. Only a provider that
  // noted it says so — `identify: () => undefined` reads no credential and keeps every caller anonymous.
  if (!principal && credentialRejected(req)) {
    markRefusal(req, 'unauthenticated', { detail: CREDENTIAL_REJECTED });
    return { refused: CREDENTIAL_NOT_ACCEPTED, status: 401 };
  }
  if (callerKind(principal) === 'application') {
    const caller = engineCallerOf(principal, typeof named === 'string' ? named : undefined);
    if (caller.kind === 'user') return { principal, caller };
    markRefusal(req, 'unauthenticated', { detail: APPLICATION_NAMES_NO_USER });
    return { refused: APPLICATION_NAMES_NO_USER };
  }
  return { principal, caller: engineCallerOf(principal) };
}
