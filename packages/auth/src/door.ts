// The one reading every standalone door makes of a request: who is calling, as the engine's caller.
//
// A door (the chat and AG-UI routes, an MCP server) has a web Request and the application's `identify`.
// It asks `identify` once and maps the answer with `engineCallerOf` — the one mapping (ADR-0002) — so
// the same principal is the same caller whichever door the request came in through.
import type { Principal } from './types.js';
import { callerKind, engineCallerOf, type EngineCaller, type Identify } from './scope.js';

/**
 * Why a door refuses an application that names no user. The sentence @gnldev/server answers an
 * application credential that sends no `resourceId`, so the doors have one vocabulary for it.
 */
export const APPLICATION_NAMES_NO_USER = 'resourceId is required: this request used an application credential and named no end user.';

export type RequestCaller =
  /** `principal` is what `identify` returned (undefined for an anonymous request); `caller` is the engine's. */
  | { principal: Principal | undefined; caller: EngineCaller }
  /** An application that named no user, or a name no user can carry. Nothing runs. */
  | { refused: string };

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
  if (callerKind(principal) === 'application') {
    const caller = engineCallerOf(principal, typeof named === 'string' ? named : undefined);
    return caller.kind === 'user' ? { principal, caller } : { refused: APPLICATION_NAMES_NO_USER };
  }
  return { principal, caller: engineCallerOf(principal) };
}
