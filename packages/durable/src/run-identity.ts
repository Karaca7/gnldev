/**
 * WHOSE IS THIS — one module, one value.
 *
 * Every run carries ONE `RunIdentity`, decided once at the run's start and passed explicitly (never
 * through ambient state) to everything that acts on the run's behalf: `DurableCtx.identity`, the
 * workflow `StepCtx.identity`, and the `gnl` field of a tool's execution options. A child run
 * (agent-as-tool, network sub-agent, a run started inside a workflow step, a batch item) takes its
 * principal from its parent's value, so the owner that is recorded and the identity a tool sees are
 * the same object.
 *
 * Three principals, not two. `user` is an end user; `staff` is an EXPLICIT operator/system decision;
 * `unknown` means the identity was lost on the way (a tool called by hand without its options, a run
 * started with no principal). `unknown` is closed wherever an end user's data would be served.
 */
import { claim, runKeys, type Journal } from './journal.js';

import type { Principal, RunIdentity, GnlToolContext } from './identity-types.js';
export type { UserPrincipal, StaffPrincipal, UnknownPrincipal, Principal, RunIdentity, GnlToolContext } from './identity-types.js';
import type { StaffPrincipal, UnknownPrincipal, UserPrincipal } from './identity-types.js';

export const STAFF: StaffPrincipal = Object.freeze({ kind: 'staff' }) as StaffPrincipal;
export const UNKNOWN: UnknownPrincipal = Object.freeze({ kind: 'unknown' }) as UnknownPrincipal;

/** A user principal, validated. */
export function user(resourceId: string, orgId?: string): UserPrincipal {
  if (typeof resourceId !== 'string' || resourceId === '') {
    throw new TypeError(`@gnldev/durable: a user principal needs a non-empty resourceId — got ${JSON.stringify(resourceId)}`);
  }
  return { kind: 'user', resourceId, ...(orgId !== undefined ? { orgId } : {}) };
}

/** The legacy spelling (`resourceId?: string`) turned into a principal. Absent is `unknown`, never staff. */
export function principalFrom(resourceId: string | undefined, orgId?: string): Principal {
  return resourceId !== undefined && resourceId !== '' ? user(resourceId, orgId) : UNKNOWN;
}

/** Strip the placement fields: the principal half of an identity. */
export function principalOf(p: Principal): Principal {
  if (p.kind === 'user') return { kind: 'user', resourceId: p.resourceId, ...(p.orgId !== undefined ? { orgId: p.orgId } : {}) };
  return p.kind === 'staff' ? STAFF : UNKNOWN;
}

export function runIdentity(p: Principal, runId: string, place: { threadId?: string; parentRunId?: string } = {}): RunIdentity {
  return { ...principalOf(p), runId, ...(place.threadId ? { threadId: place.threadId } : {}), ...(place.parentRunId ? { parentRunId: place.parentRunId } : {}) };
}

/** The end user a principal stands for, or undefined for staff/unknown. */
export function userIdOf(p: Principal | undefined): string | undefined {
  return p?.kind === 'user' ? p.resourceId : undefined;
}

/** A child's identity: the parent's principal, the child's placement. */
export function childIdentity(parent: RunIdentity, childRunId: string, threadId?: string): RunIdentity {
  return runIdentity(parent, childRunId, { ...(threadId ?? parent.threadId ? { threadId: threadId ?? parent.threadId } : {}), parentRunId: parent.runId });
}

/** The tool-execution context the engine passes for a run. */
export function toolContextFor(identity: RunIdentity): GnlToolContext {
  return { identity, runId: identity.runId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) };
}

/**
 * The identity a tool runs under. A tool called without the engine's options (by hand, from another
 * tool that forgot to forward them) is `unknown` — closed, not open.
 */
export function gnlOf(options: unknown): RunIdentity {
  const g = (options as { gnl?: GnlToolContext } | undefined)?.gnl;
  if (g && typeof g === 'object' && g.identity && typeof g.identity === 'object' && typeof g.identity.kind === 'string') return g.identity;
  return { kind: 'unknown', runId: '' };
}

// ─── Ownership: "does this run exist, and whose is it" ─────────────────────────────────────────

/** The owner record's shape (the `<runId>:input` entry). */
export type OwnerRecord = { resourceId?: string; principal?: 'staff' | 'unknown' } & Record<string, unknown>;

export type RunOwner =
  | { exists: false }
  | { exists: true; principal: Principal; kind: 'agent' | 'workflow' | 'network' | 'batch' | 'other' };

/**
 * A raw (unscoped) journal. The subject view carries the `SUBJECT_VIEW` brand, so a value typed as a
 * view cannot be passed where a decision reads the truth.
 */
export const SUBJECT_VIEW = '__gnlSubjectView' as const;
/** The brand a subject view carries (a string key, so packages without a durable dependency can refuse it too). */
export type SubjectViewBrand = { readonly __gnlSubjectView: true };
export type RawJournal = Journal & { readonly __gnlSubjectView?: never };

export function assertRaw(journal: object, fn: string): void {
  if ((journal as { __gnlSubjectView?: unknown }).__gnlSubjectView === true) {
    throw new TypeError(`@gnldev/durable: ${fn} was handed an end user's VIEW — decisions read the raw journal`);
  }
}

function principalFromRecord(rec: OwnerRecord): Principal {
  if (typeof rec.resourceId === 'string' && rec.resourceId !== '') return user(rec.resourceId, typeof rec.orgId === 'string' ? rec.orgId : undefined);
  return rec.principal === 'unknown' ? UNKNOWN : STAFF;
}

function kindOf(rec: OwnerRecord): 'agent' | 'workflow' | 'network' | 'batch' | 'other' {
  if (typeof rec.workflow === 'string') return 'workflow';
  if (typeof rec.network === 'string') return 'network';
  if (typeof rec.batch === 'string') return 'batch';
  if (rec.prompt !== undefined || rec.messages !== undefined) return 'agent';
  return 'other';
}

/** The ONE reading of a run's owner, for every run kind. Read errors propagate. */
export async function runOwnerOf(journal: RawJournal, runId: string): Promise<RunOwner> {
  assertRaw(journal, 'runOwnerOf');
  const rec = await journal.get<OwnerRecord>(runKeys.input(runId));
  if (rec !== undefined && rec !== null && typeof rec === 'object') return { exists: true, principal: principalFromRecord(rec), kind: kindOf(rec) };
  // No owner record. A run that has rows but no record (a legacy run, or a record deleted by hand)
  // EXISTS — it is nobody's, i.e. staff's. Also: a run id that is a ':'-prefix of someone's run
  // (`team` over `team:1`) is occupied: letting it be born would make the two run's keys ambiguous.
  const list = (journal as { listKeys?: (p: string) => Promise<string[]> }).listKeys;
  if (list) {
    const keys = await list.call(journal, `${runId}:`);
    if (keys.length > 0) {
      const nested = keys.map((k) => k.slice(runId.length + 1)).filter((rest) => rest.endsWith(':input')).map((rest) => `${runId}:${rest.slice(0, -':input'.length)}`);
      if (nested.length > 0) {
        // The prefix is occupied by other runs: it is theirs if every one of them is one owner's.
        const owners = await Promise.all(nested.map(async (id) => principalFromRecord(((await journal.get<OwnerRecord>(runKeys.input(id))) ?? {}) as OwnerRecord)));
        const u = new Set(owners.map((p) => (p.kind === 'user' ? `u:${p.resourceId}` : p.kind)));
        return { exists: true, principal: u.size === 1 ? owners[0]! : STAFF, kind: 'other' };
      }
      return { exists: true, principal: STAFF, kind: 'other' };
    }
  }
  return { exists: false };
}

export async function runExists(journal: RawJournal, runId: string): Promise<boolean> {
  return (await runOwnerOf(journal, runId)).exists;
}

export type AccessDecision = 'allow' | 'deny' | 'missing';

/**
 * The one access rule: staff reach everything; an end user reaches a run whose owner IS them; a
 * run that does not exist is `missing` (the caller decides whether that means "you may create it").
 * `unknown` reaches nothing that exists.
 */
export function decideRunAccess(owner: RunOwner, caller: Principal): AccessDecision {
  if (!owner.exists) return 'missing';
  if (caller.kind === 'staff') return 'allow';
  if (caller.kind === 'unknown') return 'deny';
  return owner.principal.kind === 'user' && owner.principal.resourceId === caller.resourceId ? 'allow' : 'deny';
}

export async function decideRun(journal: RawJournal, runId: string, caller: Principal): Promise<AccessDecision> {
  return decideRunAccess(await runOwnerOf(journal, runId), caller);
}

/** The owner fields every run kind writes into its `:input` record. */
export function ownerFields(p: Principal): { resourceId?: string; orgId?: string; principal?: 'staff' | 'unknown' } {
  if (p.kind === 'user') return { resourceId: p.resourceId, ...(p.orgId !== undefined ? { orgId: p.orgId } : {}) };
  return { principal: p.kind };
}

/**
 * THE common start point for non-agent run kinds (workflow, network, batch item): writes the owner
 * record UNCONDITIONALLY — ownerless too — first write wins. Agent runs write the same fields through
 * their frozen input (run.ts persistInput), which is the same key and the same fields.
 */
export async function claimRunOwner(journal: RawJournal, runId: string, p: Principal, extra: Record<string, unknown>): Promise<Principal> {
  assertRaw(journal, 'claimRunOwner');
  await claim(journal, runKeys.input(runId), { _v: 2, at: Date.now(), ...extra, ...ownerFields(p) });
  const rec = await journal.get<OwnerRecord>(runKeys.input(runId));
  return rec ? principalFromRecord(rec) : p;
}

/**
 * The principal a re-entry of an existing run runs as. The run's recorded owner wins; a caller that
 * names a DIFFERENT user is refused (never run as the caller).
 */
export function effectivePrincipal(recorded: Principal | undefined, caller: Principal): { ok: true; principal: Principal } | { ok: false; owner: Principal } {
  if (recorded === undefined) return { ok: true, principal: caller };
  if (caller.kind === 'user') {
    if (recorded.kind === 'user' && recorded.resourceId === caller.resourceId) return { ok: true, principal: recorded };
    return { ok: false, owner: recorded };
  }
  return { ok: true, principal: recorded };
}

export function recordedPrincipal(rec: unknown): Principal | undefined {
  return rec !== undefined && rec !== null && typeof rec === 'object' ? principalFromRecord(rec as OwnerRecord) : undefined;
}
