// The public type contract of @gnldev/durable, as its published declarations (dist) state it: the
// `runDurable` arguments and result, the `Caller` union a door hands the engine, the run-access
// decision, the erasure options/report and the eraser interface third-party code implements, the
// string-literal codes errors put on the wire, and the subpath entries. Every other package builds on
// these, so a contract that silently widens here (a union gaining a member, a field turning `any`, a
// literal code decaying to `string`) widens for all of them.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` or
// a `// @ts-expect-error` here would pass at runtime whatever the types said. Each snippet is compiled
// as if it were a user's file next to this one, resolving `@gnldev/durable` through the package's own
// exports map, exactly as an installed copy would.
//
// Every negative case is its positive baseline with ONE textual mutation (`mutate` refuses a mutation
// that does not apply exactly once), and asserts the SPECIFIC TypeScript error code. A count-only
// negative would also pass on a typo'd import (TS2305) or a missing module (TS2307) — failing for the
// wrong reason and holding nothing.
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** The baseline with `from` replaced by `to`; throws unless `from` occurs exactly once. */

const codes = (d: TypeDiagnostic[]): number[] => d.map((x) => x.code);

/** Shared by every snippet: `IsAny` detects an `any` leak; `Same` is mutual assignability, non-distributive. */
const PRELUDE = `
type IsAny<T> = 0 extends 1 & T ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
`;

const COMPILE_TIMEOUT = 60_000;

describe('runDurable: the arguments a caller must give, and the result it gets back', () => {
  const BASE = `${PRELUDE}
import { runDurable, user, STAFF, type Journal, type DurableResult, type RunDurableArgs, type Caller, type RunIdentity, type Interrupt } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
declare const journal: Journal;
const model = echoModel();
export async function main() {
  const res = await runDurable({ journal, runId: 'order-123', model, prompt: 'Process the order', caller: user('ayse') });
  await runDurable({ journal, runId: 'order-123', model, prompt: 'Process the order', resourceId: 'ayse', replay: 'strict' });
  await runDurable({ journal, runId: 'order-123', model, prompt: 'Process the order', caller: STAFF });
  const r: DurableResult = res;
  const interrupts: Interrupt[] = r.interrupts;
  const text: string = r.text;
  const replayed: string[] | undefined = r.replayedToolCalls?.map((c) => c.origin);
  return { interrupts, text, replayed };
}
const argsNotAny: IsAny<RunDurableArgs> = false;
const resultNotAny: IsAny<DurableResult> = false;
const callerNotAny: IsAny<RunDurableArgs['caller']> = false;
const interruptsNotAny: IsAny<DurableResult['interrupts']> = false;
const callerField: Same<RunDurableArgs['caller'], Caller | RunIdentity | undefined> = true;
const runIdField: Same<RunDurableArgs['runId'], string> = true;
const replayField: Same<RunDurableArgs['replay'], 'strict' | 'lenient' | undefined> = true;
const originField: Same<NonNullable<DurableResult['replayedToolCalls']>[number]['origin'], 'self' | 'window'> = true;
export { argsNotAny, resultNotAny, callerNotAny, interruptsNotAny, callerField, runIdField, replayField, originField };
`;
  const FIRST_CALL = "runDurable({ journal, runId: 'order-123', model, prompt: 'Process the order', caller: user('ayse') })";
  const cases = {
    base: BASE,
    // required: runId and journal are what make a call durable — without them it is plain generateText
    missingRunId: mutate(BASE, FIRST_CALL, "runDurable({ journal, model, prompt: 'Process the order', caller: user('ayse') })"),
    missingJournal: mutate(BASE, FIRST_CALL, "runDurable({ runId: 'order-123', model, prompt: 'Process the order', caller: user('ayse') })"),
    numericRunId: mutate(BASE, "runId: 'order-123', model, prompt: 'Process the order', caller: user", "runId: 123, model, prompt: 'Process the order', caller: user"),
    // caller: only the three kinds; a made-up one is not "some caller"
    inventedCallerKind: mutate(BASE, "caller: user('ayse')", "caller: { kind: 'admin' }"),
    replayOutsideUnion: mutate(BASE, "replay: 'strict'", "replay: 'loose'"),
    // a misspelled option is caught, not ignored (it would silently run without the protection).
    // TS2561 is the excess-property error with a "did you mean" — the specific form of TS2353.
    misspelledOption: mutate(BASE, "resourceId: 'ayse', replay", "resourceID: 'ayse', replay"),
    // the result: interrupts is an array of Interrupt, not something wider
    interruptsAsNumber: mutate(BASE, 'const interrupts: Interrupt[] = r.interrupts;', 'const interrupts: number = r.interrupts;'),
    // the IsAny detector itself fires on `any` (so `false` above means something)
    anyIsDetected: mutate(BASE, 'const argsNotAny: IsAny<RunDurableArgs> = false;', 'const argsNotAny: IsAny<any> = false;'),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('the canonical call compiles clean, with nothing public typed `any`', () => expect(d.base).toEqual([]));
  it('runId is required', () => expect(codes(d.missingRunId)).toEqual([2345]));
  it('journal is required', () => expect(codes(d.missingJournal)).toEqual([2345]));
  it('runId is a string', () => expect(codes(d.numericRunId)).toEqual([2322]));
  it('caller accepts only the Caller kinds', () => expect(codes(d.inventedCallerKind)).toEqual([2322]));
  it("replay is 'strict' | 'lenient'", () => expect(codes(d.replayOutsideUnion)).toEqual([2322]));
  it('a misspelled option is an excess property', () => expect(codes(d.misspelledOption)).toEqual([2561]));
  it('result.interrupts is Interrupt[]', () => expect(codes(d.interruptsAsNumber)).toEqual([2322]));
  it('the IsAny detector fires on any', () => expect(codes(d.anyIsDetected)).toEqual([2322]));
});

describe('Caller: exactly user | staff | unknown, and the constructors that build them', () => {
  const BASE = `${PRELUDE}
import { user, staff, STAFF, UNKNOWN, type Caller, type UserCaller, type StaffCaller, type UnknownCaller } from '@gnldev/durable';
export function describeCaller(c: Caller): string {
  switch (c.kind) {
    case 'user': return c.id;
    case 'staff': return 'staff';
    case 'unknown': return 'nobody';
    default: { const exhaustive: never = c; return exhaustive; }
  }
}
const u: UserCaller = user('ayse');
const uo: UserCaller = user('ayse', 'acme');
const s: StaffCaller = staff();
const so: StaffCaller = staff('acme');
const S: StaffCaller = STAFF;
const U: UnknownCaller = UNKNOWN;
const literal: Caller = { kind: 'user', id: 'ayse' };
const kinds: Same<Caller['kind'], 'user' | 'staff' | 'unknown'> = true;
const userShape: Same<UserCaller, { kind: 'user'; id: string; orgId?: string }> = true;
const staffShape: Same<StaffCaller, { kind: 'staff'; orgId?: string }> = true;
const unknownShape: Same<UnknownCaller, { kind: 'unknown' }> = true;
const callerNotAny: IsAny<Caller> = false;
const userIdNotAny: IsAny<UserCaller['id']> = false;
export { u, uo, s, so, S, U, literal, kinds, userShape, staffShape, unknownShape, callerNotAny, userIdNotAny };
`;
  const cases = {
    base: BASE,
    // the exhaustive switch: drop one member's case and the default is no longer `never`
    switchMissesStaff: mutate(BASE, "    case 'staff': return 'staff';\n", ''),
    userWithoutId: mutate(BASE, "const literal: Caller = { kind: 'user', id: 'ayse' };", "const literal: Caller = { kind: 'user' };"),
    inventedKind: mutate(BASE, "const literal: Caller = { kind: 'user', id: 'ayse' };", "const literal: Caller = { kind: 'admin' };"),
    // user() needs an id; staff() is not a user
    userNoArgs: mutate(BASE, "const u: UserCaller = user('ayse');", 'const u: UserCaller = user();'),
    userNumericId: mutate(BASE, "const u: UserCaller = user('ayse');", 'const u: UserCaller = user(42);'),
    // TS2741: the staff shape lacks the `id` a user caller requires
    staffIsNotUser: mutate(BASE, 'const s: StaffCaller = staff();', 'const s: UserCaller = staff();'),
    // unknown has no id to read
    readIdOfUnknown: mutate(BASE, "case 'unknown': return 'nobody';", "case 'unknown': return c.id;"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('an exhaustive switch over the three kinds compiles clean; shapes are exact', () => expect(d.base).toEqual([]));
  it('a switch missing a kind does not reach `never`', () => expect(codes(d.switchMissesStaff)).toEqual([2322]));
  it('a user caller carries an id', () => expect(codes(d.userWithoutId)).toEqual([2322]));
  it('there is no fourth kind', () => expect(codes(d.inventedKind)).toEqual([2322]));
  it('user() requires an id', () => expect(codes(d.userNoArgs)).toEqual([2554]));
  it('user() takes a string id', () => expect(codes(d.userNumericId)).toEqual([2345]));
  it('staff() is not a user caller', () => expect(codes(d.staffIsNotUser)).toEqual([2741]));
  it('the unknown caller has no id', () => expect(codes(d.readIdOfUnknown)).toEqual([2339]));
});

describe('decideRunAccess: one rule, three answers', () => {
  const BASE = `${PRELUDE}
import { decideRunAccess, user, STAFF, type RunOwner, type RunDecision } from '@gnldev/durable';
declare const owner: RunOwner;
const decision: RunDecision = decideRunAccess(owner, user('ayse'));
export function httpStatus(d: RunDecision): number {
  switch (d) {
    case 'allow': return 200;
    case 'deny': return 403;
    case 'missing': return 404;
    default: { const exhaustive: never = d; return exhaustive; }
  }
}
export function ownerState(o: RunOwner): string {
  switch (o.state) {
    case 'missing': return 'none';
    case 'owned': return o.owner.kind;
    case 'unreadable': return 'error';
    default: { const exhaustive: never = o; return exhaustive; }
  }
}
const asStaff: RunDecision = decideRunAccess(owner, STAFF);
const answers: Same<RunDecision, 'allow' | 'deny' | 'missing'> = true;
const returns: Same<ReturnType<typeof decideRunAccess>, RunDecision> = true;
const states: Same<RunOwner['state'], 'missing' | 'owned' | 'unreadable'> = true;
const decisionNotAny: IsAny<RunDecision> = false;
const ownerNotAny: IsAny<RunOwner> = false;
export { decision, asStaff, answers, returns, states, decisionNotAny, ownerNotAny };
`;
  const cases = {
    base: BASE,
    switchMissesDeny: mutate(BASE, "    case 'deny': return 403;\n", ''),
    ownerSwitchMissesUnreadable: mutate(BASE, "    case 'unreadable': return 'error';\n", ''),
    // a decision is not a boolean — `missing` is the third answer a door must handle
    decisionAsBoolean: mutate(BASE, "const decision: RunDecision = decideRunAccess(owner, user('ayse'));", "const decision: boolean = decideRunAccess(owner, user('ayse'));"),
    callerRequired: mutate(BASE, 'decideRunAccess(owner, STAFF)', 'decideRunAccess(owner)'),
    // a bare user id is not a Caller: the kind must be said
    callerAsString: mutate(BASE, 'decideRunAccess(owner, STAFF)', "decideRunAccess(owner, 'ayse')"),
    // `owner` exists only on an owned run
    ownerOfMissing: mutate(BASE, "case 'missing': return 'none';", "case 'missing': return o.owner.kind;"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('exhaustive switches over RunDecision and RunOwner compile clean', () => expect(d.base).toEqual([]));
  it('a switch missing a decision does not reach `never`', () => expect(codes(d.switchMissesDeny)).toEqual([2322]));
  it('a switch missing an owner state does not reach `never`', () => expect(codes(d.ownerSwitchMissesUnreadable)).toEqual([2322]));
  it('the decision is not a boolean', () => expect(codes(d.decisionAsBoolean)).toEqual([2322]));
  it('the caller is required', () => expect(codes(d.callerRequired)).toEqual([2554]));
  it('a bare string is not a caller', () => expect(codes(d.callerAsString)).toEqual([2345]));
  it('a missing run has no owner to read', () => expect(codes(d.ownerOfMissing)).toEqual([2339]));
});

describe('eraseSubject: options, report and the eraser interface', () => {
  // The README's "Erasing a person" sample, with the three background packages' erasers replaced by one
  // written here — they are not dependencies of this package, and a third-party eraser is exactly the
  // interface under test.
  const BASE = `${PRELUDE}
import { InMemoryStorage, eraseSubject, type EraseOptions, type EraseReport, type SubjectEraser } from '@gnldev/durable';

const tickets: SubjectEraser = {
  name: 'tickets',
  async erase(owner) {
    const who: string = owner.resourceId;
    const org: string | undefined = owner.orgId;
    return who.length + (org ? 1 : 0);
  },
};

export async function main() {
  const storage = new InMemoryStorage();
  const report = await eraseSubject(storage, 'ayse', {
    orgId: 'acme', // omit for a person outside organizations
    erasers: [tickets],
  });
  const otherStorage = new InMemoryStorage();
  const { memoryThreads, unreachedThreads } = await eraseSubject(storage, 'ayse', { memory: otherStorage });
  const bare: EraseReport = await eraseSubject(storage, 'ayse');
  const journalRows: number = report.journalRows;
  const removedByTickets: number | undefined = report.byEraser['tickets'];
  const firstUnreached: string | undefined = unreachedThreads[0];
  return { memoryThreads, bare, journalRows, removedByTickets, firstUnreached };
}

const reportShape: Same<EraseReport, {
  journalRows: number; workRecords: number; memoryThreads: number; workingMemory: number;
  unreachedThreads: string[]; byEraser: Record<string, number>;
}> = true;
const optionKeys: Same<keyof EraseOptions, 'orgId' | 'erasers' | 'memory'> = true;
const eraserReturns: Same<ReturnType<SubjectEraser['erase']>, Promise<number>> = true;
const eraserOwner: Same<Parameters<SubjectEraser['erase']>[0], { resourceId: string; orgId?: string }> = true;
const reportNotAny: IsAny<EraseReport> = false;
const journalRowsNotAny: IsAny<EraseReport['journalRows']> = false;
const workRecordsNotAny: IsAny<EraseReport['workRecords']> = false;
const memoryThreadsNotAny: IsAny<EraseReport['memoryThreads']> = false;
const workingMemoryNotAny: IsAny<EraseReport['workingMemory']> = false;
const unreachedNotAny: IsAny<EraseReport['unreachedThreads']> = false;
const byEraserNotAny: IsAny<EraseReport['byEraser']> = false;
const memoryOptNotAny: IsAny<EraseOptions['memory']> = false;
const eraseReturnsNotAny: IsAny<Awaited<ReturnType<typeof eraseSubject>>> = false;
export {
  tickets, reportShape, optionKeys, eraserReturns, eraserOwner, reportNotAny, journalRowsNotAny, workRecordsNotAny,
  memoryThreadsNotAny, workingMemoryNotAny, unreachedNotAny, byEraserNotAny, memoryOptNotAny, eraseReturnsNotAny,
};
`;
  const cases = {
    base: BASE,
    // the person is required: an erasure of "nobody" is not a no-op the types should allow
    missingResourceId: mutate(BASE, "const bare: EraseReport = await eraseSubject(storage, 'ayse');", 'const bare: EraseReport = await eraseSubject(storage);'),
    numericOrgId: mutate(BASE, "orgId: 'acme', // omit", 'orgId: 7, // omit'),
    // TS2561 (excess property, "did you mean"): a typo in the organization option would erase across the whole deployment's namespace instead
    misspelledOrgId: mutate(BASE, "orgId: 'acme', // omit", "orgID: 'acme', // omit"),
    // the eraser interface: a name, and a count of what was removed
    eraserWithoutName: mutate(BASE, "  name: 'tickets',\n", ''),
    eraserReturnsString: mutate(BASE, 'return who.length + (org ? 1 : 0);', 'return String(who.length);'),
    eraserOwnerHasNoRunId: mutate(BASE, 'const who: string = owner.resourceId;', 'const who: string = owner.runId;'),
    // the storage itself, not one of its stores (the runtime refuses that too)
    storageAsJournal: mutate(BASE, "const bare: EraseReport = await eraseSubject(storage, 'ayse');", "const bare: EraseReport = await eraseSubject(storage.runs, 'ayse');"),
    unreachedAsCount: mutate(BASE, 'const firstUnreached: string | undefined = unreachedThreads[0];', 'const firstUnreached: number = unreachedThreads;'),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('the README sample compiles clean; the report has exactly the documented fields and types', () => expect(d.base).toEqual([]));
  it('resourceId is required', () => expect(codes(d.missingResourceId)).toEqual([2554]));
  it('orgId is a string', () => expect(codes(d.numericOrgId)).toEqual([2322]));
  it('a misspelled option is an excess property', () => expect(codes(d.misspelledOrgId)).toEqual([2561]));
  it('an eraser has a name', () => expect(codes(d.eraserWithoutName)).toEqual([2741]));
  it('an eraser returns a count', () => expect(codes(d.eraserReturnsString)).toEqual([2322]));
  it('an eraser is handed an owner, not a run', () => expect(codes(d.eraserOwnerHasNoRunId)).toEqual([2339]));
  it('eraseSubject takes the storage, not its journal', () => expect(codes(d.storageAsJournal)).toEqual([2345]));
  it('unreachedThreads is a list of thread ids', () => expect(codes(d.unreachedAsCount)).toEqual([2322]));
});

describe('error codes on the wire are string literals, not string', () => {
  const BASE = `${PRELUDE}
import {
  LIMIT_ERROR_CODES, UPSTREAM_ERROR_CODES, RunLimitExceededError, ToolLoopDetectedError, RunCanceledError, OwnerIdError,
  VectorOwnerConflictError, IdempotencyOwnerMismatchError, upstreamFailure, type UpstreamFailure, type RunLimitKind,
} from '@gnldev/durable';
const limit: Same<typeof LIMIT_ERROR_CODES, { readonly runLimitExceeded: 'run_limit_exceeded'; readonly toolLoopDetected: 'tool_loop_detected' }> = true;
const upstream: Same<typeof UPSTREAM_ERROR_CODES, {
  readonly rateLimited: 'upstream_rate_limited'; readonly unauthorized: 'upstream_unauthorized';
  readonly unavailable: 'upstream_unavailable'; readonly timeout: 'upstream_timeout';
}> = true;
const upstreamCode: Same<UpstreamFailure['code'], 'upstream_rate_limited' | 'upstream_unauthorized' | 'upstream_unavailable' | 'upstream_timeout'> = true;
const upstreamStatus: Same<UpstreamFailure['status'], 429 | 502 | 504> = true;
const upstreamReturn: Same<ReturnType<typeof upstreamFailure>, UpstreamFailure | undefined> = true;
const canceled: Same<RunCanceledError['code'], 'run_canceled'> = true;
const ownerId: Same<OwnerIdError['code'], 'owner_id_invalid'> = true;
const vectorOwner: Same<VectorOwnerConflictError['code'], 'vector_owner_conflict'> = true;
const idemOwner: Same<IdempotencyOwnerMismatchError['code'], 'idempotency_owner_mismatch'> = true;
const limitKind: Same<RunLimitExceededError['detail']['kind'], RunLimitKind> = true;
const limitKinds: Same<RunLimitKind, 'maxCostUsd' | 'maxTokens' | 'maxToolCalls'> = true;
const loopDetail: Same<ToolLoopDetectedError['detail'], { toolName: string; argsHash: string; repeats: number; maxRepeats: number }> = true;
export function onError(err: unknown): string | undefined {
  if (err instanceof RunLimitExceededError) return LIMIT_ERROR_CODES.runLimitExceeded;
  if (err instanceof ToolLoopDetectedError) return LIMIT_ERROR_CODES.toolLoopDetected;
  if (err instanceof RunCanceledError) { const c: 'run_canceled' = err.code; return c; }
  return upstreamFailure(err)?.code;
}
declare const canceledErr: RunCanceledError;
export function tamper() {
  const code: string = canceledErr.code;
  return code;
}
const detailNotAny: IsAny<RunLimitExceededError['detail']> = false;
const codeNotAny: IsAny<RunCanceledError['code']> = false;
export { limit, upstream, upstreamCode, upstreamStatus, upstreamReturn, canceled, ownerId, vectorOwner, idemOwner, limitKind, limitKinds, loopDetail, detailNotAny, codeNotAny };
`;
  const cases = {
    base: BASE,
    // the literal is the contract: a code is not interchangeable with its sibling
    limitCodeSwapped: mutate(BASE, "readonly runLimitExceeded: 'run_limit_exceeded'; readonly toolLoopDetected", "readonly runLimitExceeded: 'tool_loop_detected'; readonly toolLoopDetected"),
    // negative control of `Same`: a literal is not the same type as `string`
    canceledIsNotString: mutate(BASE, "Same<RunCanceledError['code'], 'run_canceled'>", "Same<RunCanceledError['code'], string>"),
    // readonly on the wire: nobody reassigns a code
    reassignLimitCode: mutate(BASE, 'const code: string = canceledErr.code;', "const code: string = (LIMIT_ERROR_CODES.runLimitExceeded = 'x');"),
    reassignErrorCode: mutate(BASE, 'const code: string = canceledErr.code;', "const code: string = (canceledErr.code = 'run_canceled');"),
    // a code the map does not have is not silently `string`
    unknownLimitKey: mutate(BASE, 'return LIMIT_ERROR_CODES.toolLoopDetected;', 'return LIMIT_ERROR_CODES.toolLoop;'),
    wrongLiteralForCanceled: mutate(BASE, "const c: 'run_canceled' = err.code;", "const c: 'run_cancelled' = err.code;"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('every code field is its exact literal, and the maps are readonly literal records', () => expect(d.base).toEqual([]));
  it('the two limit codes are distinct literals', () => expect(codes(d.limitCodeSwapped)).toEqual([2322]));
  it('a literal code is not `string`', () => expect(codes(d.canceledIsNotString)).toEqual([2322]));
  it('LIMIT_ERROR_CODES is readonly', () => expect(codes(d.reassignLimitCode)).toEqual([2540]));
  it("an error's code is readonly", () => expect(codes(d.reassignErrorCode)).toEqual([2540]));
  it('LIMIT_ERROR_CODES has no index signature', () => expect(codes(d.unknownLimitKey)).toEqual([2339]));
  it("RunCanceledError's code is exactly 'run_canceled'", () => expect(codes(d.wrongLiteralForCanceled)).toEqual([2322]));
});

describe('subpath entries resolve with types', () => {
  const BASE = `${PRELUDE}
import type { Storage, ModelInput } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { PostgresStorage, type PostgresStorageOptions } from '@gnldev/durable/postgres';
import { RedisStorage, type RedisStorageOptions } from '@gnldev/durable/redis';
import { echoModel, toolCallingModel, type ToolCallingModelOptions } from '@gnldev/durable/mock';
const sqlite: Storage = new SqliteStorage('runs.db');
const inMemorySqlite: Storage = new SqliteStorage();
declare const pgOpts: PostgresStorageOptions;
const pg: Storage = new PostgresStorage(pgOpts);
declare const redisOpts: RedisStorageOptions;
const redis: Storage = new RedisStorage(redisOpts);
const echo: ModelInput = echoModel();
declare const toolOpts: ToolCallingModelOptions;
const calling: ModelInput = toolCallingModel(toolOpts);
const sqliteNotAny: IsAny<typeof SqliteStorage> = false;
const pgNotAny: IsAny<typeof PostgresStorage> = false;
const redisNotAny: IsAny<typeof RedisStorage> = false;
const echoNotAny: IsAny<typeof echoModel> = false;
const modelNotAny: IsAny<ReturnType<typeof echoModel>> = false;
export { sqlite, inMemorySqlite, pg, redis, echo, calling, sqliteNotAny, pgNotAny, redisNotAny, echoNotAny, modelNotAny };
`;
  const cases = {
    base: BASE,
    // a subpath that is not in the exports map does not resolve
    unknownSubpath: mutate(BASE, "from '@gnldev/durable/mock';", "from '@gnldev/durable/mocks';"),
    // the storages are typed classes, so a wrong constructor argument is caught
    sqliteNumericPath: mutate(BASE, "new SqliteStorage('runs.db')", 'new SqliteStorage(5432)'),
    // a subpath exports what it says and nothing else
    wrongExportFromSubpath: mutate(BASE, "import { SqliteStorage } from '@gnldev/durable/sqlite';", "import { SqliteStorage, PostgresStorage as Pg } from '@gnldev/durable/sqlite';"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, COMPILE_TIMEOUT);

  it('/sqlite, /postgres, /redis and /mock resolve to typed Storage classes and models', () => expect(d.base).toEqual([]));
  it('an unknown subpath does not resolve', () => expect(codes(d.unknownSubpath)).toEqual([2307]));
  it("SqliteStorage's path is a string", () => expect(codes(d.sqliteNumericPath)).toEqual([2345]));
  it('a subpath does not re-export another', () => expect(codes(d.wrongExportFromSubpath)).toEqual([2305]));
});
