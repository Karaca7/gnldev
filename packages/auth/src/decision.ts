// The outcome of a request, as the caller got it — the one rule every host uses to report it.
//
// `authorize` answers before the host's own gates: ownership, organization, resource. Recording its
// verdict recorded the wrong thing — measured, `GET /runs/<someone else's run>` answered 404 while the
// record said `allowed=true`. So a host notes what happened to a request as it happens (the provider's
// verdict, the principal, the first refusal) and reports ONE outcome when it has answered.
import type { AccessDecision, AuthContext, Decision, Principal, RefusalReason } from './types.js';
import { callerKind } from './scope.js';

// Per-request notes, keyed by the request (see gate.ts for why a WeakMap and not a field on it).
const principals = new WeakMap<Request, Principal | null>();
const verdicts = new WeakMap<Request, { ctx: AuthContext; verdict: Decision }>();
const refusals = new WeakMap<Request, { reason: RefusalReason; detail?: string }>();
const settled = new WeakSet<Request>();
const rejectedCredentials = new WeakSet<Request>();

/** The `detail` of a request that presented a credential the provider did not accept. */
export const CREDENTIAL_REJECTED = 'credential_rejected';

/**
 * Note that this request CARRIED a credential and the provider accepted none of it — revoked, expired,
 * deleted, forged or never issued. A provider's `authenticate` calls it before answering null.
 *
 * Why it exists: `null` from `authenticate` meant two different things, "nobody said who they are" and
 * "somebody said who they are and it was false". A door that serves anonymous callers (the standalone
 * chat and AG-UI routes) could not tell them apart, so a revoked user's token was served as an anonymous
 * request — 200, recorded as `kind: "unnamed", allowed: true` — and the record hid that a dead
 * credential had been presented. The doors now refuse such a request with 401 (`callerOfRequest`), and
 * the row says why. A host's own `identify` can call this too; `identify: () => undefined` never does.
 */
export function markCredentialRejected(req: Request): void {
  rejectedCredentials.add(req);
}

/** Whether a provider noted that this request's credential was rejected (`markCredentialRejected`). */
export function credentialRejected(req: Request): boolean {
  return rejectedCredentials.has(req);
}

/** Who made this request. Internal: the gate and `callerOfRequest` note it; nothing else should. */
export function notePrincipal(req: Request, principal: Principal | null | undefined): void {
  if (!principals.has(req) || principals.get(req) == null) principals.set(req, principal ?? null);
}

/**
 * The provider's verdict. A denial is kept over a later allow: the host answers the first denial, so a
 * second permission check that passed must not overwrite it.
 */
export function noteVerdict(req: Request, ctx: AuthContext, verdict: Decision): void {
  const prev = verdicts.get(req);
  if (prev && !prev.verdict.allow) return;
  verdicts.set(req, { ctx, verdict });
}

/**
 * Record that THIS request is being refused, and why. Call it where the refusal is decided — the
 * response it goes with may be a 404 that hides the reason from the caller; the record must not hide it.
 * The first refusal wins: it is the one the caller got.
 */
export function markRefusal(req: Request, reason: RefusalReason, opts: { detail?: string; principal?: Principal | null } = {}): void {
  if (opts.principal !== undefined) notePrincipal(req, opts.principal);
  if (!refusals.has(req)) refusals.set(req, { reason, ...(opts.detail !== undefined ? { detail: opts.detail } : {}) });
}

/**
 * The outcome of `req`, answered with `status` — or undefined when nothing about it was decided (no
 * verdict asked, no principal noted, no refusal): a route with no gate, such as `/health`.
 *
 *   a recorded refusal         → refused, for that reason
 *   the provider said no       → refused: `unauthenticated` (401, or no principal) or `rbac`
 *   401 / 403 with no reason   → refused: `unauthenticated` / `policy` (never reported as allowed)
 *   anything else              → allowed; `status` says what came of it (a 404 here is a real miss)
 */
export function outcomeOf(req: Request, status: number): AccessDecision | undefined {
  const refusal = refusals.get(req);
  const asked = verdicts.get(req);
  if (!refusal && !asked && !principals.has(req)) return undefined;
  const principal = principals.get(req) ?? null;
  let allowed = true;
  let reason: RefusalReason | undefined;
  let detail: string | undefined;
  if (refusal) {
    allowed = false;
    reason = refusal.reason;
    detail = refusal.detail;
  } else if (asked && !asked.verdict.allow) {
    allowed = false;
    reason = asked.verdict.status === 401 || !principal ? 'unauthenticated' : 'rbac';
    detail = asked.verdict.reason;
  } else if (status === 401) {
    allowed = false;
    reason = 'unauthenticated';
  } else if (status === 403) {
    allowed = false;
    reason = 'policy';
  }
  // A rejected credential is named on the row, whatever came of the request: refused as 401 (the doors,
  // and every gated route), or served on a route that needs no identity. Never over a refusal's own detail.
  if (principal === null && rejectedCredentials.has(req) && (refusal?.detail === undefined)) detail = CREDENTIAL_REJECTED;
  const method = req.method.toUpperCase();
  return {
    principal,
    kind: callerKind(principal),
    ...(principal?.orgId !== undefined ? { orgId: principal.orgId } : {}),
    path: new URL(req.url).pathname,
    method,
    action: asked?.ctx.action ?? (method === 'GET' || method === 'HEAD' ? 'read' : 'write'),
    ...(asked?.ctx.permission !== undefined ? { permission: asked.ctx.permission } : {}),
    ...(asked?.ctx.resource !== undefined ? { resource: asked.ctx.resource } : {}),
    allowed,
    ...(reason !== undefined ? { reason } : {}),
    ...(detail !== undefined ? { detail } : {}),
    status,
  };
}

/**
 * Report `req`'s outcome to `onDecision`, once. A host calls this when it has its response. Throws what
 * `onDecision` throws: the host decides what a failed record means (the shipped hosts answer 500).
 */
export async function settleDecision(
  onDecision: ((d: AccessDecision) => void | Promise<void>) | undefined,
  req: Request,
  status: number,
): Promise<void> {
  if (!onDecision || settled.has(req)) return;
  const decision = outcomeOf(req, status);
  if (!decision) return;
  settled.add(req);
  await onDecision(decision);
}

/** The codes this package puts on the wire, enumerable so every one has a page in docs/errors. */
export const AUTH_ERROR_CODES = {
  /** 500 — the host's `onDecision` hook failed, so the response was withheld rather than sent unrecorded. */
  decisionNotRecorded: 'decision_not_recorded',
} as const;
export const AUTH_ERROR_STATUS: Record<string, number> = { [AUTH_ERROR_CODES.decisionNotRecorded]: 500 };

/**
 * The answer a host gives when `onDecision` failed: the request is not delivered unrecorded. `extra`
 * says what the host did about a change the request had already made (Studio's `POST /users` adds
 * `rolledBack`); it never carries the withheld response.
 */
export function decisionNotRecorded(err: unknown, extra: Record<string, unknown> = {}): Response {
  console.error('@gnldev/auth: onDecision failed — the response was withheld:', err);
  return Response.json({ ...extra, error: 'the decision for this request could not be recorded', code: AUTH_ERROR_CODES.decisionNotRecorded }, { status: 500 });
}
