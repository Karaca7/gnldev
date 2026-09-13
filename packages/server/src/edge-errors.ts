// The error codes the HTTP EDGE puts on the wire, in one enumerable place.
//
// WHY THIS FILE EXISTS. `@gnldev/durable` already owns two maps — `CALLER_CONFLICT_CODES` and
// `BLOCKED_ERROR_CODES` — and because they are exported values, `scripts/check-error-pages.mjs`
// enumerates them and nobody has to remember anything: a new engine code with no page under
// `docs/errors/` turns the build red in the same commit that invents it. The codes written HERE had
// no such map. They were string literals spelled at the point of response, and the docs check knew
// about them only through a hand-written list inside the script itself, which said so out loud:
// "a fourth literal added at an edge tomorrow is caught by nothing".
//
// Measured before this file existed: the list named three codes, and the edge was printing NINE. The
// six it did not know about — both A2A signature refusals, the timestamp one, `resource_denied`,
// `budget_exceeded` and `body_consumed_upstream` — had shipped with no page at all. The weak spot was
// not hypothetical and did not take until tomorrow.
//
// WHY IN @gnldev/server RATHER THAN @gnldev/durable. These are route-level facts: an HTTP status is
// attached to each one, and the engine has no routes and no statuses — putting them next to
// `RunBusyError` would say the engine produces them, and it does not. Server is also the lowest
// package that every printer shares: `@gnldev/agui` depends on `@gnldev/server` already (it imports
// `interruptsFromSteps`), so both edges can read the same constant.
//
// Deliberately its own module rather than a block inside `index.ts`: the docs check imports the
// BUILT value, and importing `dist/index.js` would drag Hono and the whole route table into a
// documentation script. This file imports nothing.
//
// ONE PRINTER IS NOT WIRED TO IT, on purpose: `@gnldev/studio`'s `node.ts` carries its own copy of
// the `body_consumed_upstream` guard and does NOT depend on `@gnldev/server`, so it keeps the
// literal. The code is the same string and now has a page; adding a package dependency for one
// constant would be the more expensive of the two mistakes.

/**
 * Code by the name of the refusal that prints it. The keys are for readers and for the failure
 * message in the docs check; the VALUES are the contract — the same string in the HTTP body, in the
 * SSE `error` frame, and in whatever the client library re-throws.
 */
export const EDGE_ERROR_CODES = {
  /** 422, `resumable` — `limits` ceiling met (`server/index.ts`, `sse.ts`, `agui/route.ts`). */
  runLimitExceeded: 'run_limit_exceeded',
  /** 422, `resumable` — one tool, the same arguments, no progress (same three sites). */
  toolLoopDetected: 'tool_loop_detected',
  /** 403 — the agent is pending, changed since approval, or blocked (`requireAgentApproval`). */
  agentNotApproved: 'agent_not_approved',
  /** 403 — `opts.resourceAuth` refused this principal for this agent (the paid FGA layer). */
  resourceDenied: 'resource_denied',
  /** 402 — the organization's budget is spent; a NEW run is refused, a resume is not. */
  budgetExceeded: 'budget_exceeded',
  /** 401 — an A2A call arrived without the `x-gnl-signature`/`x-gnl-timestamp` pair. */
  a2aSignatureMissing: 'a2a_signature_missing',
  /** 401 — the A2A timestamp is outside the ±300s window (replay suspicion). */
  a2aTimestampInvalid: 'a2a_timestamp_invalid',
  /** 401 — the A2A HMAC did not verify. */
  a2aSignatureInvalid: 'a2a_signature_invalid',
  /** 500 — a body parser upstream of the handler already drained the request (`node.ts`). */
  bodyConsumedUpstream: 'body_consumed_upstream',
} as const;

export type EdgeErrorCode = (typeof EDGE_ERROR_CODES)[keyof typeof EDGE_ERROR_CODES];

/**
 * HTTP status per edge code — the docs-checker's source of truth for this family, same contract as
 * `WIRE_ERROR_STATUS` in @gnldev/durable: routes are pinned to these numbers by their tests, docs
 * are pinned to them by `check:errors`, and a new code without an entry fails the gate.
 */
export const EDGE_ERROR_STATUS: Record<string, number> = {
  run_limit_exceeded: 422,
  tool_loop_detected: 422,
  agent_not_approved: 403,
  resource_denied: 403,
  budget_exceeded: 402,
  a2a_signature_missing: 401,
  a2a_timestamp_invalid: 401,
  a2a_signature_invalid: 401,
  body_consumed_upstream: 500,
};
