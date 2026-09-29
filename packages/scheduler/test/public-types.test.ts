// The types a user of @gnldev/scheduler writes code against, as the published declarations (dist)
// state them: `scheduleWorkflow`'s spec with an engine `Caller`, the `WorkflowRunner` the scheduler
// fires into — which `createGnl()` must satisfy, and whose options are `{ runId, caller }` since 0.7
// (`resourceId` was removed) — a runner, a budget guard and a waker's `resume` written inline get typed
// parameters without annotations, and `triggerEraser` is something `eraseSubject` accepts. A widening
// — to `any`, or back to the old option — keeps every runtime test green, so it is held here.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` or
// a `@ts-expect-error` here would pass whatever the types said. Every negative case is its positive
// case with ONE mutation, and asserts the exact TypeScript error code that mutation must produce — a
// negative that only counted errors would also pass on a typo'd import (TS2305).
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** The base with exactly one occurrence of `from` replaced; throws if `from` is not there exactly once. */

const codes = (d: TypeDiagnostic[]) => d.map((x) => x.code);
const TIMEOUT = 60_000;

const HELPERS = `
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
`;

// ─── Triggers and runners ──────────────────────────────────────────────────────────────────────

// The README's "Triggers for an end user" sample, with the names it assumes declared: the root
// journal and the host's createGnl config. `createGnl()`'s return is handed to createScheduler as a
// WorkflowRunner, so this also holds the two to each other.
const README_END_USER = `
import { scheduleWorkflow, createScheduler } from '@gnldev/scheduler';
import { createGnl, scopeConfigToOrg, InMemoryJournal } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';
const journal = new InMemoryJournal();
declare const config: CreateGnlConfig;
const gnl = createGnl(config);

await scheduleWorkflow(journal, {
  id: 'ayse-weekly', every: 7 * 24 * 3600_000, name: 'weekly-summary',
  resourceId: 'ayse', orgId: 'acme',
});

// Each organization's runner. Cache it; building it per fire is wasteful.
const gnlFor = (orgId: string) => createGnl(scopeConfigToOrg(config, orgId).config);
createScheduler(journal, gnl, { runnerForOrg: gnlFor }).start();
`;

// A runner and a budget guard written inline: their parameters must be inferred from the scheduler.
const INLINE_RUNNER = `
import { scheduleWorkflow, createScheduler, pollScheduler, listTriggers } from '@gnldev/scheduler';
import type { PollResult, ScheduleSpec, TriggerInfo } from '@gnldev/scheduler';
import { InMemoryJournal, user, staff } from '@gnldev/durable';
import type { Caller } from '@gnldev/durable';
${HELPERS}
const journal = new InMemoryJournal();

const id: Promise<string> = scheduleWorkflow(journal, { id: 'nightly-invoices', cron: '0 3 * * *', name: 'invoices' });
await scheduleWorkflow(journal, { name: 'weekly-summary', every: 604_800_000, caller: user('ayse', 'acme') });
await scheduleWorkflow(journal, { name: 'reindex', at: Date.now() + 1000, caller: staff(), misfire: 'catchup' });
const callerOption: Same<ScheduleSpec['caller'], Caller | undefined> = true;

const scheduler = createScheduler(journal, {
  async runWorkflow(name, input, opts) {
    const optsType: Same<typeof opts, { runId?: string; caller?: Caller } | undefined> = true;
    const caller = opts?.caller;
    const userId = caller?.kind === 'user' ? caller.id : undefined;
    return { runId: opts?.runId ?? name, output: { input, optsType, userId } };
  },
}, {
  budgetGuard: (ctx) => {
    const ctxNotAny: IsAny<typeof ctx> = false;
    const who: [string, string, unknown, number, string | undefined, string | undefined] =
      [ctx.triggerId, ctx.workflowName, ctx.input, ctx.now, ctx.orgId, ctx.resourceId];
    return [who, ctxNotAny];
  },
});
const polled: PollResult = await scheduler.poll();
const fired: number = polled.fired;
const direct: Promise<PollResult> = pollScheduler(journal, { runWorkflow: async (name) => ({ runId: name }) });
const triggers: TriggerInfo[] = await listTriggers(journal);
const status: 'pending' | 'done' | 'failed' | undefined = triggers[0]?.status;
export { id, callerOption, fired, direct, status };
`;

// The README's waker sample: `resume` written inline, with `where` inferred as optional. One change:
// `status.workflowName!`. The README passes `status.workflowName` (`string | undefined`) to a runner
// declared as taking `string`, which strict mode refuses (TS2345); check:docs compiles samples
// non-strict and does not see it. The sample is what needs the `!`, not the type.
const README_WAKER = `
import { createWorkflowWaker } from '@gnldev/scheduler';
import { STAFF, toJournal } from '@gnldev/durable';
declare const storage: import('@gnldev/durable').Storage;
declare const gnl: { runWorkflow(n: string, i: unknown, o?: { runId?: string; caller?: typeof STAFF }): Promise<unknown> };
declare const gnlFor: (orgId: string) => typeof gnl;

createWorkflowWaker({
  journal: toJournal(storage.runs),
  orgs: ['acme', 'globex'], // or a function, asked on every tick
  resume: (runId, status, where) =>
    (where ? gnlFor(where.orgId) : gnl).runWorkflow(status.workflowName!, undefined, { runId, caller: STAFF }),
}).start();
`;

describe('@gnldev/scheduler triggers, runners and the waker', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      readmeEndUser: README_END_USER,
      inline: INLINE_RUNNER,
      readmeWaker: README_WAKER,
      // 0.7 replaced the runner's `resourceId` option with `caller`: reading it is an error.
      removedRunnerResourceId: mutate(INLINE_RUNNER, 'const caller = opts?.caller;', 'const caller = opts?.resourceId;'),
      // The fire's caller is a union: `id` is only a user's.
      callerNotNarrowed: mutate(INLINE_RUNNER, "caller?.kind === 'user' ? caller.id : undefined", 'caller?.id'),
      // A spec's caller is an engine Caller, not a bare user id.
      callerIsNotAString: mutate(INLINE_RUNNER, "caller: user('ayse', 'acme')", "caller: 'ayse'"),
      // A spec without the workflow name is refused.
      nameIsRequired: mutate(INLINE_RUNNER, "{ id: 'nightly-invoices', cron: '0 3 * * *', name: 'invoices' }", "{ id: 'nightly-invoices', cron: '0 3 * * *' }"),
      // The waker's `where` is absent for a run in the root: using it unchecked is an error.
      whereIsOptional: mutate(README_WAKER, '(where ? gnlFor(where.orgId) : gnl)', 'gnlFor(where.orgId)'),
    });
  }, TIMEOUT);

  it('the README end-user sample compiles, createGnl() included as a runner', () => expect(d.readmeEndUser).toEqual([]));
  it('an inline runner and budget guard get typed parameters', () => expect(d.inline).toEqual([]));
  it('the README waker sample compiles (with workflowName!, see above)', () => expect(d.readmeWaker).toEqual([]));
  it("the runner's resourceId option is a compile error (TS2339)", () => {
    expect(codes(d.removedRunnerResourceId)).toEqual([2339]);
    expect(d.removedRunnerResourceId[0].message).toContain("'resourceId'");
  });
  it("the fire's caller.id without narrowing is a compile error (TS2339)", () => {
    expect(codes(d.callerNotNarrowed)).toEqual([2339]);
    expect(d.callerNotNarrowed[0].message).toContain("'id'");
  });
  it("a spec's caller is a Caller, not a string (TS2322)", () => expect(codes(d.callerIsNotAString)).toEqual([2322]));
  it('a spec needs the workflow name (TS2345)', () => {
    expect(codes(d.nameIsRequired)).toEqual([2345]);
    expect(d.nameIsRequired[0].message).toContain("'name'");
  });
  it("the waker's where is optional (TS18048)", () => expect(codes(d.whereIsOptional)).toEqual([18048]));
});

// ─── triggerEraser, and nothing is any ─────────────────────────────────────────────────────────

const ERASE = `
import { triggerEraser } from '@gnldev/scheduler';
import { InMemoryStorage, eraseSubject, toJournal } from '@gnldev/durable';
import type { EraseReport, SubjectEraser } from '@gnldev/durable';
const storage = new InMemoryStorage();
const journal = toJournal(storage.runs);

const eraser: SubjectEraser = triggerEraser(journal);
const report: EraseReport = await eraseSubject(storage, 'ayse', { orgId: 'acme', erasers: [triggerEraser(toJournal(storage.runs))] });
export { eraser, report };
`;

// Nothing a user touches is `any`. A spec's `input` and a fire's output are `unknown` by design.
const NOTHING_IS_ANY = `
import type {
  scheduleWorkflow, pollScheduler, listTriggers, createScheduler, moveTrigger, triggerEraser, createWorkflowWaker,
  ScheduleSpec, WorkflowRunner, BudgetGuard, PollResult, TriggerInfo, Scheduler, WorkflowWakerOptions,
} from '@gnldev/scheduler';
${HELPERS}
type RunnerOpts = NonNullable<Parameters<WorkflowRunner['runWorkflow']>[2]>;
const spec: IsAny<ScheduleSpec> = false;
const specCaller: IsAny<ScheduleSpec['caller']> = false;
const specJournal: IsAny<Parameters<typeof scheduleWorkflow>[0]> = false;
const scheduled: IsAny<Awaited<ReturnType<typeof scheduleWorkflow>>> = false;
const runnerOpts: IsAny<RunnerOpts> = false;
const runnerCaller: IsAny<RunnerOpts['caller']> = false;
const runnerResult: IsAny<Awaited<ReturnType<WorkflowRunner['runWorkflow']>>> = false;
const guardCtx: IsAny<Parameters<BudgetGuard>[0]> = false;
const poll: IsAny<Awaited<ReturnType<typeof pollScheduler>>> = false;
const pollRunner: IsAny<Parameters<typeof pollScheduler>[1]> = false;
const pollResult: IsAny<PollResult['fired']> = false;
const trigger: IsAny<Awaited<ReturnType<typeof listTriggers>>[number]> = false;
const triggerStatus: IsAny<TriggerInfo['status']> = false;
const scheduler: IsAny<ReturnType<typeof createScheduler>> = false;
const schedulerPoll: IsAny<Awaited<ReturnType<Scheduler['poll']>>> = false;
const move: IsAny<Parameters<typeof moveTrigger>[2]> = false;
const eraser: IsAny<ReturnType<typeof triggerEraser>> = false;
const eraserArg: IsAny<Parameters<typeof triggerEraser>[0]> = false;
const wakerResume: IsAny<Parameters<WorkflowWakerOptions['resume']>[1]> = false;
const waker: IsAny<ReturnType<typeof createWorkflowWaker>> = false;
export { spec, specCaller, specJournal, scheduled, runnerOpts, runnerCaller, runnerResult, guardCtx, poll, pollRunner, pollResult, trigger, triggerStatus, scheduler, schedulerPoll, move, eraser, eraserArg, wakerResume, waker };
`;

describe('@gnldev/scheduler triggerEraser, and nothing public is any', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      erase: ERASE,
      nothingIsAny: NOTHING_IS_ANY,
      // The control for the list above: an `any` in it is caught.
      anyIsCaught: mutate(NOTHING_IS_ANY, "IsAny<RunnerOpts['caller']>", 'IsAny<any>'),
      // triggerEraser takes the root journal, not the storage.
      eraserTakesJournal: mutate(ERASE, 'triggerEraser(journal)', 'triggerEraser(storage)'),
    });
  }, TIMEOUT);

  it('triggerEraser is accepted by eraseSubject, as the durable README passes it', () => expect(d.erase).toEqual([]));
  it('nothing public is any', () => expect(d.nothingIsAny).toEqual([]));
  it('the any check can fail (TS2322)', () => expect(codes(d.anyIsCaught)).toEqual([2322]));
  it('triggerEraser refuses the storage in place of the journal (TS2345)', () => expect(codes(d.eraserTakesJournal)).toEqual([2345]));
});
