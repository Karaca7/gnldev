/**
 * WHOSE IS THIS — one module, one value.
 *
 * Two questions live here, each answered once:
 *
 *  1. Who is a run acting for? Every run carries ONE `RunIdentity`, decided at the run's start from
 *     the `Caller` a door (or a direct engine call) hands over and the owner already recorded for the
 *     run. It is passed explicitly — never through ambient state — to everything that acts on the
 *     run's behalf: `DurableCtx.identity`, the workflow `StepCtx.identity`, and `options.gnl` of a
 *     tool's `execute`. A child run (agent-as-tool, network sub-agent, a run started inside a
 *     workflow step, a batch item) takes its caller from its parent's value, so the owner that is
 *     recorded and the identity a tool sees are the same value.
 *
 *  2. Does this run exist, and whose is it? `runOwnerOf` is the ONE reading, for every run kind and
 *     every door; `decideRunAccess` is the ONE rule on top of it. Every run birth writes its owner
 *     through `claimRunOwner` — ownerless too — so "no record" never means "not started" for a run
 *     that has started.
 *
 * Three callers, not two: `user` is an end user; `staff` is an EXPLICIT operator/system decision;
 * `unknown` means the identity was lost on the way (a tool called by hand without its options, a run
 * started with no caller). `unknown` is closed wherever an end user's data would be served.
 *
 * No HTTP here: the engine answers `allow | deny | missing`, and each door maps that to its own wire.
 */
import { claim, runKeys, isVersionedRecord, type Journal } from './journal.js';
import { stampFormat } from './format.js';
import { RunOwnerMismatchError } from './errors.js';

import type { Caller, RunIdentity, GnlToolContext, StaffCaller, UnknownCaller, UserCaller } from './identity-types.js';
export type { UserCaller, StaffCaller, UnknownCaller, Caller, RunIdentity, GnlToolContext } from './identity-types.js';

export const STAFF: StaffCaller = Object.freeze({ kind: 'staff' }) as StaffCaller;
export const UNKNOWN: UnknownCaller = Object.freeze({ kind: 'unknown' }) as UnknownCaller;

/** An end user, validated: a user with no id is a bug, not an anonymous caller. */
export function user(id: string, orgId?: string): UserCaller {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`@gnldev/durable: a user caller needs a non-empty id — got ${JSON.stringify(id)}`);
  }
  return { kind: 'user', id, ...(orgId !== undefined ? { orgId } : {}) };
}

/** Staff (an operator, or the system itself), said out loud. `orgId` is where it acts, not who it is. */
export function staff(orgId?: string): StaffCaller {
  return orgId === undefined ? STAFF : { kind: 'staff', orgId };
}

/** The `resourceId?: string` shorthand read as a caller. Absent is `unknown` — never staff by omission. */
export function callerFromResourceId(resourceId: string | undefined, orgId?: string): Caller {
  return resourceId !== undefined && resourceId !== '' ? user(resourceId, orgId) : UNKNOWN;
}

/** The caller half of an identity (drops the run placement fields). */
export function callerOf(c: Caller): Caller {
  if (c.kind === 'user') return user(c.id, c.orgId);
  if (c.kind === 'staff') return staff(c.orgId);
  return UNKNOWN;
}

/** The end user a caller stands for, or undefined for staff/unknown. */
export function userIdOf(c: Caller | undefined): string | undefined {
  return c?.kind === 'user' ? c.id : undefined;
}

/** The fields a server seals onto a request context (`sealRequestContext`) for this caller. */
export interface SealFields { resourceId?: string; orgId?: string; staff?: true }

/**
 * THE caller → seal mapping, for every door: a user seals its id, staff seals the staff flag, `unknown`
 * seals neither (it stays closed), and the organization is the one the door established. The REST,
 * chat, AG-UI and MCP doors each wrote this out by hand.
 */
export function sealFieldsOf(caller: Caller, orgId?: string): SealFields {
  return {
    ...(caller.kind === 'user' ? { resourceId: caller.id } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(caller.kind === 'staff' ? { staff: true as const } : {}),
  };
}

/** Whether two callers are the same party: kind, user id, and organization where both name one. */
function sameParty(a: Caller, b: Caller): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'user' && a.id !== (b as UserCaller).id) return false;
  const ao = a.kind === 'unknown' ? undefined : a.orgId;
  const bo = b.kind === 'unknown' ? undefined : b.orgId;
  return ao === undefined || bo === undefined || ao === bo;
}

/**
 * THE caller of a call, decided once, from what the server sealed and what the call declared (`caller`,
 * or the `resourceId` shorthand). The seal is what a server verified, so it decides.
 *
 * An explicit `caller` that names somebody else is REFUSED, not overruled: `caller` is a door's own
 * decision, and the seal used to win silently — a host passing `caller: mallory` with a context sealed
 * for ayse started ayse's run and was never told. The `resourceId` shorthand keeps its documented
 * precedence (P1.7: a sealed identity overrides it): it is the field a request body reaches, and the
 * seal is there to overrule exactly that.
 */
export function resolveCaller(seal: SealFields, declared?: { resourceId?: string; caller?: Caller }): Caller {
  let named: Caller | undefined;
  if (declared?.caller) {
    named = callerOf(declared.caller);
    if (declared.resourceId !== undefined && userIdOf(named) !== declared.resourceId) {
      throw new TypeError('@gnldev/durable: a call was given both `caller` and a different `resourceId` — one caller per call.');
    }
  }
  const sealed = seal.resourceId !== undefined ? user(seal.resourceId, seal.orgId) : seal.staff ? staff(seal.orgId) : undefined;
  if (!sealed) return named ?? callerFromResourceId(declared?.resourceId, seal.orgId);
  if (named && !sameParty(sealed, named)) {
    throw new TypeError(
      `@gnldev/durable: the request context is sealed for ${ownerLabel(sealed)} and the call names ${ownerLabel(named)} — one caller per call. ` +
        'Pass the caller the server established (or drop the declaration and let the seal speak).',
    );
  }
  return sealed;
}

export function runIdentity(c: Caller, runId: string, place: { threadId?: string; parentRunId?: string } = {}): RunIdentity {
  return { ...callerOf(c), runId, ...(place.threadId ? { threadId: place.threadId } : {}), ...(place.parentRunId ? { parentRunId: place.parentRunId } : {}) };
}

/** A child's identity: the parent's caller, the child's placement. */
export function childIdentity(parent: RunIdentity, childRunId: string, threadId?: string): RunIdentity {
  const thread = threadId ?? parent.threadId;
  return runIdentity(parent, childRunId, { ...(thread ? { threadId: thread } : {}), parentRunId: parent.runId });
}

/** The tool-execution context the engine passes for a run (`options.gnl`). */
export function toolContextFor(identity: RunIdentity): GnlToolContext {
  return { identity, runId: identity.runId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) };
}

/**
 * THE way a tool reads who it runs for: `identityOf(options)`. A tool called without the engine's
 * options (by hand, or from another tool that did not forward them) is `unknown` — closed, not open.
 */
export function identityOf(options: unknown): RunIdentity {
  const g = (options as { gnl?: GnlToolContext } | undefined)?.gnl;
  const id = g && typeof g === 'object' ? g.identity : undefined;
  if (id && typeof id === 'object' && (id.kind === 'user' || id.kind === 'staff' || id.kind === 'unknown')) return id;
  return { kind: 'unknown', runId: '' };
}

/**
 * The old channel, closed loudly. Tools used to read the user from `options.resourceId`; that key is
 * gone, and a type error alone did not stop a tool from reading it (measured: `(options as any)
 * .resourceId` compiles and reads `undefined` — i.e. "nobody", which a rag tool served as the whole
 * index). So the engine plants a getter that THROWS. It is not enumerable: spreading or forwarding
 * the options (`{ ...options }`, `JSON.stringify`) does not trip it — only reading it does.
 */
export function closeLegacyResourceId<T extends object>(options: T): T {
  Object.defineProperty(options, 'resourceId', {
    enumerable: false,
    configurable: true,
    get() {
      throw new TypeError(
        '@gnldev/durable: `options.resourceId` was removed from tool options — read who the tool runs for with ' +
          '`identityOf(options)` (a user, staff, or `unknown`, which is closed). See the 0.7.0 CHANGELOG.',
      );
    },
  });
  return options;
}

// ─── Ownership: "does this run exist, and whose is it" ─────────────────────────────────────────

/** The owner fields of a `<runId>:input` record. `ownerKind` marks a run born with no end user. */
export type OwnerRecord = { resourceId?: string; orgId?: string; ownerKind?: 'staff' | 'unknown' } & Record<string, unknown>;

export type RunKind = 'agent' | 'workflow' | 'network' | 'batch' | 'other';

/**
 * The answer to "does this run exist, and whose is it":
 *  - `missing`: no owner record and no rows — the run has not started (a door may start it).
 *  - `owned`: the run exists. `owner` is who it belongs to; `staff` also for a run nobody claimed and
 *    for a run whose record is missing but whose rows are present. `record` is the raw record when
 *    there is one (an agent run's frozen input), `recorded: false` when the owner was inferred.
 *  - `unreadable`: the store failed. Not knowing is not permission: every decision reads it as deny,
 *    and no birth proceeds on it.
 */
export type RunOwner =
  | { state: 'missing' }
  | { state: 'owned'; owner: Caller; kind: RunKind; recorded: boolean; record?: OwnerRecord }
  | { state: 'unreadable'; error: unknown };

/**
 * A raw (unscoped) journal. The subject view carries the `SUBJECT_VIEW` brand, so a decision cannot
 * be computed over an end user's filtered view by mistake.
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

/**
 * Whose a stored `:input` record says the run is — the ONE reading of the owner fields.
 *
 * The `_v` rule (see `runIdOfKey` in journal.ts): only a record the journal itself stamped names an
 * owner. `appendLog(journal, ns, payload, 'input')` writes an unstamped `<ns>:input` through a public
 * API, so an unstamped record's `resourceId` is a caller's bytes, not an owner — it still proves the
 * key is taken, so it reads as staff's (closed), never as the user it names.
 */
export function recordOwner(rec: unknown): Caller | undefined {
  if (rec === undefined || rec === null || typeof rec !== 'object') return undefined;
  const r = rec as OwnerRecord;
  if (!isVersionedRecord(r)) return STAFF;
  if (typeof r.resourceId === 'string' && r.resourceId !== '') return user(r.resourceId, typeof r.orgId === 'string' ? r.orgId : undefined);
  if (r.ownerKind === 'unknown') return UNKNOWN;
  return staff(typeof r.orgId === 'string' ? r.orgId : undefined);
}

function kindOf(rec: OwnerRecord): RunKind {
  if (typeof rec.workflow === 'string') return 'workflow';
  if (typeof rec.network === 'string') return 'network';
  if (typeof rec.batch === 'string') return 'batch';
  if (rec.prompt !== undefined || rec.messages !== undefined) return 'agent';
  return 'other';
}

/** Rows a run writes early, read point by point when the journal cannot list (the bounded fallback). */
const PROBE_KEYS = (runId: string) => [runKeys.model(runId, 0), `${runId}:outcome`, `${runId}:wf:_input`, `${runId}:net:route:0`];

/**
 * Keys the engine writes under a run's id that say nothing about the run having STARTED: the locks
 * taken before a run starts (the run lock, a queue worker's `lease:lock`, the scheduler's
 * `fire:lock`), a parent's taint copied into a child before the child starts
 * (`proc:__gnl_taint`), frozen configuration written before the owner record (`cfg:lessons`
 * is resolved before the run is entered) and the retention tombstone a sweep leaves after deleting a
 * run (a late retry of a swept run is a new run — `tombstonePolicy` decides that, not ownership).
 */
function isBookkeeping(rest: string): boolean {
  return rest === 'lock' || rest.endsWith(':lock') || rest === 'swept' || rest.startsWith('cfg:') || rest.startsWith('proc:__gnl_taint');
}
/** A run has a handful of bookkeeping keys at most; a probe this wide always sees past them. */
const PROBE_LIMIT = 16;

/**
 * Whether anything is stored under the run's id although its owner record is not: a run whose record
 * was lost (a crash between a fork's row copy and its record, a record deleted by hand, data from
 * before records existed), or a `:`-prefix of another run's id (`team` over `team:1`), which must
 * not be born: its keys would be ambiguous with the longer run's.
 *
 * BOUNDED: one `listKeys(prefix, { limit: PROBE_LIMIT })` — the store stops early — plus the workflow
 * registry row, which lives outside the prefix. A journal without `listKeys` gets a fixed set of point
 * reads instead. Never a full scan of the prefix: this runs on every new run.
 */
async function rowsPresent(journal: Journal, runId: string): Promise<boolean> {
  if ((await journal.get(`wfrun:${runId}`)) !== undefined) return true;
  if (typeof journal.listKeys === 'function') {
    const prefix = `${runId}:`;
    return (await journal.listKeys(prefix, { limit: PROBE_LIMIT })).some((k) => !isBookkeeping(k.slice(prefix.length)));
  }
  for (const k of PROBE_KEYS(runId)) if ((await journal.get(k)) !== undefined) return true;
  return false;
}

/** The ONE reading of "does this run exist, and whose is it", for every run kind and every door. */
export async function runOwnerOf(journal: RawJournal, runId: string): Promise<RunOwner> {
  assertRaw(journal, 'runOwnerOf');
  try {
    const rec = await journal.get<OwnerRecord>(runKeys.input(runId));
    const owner = recordOwner(rec);
    if (owner) return { state: 'owned', owner, kind: kindOf(rec!), recorded: isVersionedRecord(rec), record: rec };
    if (await rowsPresent(journal, runId)) return { state: 'owned', owner: STAFF, kind: 'other', recorded: false };
    return { state: 'missing' };
  } catch (error) {
    return { state: 'unreadable', error };
  }
}

export type RunDecision = 'allow' | 'deny' | 'missing';

/**
 * The ONE access rule over `runOwnerOf`'s answer:
 *  - unreadable → deny (not knowing is not permission);
 *  - missing → missing (the door decides whether that means "not found" or "you may start it");
 *  - staff reaches every run that exists;
 *  - an end user reaches a run whose owner IS that user — never an ownerless (staff) run;
 *  - `unknown` reaches only a run that was itself born `unknown` (a direct engine caller that never
 *    named anyone continuing its own work) — never a user's or staff's.
 */
export function decideRunAccess(owner: RunOwner, caller: Caller): RunDecision {
  if (owner.state === 'unreadable') return 'deny';
  if (owner.state === 'missing') return 'missing';
  if (caller.kind === 'staff') return 'allow';
  if (caller.kind === 'unknown') return owner.owner.kind === 'unknown' ? 'allow' : 'deny';
  return owner.owner.kind === 'user' && owner.owner.id === caller.id ? 'allow' : 'deny';
}

export async function decideRun(journal: RawJournal, runId: string, caller: Caller): Promise<RunDecision> {
  return decideRunAccess(await runOwnerOf(journal, runId), caller);
}

/**
 * Who a run acts for once it is admitted: a new run acts for its caller; an existing run ALWAYS acts
 * for its recorded owner (staff resuming a user's run runs it as that user). `undefined` when the
 * decision is not `allow`/`missing` — the caller is refused, never run as itself.
 */
export function actingCaller(owner: RunOwner, caller: Caller): Caller | undefined {
  const d = decideRunAccess(owner, caller);
  if (d === 'missing') return callerOf(caller);
  if (d === 'deny' || owner.state !== 'owned') return undefined;
  return owner.owner;
}

/** The owner fields every run kind writes into its `:input` record. */
export function ownerFields(c: Caller): { resourceId?: string; orgId?: string; ownerKind?: 'staff' | 'unknown' } {
  if (c.kind === 'user') return { resourceId: c.id, ...(c.orgId !== undefined ? { orgId: c.orgId } : {}) };
  if (c.kind === 'staff') return { ownerKind: 'staff', ...(c.orgId !== undefined ? { orgId: c.orgId } : {}) };
  return { ownerKind: 'unknown' };
}

/**
 * THE common start point of every run birth: agent (run.ts bornAs), workflow, network, batch item,
 * MCP call, fork, rollover, replay. Writes the owner record UNCONDITIONALLY — ownerless too — first
 * write wins, and returns the owner that is recorded afterwards (the winner's, on a race).
 *
 * STAMPED (`_v`), which is not cosmetic: the readers that ENUMERATE runs (`runIdOfKey`, hence
 * `listRunsPaged`, `purgeResource`) only count a stamped `:input`, so an unstamped owner record
 * satisfied the gates that read it by key and was invisible to erasure. Not best-effort either: a
 * birth that cannot record its owner does not start.
 */
export async function claimRunOwner(journal: RawJournal, runId: string, caller: Caller, fields: Record<string, unknown> = {}): Promise<Caller> {
  assertRaw(journal, 'claimRunOwner');
  const key = runKeys.input(runId);
  await claim(journal, key, stampFormat({ at: Date.now(), ...fields, ...ownerFields(caller) }));
  return recordOwner(await journal.get<OwnerRecord>(key)) ?? callerOf(caller);
}

/**
 * A run born FROM another (fork, rollover, replay) belongs to the source's owner. Written FIRST — before
 * a single row is copied — so a crash half-way leaves a fork its owner can finish and nobody else can
 * take. A source that does not exist (or cannot be read) gives the new run nothing to inherit: refused.
 */
export async function inheritRunOwner(journal: RawJournal, srcRunId: string, dstRunId: string, fields: Record<string, unknown> = {}): Promise<Caller> {
  const src = await runOwnerOf(journal, srcRunId);
  if (src.state === 'unreadable') throw src.error;
  if (src.state === 'missing') throw new Error(`@gnldev/durable: run '${srcRunId}' does not exist — nothing to derive '${dstRunId}' from.`);
  return claimRunOwner(journal, dstRunId, src.owner, fields);
}

/**
 * The owner of a record that is NOT a run's `:input` (e.g. a cross-run idempotency window's owner
 * record): the same fields, no `_v` rule. A record with no owner fields — or none at all — was made
 * before owners were recorded, and is read as `unknown`'s: reachable by staff and by `unknown` only.
 */
export function fieldsOwner(rec: unknown): Caller {
  const r = (rec && typeof rec === 'object' ? rec : {}) as OwnerRecord;
  if (typeof r.resourceId === 'string' && r.resourceId !== '') return user(r.resourceId);
  return r.ownerKind === 'staff' ? STAFF : UNKNOWN;
}

/** How a refusal names an owner in its `detail` (never in the sentence — see RunOwnerMismatchError). */
export function ownerLabel(c: Caller): string {
  return c.kind === 'user' ? c.id : `(${c.kind})`;
}

/**
 * THE ENTRY of a run, for every kind: read the owner once, decide, and — for a run that does not exist
 * yet, when `birth` is given — record the owner at once (`claimRunOwner`). Returns who the run acts
 * for (`actingCaller`). Refuses with the store's own error when the owner cannot be read, and with
 * `RunOwnerMismatchError` when the caller may not act on the run; the refusal names nobody.
 *
 * An agent run passes no `birth`: its record is its frozen input, written later by `persistInput`
 * through the same `claimRunOwner`.
 */
export async function admitRun(
  journal: RawJournal,
  runId: string,
  caller: Caller,
  birth?: Record<string, unknown>,
): Promise<{ acting: Caller; owner: RunOwner }> {
  const owner = await runOwnerOf(journal, runId);
  if (owner.state === 'unreadable') throw owner.error;
  const refuse = (recorded: Caller) =>
    new RunOwnerMismatchError(
      `@gnldev/durable: run '${runId}' belongs to a different subject. A run acts for the owner recorded at its start.`,
      { runId, owner: ownerLabel(recorded), requested: ownerLabel(caller) },
    );
  const acting = actingCaller(owner, caller);
  if (!acting) throw refuse(owner.state === 'owned' ? owner.owner : UNKNOWN);
  if (owner.state === 'missing' && birth) {
    // Two births racing for one id: the claim has one winner, and the loser is held to it.
    const recorded = await claimRunOwner(journal, runId, acting, birth);
    const born: RunOwner = { state: 'owned', owner: recorded, kind: 'other', recorded: true };
    const again = actingCaller(born, caller);
    if (!again) throw refuse(recorded);
    return { acting: again, owner: born };
  }
  return { acting, owner };
}
