// The types a user of @gnldev/queue writes code against, as the published declarations (dist) state
// them: a handler written inline gets a typed `ctx` without annotations, `ctx.caller` is the engine's
// `Caller` and `ctx.run` returns a `DurableResult`, `JobCtx.resourceId` (removed in 0.7) stays removed,
// `enqueue` takes the work store and an engine `Caller`, and `jobEraser` is something `eraseSubject`
// accepts. A widening — to `any`, to an index signature, to an optional field brought back — keeps
// every runtime test green, so it is held here.
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

// ─── Handlers ──────────────────────────────────────────────────────────────────────────────────

// The README's "Jobs for an end user" sample. `model` is typed from the engine's own `RunDurableArgs`
// instead of '@ai-sdk/provider', which this package does not depend on.
const README_END_USER = `
import { enqueue, createWorker } from '@gnldev/queue';
import { InMemoryStorage, user } from '@gnldev/durable';
declare const model: import('@gnldev/durable').RunDurableArgs['model'];

const storage = new InMemoryStorage();
await enqueue(storage.work!, 'weekly-summary', { week: 39 }, { caller: user('ayse', 'acme') });

createWorker(storage, {
  'weekly-summary': async (payload, ctx) => ctx.run({ model, prompt: \`Summarise week \${payload.week}\` }),
});
`;

// A handler written inline, with no annotation: its ctx must be inferred as the full JobCtx.
const INLINE_HANDLER = `
import { createWorker } from '@gnldev/queue';
import type { JobCtx } from '@gnldev/queue';
import { InMemoryStorage } from '@gnldev/durable';
import type { Caller, DurableResult, RunDurableArgs, RunJournal, Storage } from '@gnldev/durable';
${HELPERS}
declare const model: RunDurableArgs['model'];
const storage = new InMemoryStorage();

createWorker(storage, {
  report: async (payload, ctx) => {
    const ctxIsJobCtx: Same<typeof ctx, JobCtx> = true;
    const callerIsCaller: Same<typeof ctx.caller, Caller> = true;
    const runReturnsResult: Same<ReturnType<typeof ctx.run>, Promise<DurableResult>> = true;
    const journal: RunJournal = ctx.journal;
    const scoped: Storage = ctx.storage;
    const ids: [string, string, string | undefined] = [ctx.jobId, ctx.runId, ctx.orgId];
    const who = ctx.caller;
    const userId = ctx.caller.kind === 'user' ? ctx.caller.id : undefined;
    const next: Promise<string> = ctx.enqueue('follow-up', { from: ctx.jobId });
    const result = await ctx.run({ model, prompt: 'Summarise' });
    const text: string = result.text;
    return { ctxIsJobCtx, callerIsCaller, runReturnsResult, journal, scoped, ids, who, userId, next, text };
  },
}, { maxAttempts: 3, onError: (err, jobId) => { const id: string = jobId; void err; void id; } });
`;

describe('@gnldev/queue handlers: ctx is inferred, typed, and without the removed field', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      readmeEndUser: README_END_USER,
      inline: INLINE_HANDLER,
      // 0.7 removed JobCtx.resourceId: the owner is ctx.caller.
      removedResourceId: mutate(INLINE_HANDLER, 'const who = ctx.caller;', 'const who = ctx.resourceId;'),
      // ctx.caller is a union: `id` is only a user's, so reading it without narrowing is an error.
      callerNotNarrowed: mutate(INLINE_HANDLER, "ctx.caller.kind === 'user' ? ctx.caller.id : undefined", 'ctx.caller.id'),
      // ctx.run binds the owner itself: a handler cannot hand it another caller.
      runRefusesCaller: mutate(INLINE_HANDLER, "ctx.run({ model, prompt: 'Summarise' })", "ctx.run({ model, prompt: 'Summarise', caller: { kind: 'staff' } })"),
      // ...nor another runId: the job's run is ctx.runId.
      runRefusesRunId: mutate(INLINE_HANDLER, "ctx.run({ model, prompt: 'Summarise' })", "ctx.run({ model, prompt: 'Summarise', runId: 'other' })"),
    });
  }, TIMEOUT);

  it('the README sample compiles', () => expect(d.readmeEndUser).toEqual([]));
  it('an inline handler gets ctx: JobCtx, ctx.caller: Caller, ctx.run(): Promise<DurableResult>', () => expect(d.inline).toEqual([]));
  it('ctx.resourceId is a compile error (TS2339)', () => {
    expect(codes(d.removedResourceId)).toEqual([2339]);
    expect(d.removedResourceId[0].message).toContain("'resourceId'");
  });
  it('ctx.caller.id without narrowing is a compile error (TS2339)', () => {
    expect(codes(d.callerNotNarrowed)).toEqual([2339]);
    expect(d.callerNotNarrowed[0].message).toContain("'id'");
  });
  it('ctx.run does not take a caller (TS2353)', () => {
    expect(codes(d.runRefusesCaller)).toEqual([2353]);
    expect(d.runRefusesCaller[0].message).toContain("'caller'");
  });
  it('ctx.run does not take a runId (TS2353)', () => {
    expect(codes(d.runRefusesRunId)).toEqual([2353]);
    expect(d.runRefusesRunId[0].message).toContain("'runId'");
  });
});

// ─── enqueue, createWorker's arguments, jobEraser ─────────────────────────────────────────────

const ENQUEUE_AND_ERASE = `
import { enqueue, createWorker, jobEraser } from '@gnldev/queue';
import type { EnqueueOptions, Worker } from '@gnldev/queue';
import { InMemoryStorage, eraseSubject, user, staff } from '@gnldev/durable';
import type { Caller, EraseReport, SubjectEraser } from '@gnldev/durable';
${HELPERS}
const storage = new InMemoryStorage();

const a: Promise<string> = enqueue(storage.work!, 'send-email', { to: 'a@x.com' }, { id: 'email:order-1' });
const b = enqueue(storage.work!, 'weekly-summary', { week: 39 }, { caller: user('ayse', 'acme') });
const c = enqueue(storage.work!, 'weekly-summary', { week: 39 }, { resourceId: 'ayse', orgId: 'acme', maxDepth: 100 });
const s = enqueue(storage.work!, 'reindex', {}, { caller: staff() });
const callerOption: Same<EnqueueOptions['caller'], Caller | undefined> = true;

const worker: Worker = createWorker(storage, { 'send-email': async () => undefined });

const eraser: SubjectEraser = jobEraser(storage);
const report: EraseReport = await eraseSubject(storage, 'ayse', { orgId: 'acme', erasers: [jobEraser(storage)] });
const byEraser: Record<string, number> = report.byEraser;

export { a, b, c, s, callerOption, worker, eraser, byEraser };
`;

// Nothing a user touches is `any`. The handler's payload is `any` by design (JobHandler), so it is
// not in this list; everything the queue itself hands the handler or returns to the caller is.
const NOTHING_IS_ANY = `
import type { enqueue, createWorker, jobEraser, listJobs, retryJob, moveJob, JobCtx, JobHandler, EnqueueOptions, Worker, JobStatus } from '@gnldev/queue';
${HELPERS}
const ctx: IsAny<JobCtx> = false;
const handlerCtx: IsAny<Parameters<JobHandler>[1]> = false;
const caller: IsAny<JobCtx['caller']> = false;
const runArgs: IsAny<Parameters<JobCtx['run']>[0]> = false;
const runResult: IsAny<Awaited<ReturnType<JobCtx['run']>>> = false;
const journal: IsAny<JobCtx['journal']> = false;
const storage: IsAny<JobCtx['storage']> = false;
const ctxEnqueue: IsAny<ReturnType<JobCtx['enqueue']>> = false;
const enqueueOptionsCaller: IsAny<EnqueueOptions['caller']> = false;
const enqueueReturn: IsAny<Awaited<ReturnType<typeof enqueue>>> = false;
const enqueueWork: IsAny<Parameters<typeof enqueue>[0]> = false;
const workerStorage: IsAny<Parameters<typeof createWorker>[0]> = false;
const workerHandlers: IsAny<Parameters<typeof createWorker>[1]> = false;
const worker: IsAny<Worker> = false;
const eraser: IsAny<ReturnType<typeof jobEraser>> = false;
const eraserArg: IsAny<Parameters<typeof jobEraser>[0]> = false;
const jobs: IsAny<Awaited<ReturnType<typeof listJobs>>[number]> = false;
const jobStatus: IsAny<JobStatus['status']> = false;
const retry: IsAny<Awaited<ReturnType<typeof retryJob>>> = false;
const move: IsAny<Parameters<typeof moveJob>[2]> = false;
export { ctx, handlerCtx, caller, runArgs, runResult, journal, storage, ctxEnqueue, enqueueOptionsCaller, enqueueReturn, enqueueWork, workerStorage, workerHandlers, worker, eraser, eraserArg, jobs, jobStatus, retry, move };
`;

describe('@gnldev/queue enqueue, createWorker and jobEraser', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      base: ENQUEUE_AND_ERASE,
      nothingIsAny: NOTHING_IS_ANY,
      // The control for the list above: an `any` in it is caught.
      anyIsCaught: mutate(NOTHING_IS_ANY, "IsAny<JobCtx['caller']>", 'IsAny<any>'),
      // caller is an engine Caller, not a bare user id.
      callerIsNotAString: mutate(ENQUEUE_AND_ERASE, "{ caller: user('ayse', 'acme') }", "{ caller: 'ayse' }"),
      // An option enqueue does not have is refused, not silently ignored.
      unknownOption: mutate(ENQUEUE_AND_ERASE, "{ id: 'email:order-1' }", "{ id: 'email:order-1', owner: 'ayse' }"),
      // enqueue takes the WORK store, not the storage.
      enqueueTakesWork: mutate(ENQUEUE_AND_ERASE, "enqueue(storage.work!, 'send-email'", "enqueue(storage, 'send-email'"),
      // createWorker takes the whole storage, not the work store.
      workerTakesStorage: mutate(ENQUEUE_AND_ERASE, 'createWorker(storage, {', 'createWorker(storage.work!, {'),
      // jobEraser takes the storage (it reaches the run journal too), not the work store.
      eraserTakesStorage: mutate(ENQUEUE_AND_ERASE, 'erasers: [jobEraser(storage)]', 'erasers: [jobEraser(storage.work!)]'),
    });
  }, TIMEOUT);

  it('enqueue with a Caller or the shorthand, createWorker, and jobEraser inside eraseSubject compile', () => expect(d.base).toEqual([]));
  it('nothing public is any', () => expect(d.nothingIsAny).toEqual([]));
  it('the any check can fail (TS2322)', () => expect(codes(d.anyIsCaught)).toEqual([2322]));
  it("enqueue's caller is a Caller, not a string (TS2322)", () => expect(codes(d.callerIsNotAString)).toEqual([2322]));
  it('enqueue refuses an unknown option (TS2353)', () => {
    expect(codes(d.unknownOption)).toEqual([2353]);
    expect(d.unknownOption[0].message).toContain("'owner'");
  });
  it('enqueue refuses the storage in place of its work store (TS2345)', () => expect(codes(d.enqueueTakesWork)).toEqual([2345]));
  it('createWorker refuses the work store in place of the storage (TS2345)', () => expect(codes(d.workerTakesStorage)).toEqual([2345]));
  it('jobEraser refuses the work store in place of the storage (TS2345)', () => expect(codes(d.eraserTakesStorage)).toEqual([2345]));
});
