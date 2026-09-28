/**
 * The identity TYPES — a leaf module (no imports), so the journal can name them without a cycle.
 *
 * `Caller` is the engine's own, small answer to "who is calling". A door (server, chat-adapter, agui,
 * mcp, studio, a worker) reads its request however it authenticates it and hands the engine one of
 * these three; the engine never sees a token or an auth principal. Three kinds, not two: `staff` is
 * an EXPLICIT operator/system decision, `unknown` is an identity that was lost or never given — and
 * `unknown` is closed wherever an end user's data would be served.
 */
export type UserCaller = { kind: 'user'; id: string; orgId?: string };
export type StaffCaller = { kind: 'staff'; orgId?: string };
export type UnknownCaller = { kind: 'unknown' };
export type Caller = UserCaller | StaffCaller | UnknownCaller;

/** The identity of one run: its caller, plus where it sits. */
export type RunIdentity = Caller & {
  runId: string;
  threadId?: string;
  /** The run whose model (or step) started this one, when it is a child run. */
  parentRunId?: string;
};

/** What the engine hands a tool's `execute` as `options.gnl`. Read it with `identityOf(options)`. */
export interface GnlToolContext {
  identity: RunIdentity;
  /** The run whose model called this tool (= `identity.runId`). */
  runId: string;
  parentRunId?: string;
}
