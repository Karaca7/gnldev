/** The run identity TYPES — a leaf module (no imports), so the journal can name them without a cycle. */
export type UserPrincipal = { kind: 'user'; resourceId: string; orgId?: string };
export type StaffPrincipal = { kind: 'staff' };
export type UnknownPrincipal = { kind: 'unknown' };
export type Principal = UserPrincipal | StaffPrincipal | UnknownPrincipal;

/** The identity of one run: its principal, plus where it sits. */
export type RunIdentity = Principal & {
  runId: string;
  threadId?: string;
  /** The run whose model (or step) started this one, when it is a child run. */
  parentRunId?: string;
};

/** What the engine hands a tool's `execute` as `options.gnl`. Read it with `gnlOf(options)`. */
export interface GnlToolContext {
  identity: RunIdentity;
  /** The run whose model called this tool (= `identity.runId`). */
  runId: string;
  parentRunId?: string;
}

