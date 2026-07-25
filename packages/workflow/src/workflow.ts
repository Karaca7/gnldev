// Durable deterministic workflow: each step's output is journaled with (runId, stepId).
// On crash→resume, COMPLETED steps do NOT run again (exactly-once); resumes from where it left off.
// Structurally compatible with @gnl/durable's Journal (JournalLike) — zero dependency for the package.

export interface JournalLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /**
   * Optional (CAS): writes and returns `true` when the key is ABSENT, returns `false` without
   * touching anything if it exists. Prevents the same step from running twice in multi-worker
   * setups (structurally compatible with @gnl/durable Journal.putIfAbsent). If undefined, falls
   * back to get+put (single-process safe, behavior unchanged).
   */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
  /**
   * Optional: field-based ATOMIC counter increment (structurally compatible with @gnl/durable
   * Journal.incrBy). Saves the retry counter from get→put's lost-update race. If undefined,
   * falls back to the existing path.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<void>;
  /** Optional: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P0.4 (optional): keys starting with a prefix — structurally compatible with @gnl/durable
   * Journal.listKeys. Only `listWorkflowRuns` (the suspended-run registry query) needs it; every
   * engine path works without it.
   */
  listKeys?(prefix: string): Promise<string[]>;
}

export interface StepCtx {
  runId: string;
  journal: JournalLike;
  /** Journal-key prefix for nested workflows (propagated via asStep; prevents collisions). */
  keyPrefix?: string;
  /**
   * P0.4: in-process cancellation signal (from `runResumable`'s opts.signal). Long-running steps
   * SHOULD observe it (pass to fetch/model calls); the ENGINE checks it between steps either way.
   */
  signal?: AbortSignal;
  /**
   * P0.4 typed resume: reads the resume payload delivered for `waitId` (journaled under
   * `<runId>:wf:_resume:<waitId>` by `runResumable({ resume })`), or `undefined` if none arrived yet.
   * The payload lives in the JOURNAL → reading it is replay-deterministic: once the consuming step
   * completes, its output is journaled and the payload is never re-read on replay.
   * NOTE: `waitId`s share ONE per-run namespace (deliberately NOT keyPrefix-scoped — the operator
   * resuming a run addresses a waitId without knowing which nested workflow hosts it); keep them
   * unique across nested workflows the same way you already must for `_suspend`.
   */
  resumeData?<T = unknown>(waitId: string): Promise<T | undefined>;
}

// ── P0.4 key builders (single source of truth for the new key shapes) ──────────
/** Resume payload for a waitId (per-run namespace, NOT keyPrefix-scoped — see StepCtx.resumeData). */
const resumeKey = (runId: string, waitId: string) => `${runId}:wf:_resume:${waitId}`;
/** Durable cancel flag — once written, NO worker will run further steps of this run (cross-process). */
const canceledKey = (runId: string) => `${runId}:wf:_canceled`;
/**
 * Top-level status registry key. Deliberately NOT under `<runId>:` — a `wfrun:` prefix scan
 * (`listKeys('wfrun:')`) enumerates every workflow run in ONE query, which a runId-prefixed key
 * cannot offer (no suffix scans). Same pattern precedent as @gnl/durable's `xrun:` cross-run keys:
 * invisible to parseJournalKey (not part of any single run's timeline) and org-prefixed automatically
 * by `withOrg` (it prefixes ALL keys unconditionally) → organization isolation is preserved.
 * Cleanup note (same as xrun:): run-retention sweeps that delete `<runId>:*` do NOT touch this key —
 * purge explicitly via `deletePrefix('wfrun:')` (all) — but BEWARE the per-run form:
 * `deletePrefix('wfrun:<runId>')` is PREFIX-matched, so runId 'r1' would also sweep 'r10'/'r1x'
 * (there is no trailing terminator in this key shape). Safe only when runIds cannot share prefixes
 * (UUIDs). Org deployments don't need it at all: the key is org-prefixed, so a GDPR
 * `purgeOrganization`/`deletePrefix('org:<id>:')` sweeps the org's wfrun records exactly.
 */
const statusKey = (runId: string) => `wfrun:${runId}`;
const WFRUN_PRE = 'wfrun:';

export interface Step<I = any, O = any> {
  id: string;
  run(input: I, ctx: StepCtx): Promise<O>;
}

export function step<I = any, O = any>(
  id: string,
  run: (input: I, ctx: StepCtx) => Promise<O>,
): Step<I, O> {
  return { id, run };
}

// Atomic claim — identical contract to `claim` in @gnl/durable (packages/durable/src/journal.ts;
// kept as a local copy since the package stays zero-dependency): CAS if putIfAbsent exists, else
// get+put fallback (single-process safe). Returns `true` if this call created the key.
async function claim(journal: JournalLike, key: string, value: unknown): Promise<boolean> {
  if (journal.putIfAbsent) return journal.putIfAbsent(key, value);
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, value);
  return true;
}

// Runs a step exactly-once: if a record exists, returns it (replay); otherwise runs it and records
// it via CAS — the loser of the race DISCARDS its own result and returns the winner's record (single
// source of truth in multi-worker setups). This is @gnl/durable's `frozenGet` adapted to workflow;
// the ONLY difference is the record shape: existing workflow records are plain values WITHOUT a `{ v }`
// wrapper, kept this way for backward compatibility (using frozenGet would make old records unreadable).
// The plain shape's known limitation still holds: an `undefined` output cannot be distinguished from
// "no record" (that step re-runs on replay) — behavior unchanged.
async function runStep(s: Step, input: any, ctx: StepCtx): Promise<any> {
  const key = `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}`;
  const cached = await ctx.journal.get(key);
  if (cached !== undefined) return cached;
  const out = await s.run(input, ctx);
  if (await claim(ctx.journal, key, out)) return out;
  // Race lost: the winner's record is the single source of truth. If the winner wrote `undefined`
  // (indistinguishable in the plain shape) we fall back to our own output — both results are products
  // of the same step anyway.
  const winner = await ctx.journal.get(key);
  return winner === undefined ? out : winner;
}

export class Workflow<I = any, O = any> {
  constructor(private readonly steps: Step[]) {}

  /** Add a sequential step (previous output becomes this step's input). */
  then<NO>(s: Step<O, NO>): Workflow<I, NO> {
    return new Workflow<I, NO>([...this.steps, s]);
  }

  /** Transform the previous output with a pure function (journaled → replay-safe). If no id is given, one is derived uniquely. */
  map<NO>(fn: (input: O) => NO | Promise<NO>, id?: string): Workflow<I, NO> {
    const mid = id ?? `map#${this.steps.length}`;
    const mapStep: Step<O, NO> = { id: mid, run: async (input) => fn(input) };
    return new Workflow<I, NO>([...this.steps, mapStep]);
  }

  /** Parallel steps (all receive the same input; output is `{ [stepId]: output }`). Each sub-step is journaled separately. */
  parallel(steps: Step<O, any>[], id?: string): Workflow<I, Record<string, any>> {
    const pid = id ?? `parallel(${steps.map((s) => s.id).join('+')})`;
    const composite: Step<O, Record<string, any>> = {
      id: pid,
      run: async (input, ctx) => {
        const entries = await Promise.all(
          steps.map(async (s) => [s.id, await runStep(s, input, ctx)] as const),
        );
        return Object.fromEntries(entries);
      },
    };
    return new Workflow<I, Record<string, any>>([...this.steps, composite]);
  }

  /** Conditional branch: cond(input) ? ifStep : elseStep. */
  branch<NO>(cond: (input: O) => boolean, ifStep: Step<O, NO>, elseStep: Step<O, NO>, id?: string): Workflow<I, NO> {
    const bid = id ?? `branch(${ifStep.id}|${elseStep.id})`;
    const composite: Step<O, NO> = {
      id: bid,
      run: async (input, ctx) => runStep(cond(input) ? ifStep : elseStep, input, ctx),
    };
    return new Workflow<I, NO>([...this.steps, composite]);
  }

  /** Run `run` for each item (journaled separately per item → completed ones are skipped on resume). */
  foreach<IT, OT>(
    itemsOf: IT[] | ((input: O) => IT[]),
    run: (item: IT, index: number, ctx: StepCtx) => Promise<OT>,
    id = 'foreach',
  ): Workflow<I, OT[]> {
    const composite: Step<O, OT[]> = {
      id,
      run: async (input, ctx) => {
        const list = typeof itemsOf === 'function' ? (itemsOf as (i: O) => IT[])(input) : itemsOf;
        const out: OT[] = [];
        for (let i = 0; i < list.length; i++) {
          out.push(await runStep({ id: `${id}[${i}]`, run: (it, c) => run(it, i, c) }, list[i], ctx));
        }
        return out;
      },
    };
    return new Workflow<I, OT[]>([...this.steps, composite]);
  }

  /** Repeat `run` while `cond` is true (each round journaled separately). */
  loop(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    const id = opts.id ?? 'loop';
    const max = opts.maxIters ?? 100;
    const composite: Step<O, O> = {
      id,
      run: async (input, ctx) => {
        let cur = input;
        for (let iter = 0; iter < max; iter++) {
          cur = await runStep({ id: `${id}#${iter}`, run: (inp, c) => run(inp, iter, c) }, cur, ctx);
          if (!cond(cur, iter)) break;
        }
        return cur;
      },
    };
    return new Workflow<I, O>([...this.steps, composite]);
  }

  /** Common workflow-DSL `.dowhile` semantics: run `run` at least once, repeat while `cond` stays TRUE.
   *  Each round journaled separately (`dowhile#<iter>`) → completed rounds don't re-run on crash/resume. */
  dowhile(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, cond, { id: opts.id ?? 'dowhile', maxIters: opts.maxIters });
  }

  /** Common workflow-DSL `.dountil` semantics: run `run` at least once, repeat UNTIL `cond` becomes TRUE. */
  dountil(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, (o, i) => !cond(o, i), { id: opts.id ?? 'dountil', maxIters: opts.maxIters });
  }

  build(): Step[] {
    return this.steps;
  }

  /** Run the workflow durably. Calling again with the same runId = resume (completed steps don't re-run).
   *  Note: if it contains a suspending step (sleep/waitFor), use `runResumable` (run() throws the suspend). */
  async run(input: I, ctx: StepCtx): Promise<O> {
    let cur: any = input;
    for (const s of this.steps) cur = await runStep(s, cur, ctx);
    return cur as O;
  }

  /**
   * Suspend-aware execution: if a step suspends via `suspendWorkflow` (sleep/waitFor/waitForResume),
   * it writes to the journal and returns `{status:'suspended'}`. Calling again with the same runId =
   * resume → completed steps replay, the suspended step is re-evaluated (continues if the event
   * arrived / time elapsed / a resume payload was delivered). Evented + scheduled.
   *
   * Step-through debug: if `opts.maxSteps` is given, only the FIRST maxSteps steps (position-based)
   * run; if a step remains, it returns `{status:'paused', stepId}`. To continue, call again with the
   * same runId and maxSteps+1: earlier steps REPLAY from the journal (don't re-run), only the next
   * step actually runs.
   *
   * P0.4 additions:
   * - `opts.resume` — typed resume payloads: `{ [waitId]: payload }` is journaled BEFORE any step
   *   runs, then read by the suspended step via `ctx.resumeData(waitId)` / `waitForResume`. This is
   *   the "resume step X with THIS approver decision" HITL primitive: the payload travels through the
   *   journal, so a crash between delivery and consumption loses nothing, and replay is deterministic.
   * - `opts.signal` — in-process cancellation: checked between steps (and exposed as `ctx.signal` for
   *   steps to observe); an abort marks the run canceled DURABLY (see below).
   * - Durable cancel: `cancelWorkflowRun()` writes a `_canceled` journal flag — checked here BEFORE
   *   EVERY step, so cancellation reaches runs on OTHER workers at their next step boundary, and a
   *   canceled run REFUSES to resume forever after (same terminal-refusal principle as
   *   @gnl/durable's compensated runs). Cancel never deletes journal state — completed steps stay
   *   replayable/inspectable; the run just stops producing new work.
   * - Status registry: every terminal/suspend transition is mirrored to a top-level `wfrun:<runId>`
   *   record → `listWorkflowRuns` answers "which runs are suspended right now, on which step,
   *   waiting for which waitId" in ONE prefix scan.
   */
  async runResumable(
    input: I,
    ctx: StepCtx,
    opts: {
      maxSteps?: number;
      resume?: Record<string, unknown>;
      signal?: AbortSignal;
      /**
       * FLOW-08: the workflow's registered name, mirrored into the `wfrun:` status record (see
       * `putStatus`) so `listWorkflowRuns`/the studio run list can display it without the caller
       * re-deriving it from the runId. Purely additive — the `Workflow` class itself still doesn't
       * carry a name (its constructor stays name-less); callers that know the name (e.g.
       * @gnl/durable's `runWorkflow`, which registers workflows by name) pass it here. Omitted =
       * today's behavior exactly (no field written to the record).
       */
      workflowName?: string;
    } = {},
  ): Promise<WorkflowResult<O>> {
    const limit = opts.maxSteps ?? Infinity;
    const journal = ctx.journal;
    // Deliver typed resume payloads FIRST (plain put — before consumption an operator may overwrite a
    // wrong payload with a corrected one; after consumption the step's journaled output wins anyway).
    for (const [waitId, payload] of Object.entries(opts.resume ?? {})) {
      await journal.put(resumeKey(ctx.runId, waitId), payload);
    }
    // Engine-injected ctx capabilities (spread-safe: asStep's `{...ctx, keyPrefix}` propagates them).
    const ctx2: StepCtx = {
      ...ctx,
      ...(opts.signal ? { signal: opts.signal } : {}),
      resumeData: <T,>(waitId: string) => journal.get<T>(resumeKey(ctx.runId, waitId)),
    };
    let cur: any = input;
    for (let i = 0; i < this.steps.length; i++) {
      // P0.4 cancel — checked at EVERY step boundary: the durable flag (cross-process; one cheap point
      // read per step) and the in-process signal. Order matters: the flag wins even if the signal is
      // quiet (another worker/operator canceled), and an in-process abort is made durable immediately.
      const flag = await journal.get<{ reason?: unknown }>(canceledKey(ctx.runId));
      if (flag !== undefined || opts.signal?.aborted) {
        if (flag === undefined) await journal.put(canceledKey(ctx.runId), { at: Date.now(), reason: 'signal' });
        const reason = flag?.reason ?? 'signal';
        await this.putStatus(journal, ctx.runId, { status: 'canceled', stepId: this.steps[i]!.id, reason }, opts.workflowName);
        return { status: 'canceled', stepId: this.steps[i]!.id, reason };
      }
      if (i >= limit) return { status: 'paused', stepId: this.steps[i]!.id, partial: cur };
      const s = this.steps[i]!;
      try {
        cur = await runStep(s, cur, ctx2);
      } catch (e) {
        if (e instanceof WorkflowSuspended) {
          await journal.put(`${ctx.runId}:wf:_suspend`, { stepId: s.id, waitId: e.waitId, reason: e.reason });
          await this.putStatus(journal, ctx.runId, { status: 'suspended', stepId: s.id, waitId: e.waitId, reason: e.reason }, opts.workflowName);
          return { status: 'suspended', stepId: s.id, waitId: e.waitId, reason: e.reason };
        }
        throw e;
      }
    }
    await this.putStatus(journal, ctx.runId, { status: 'completed' }, opts.workflowName);
    return { status: 'completed', output: cur as O };
  }

  /** Status-registry mirror — best-effort (a registry write failure must not fail the run itself).
   *  FLOW-08: `workflowName` (from `runResumable`'s opts) is mirrored in ONLY when the caller passed
   *  one — omitted entirely otherwise, so a `wfrun:` record written without a name is byte-for-byte
   *  identical to pre-FLOW-08 records (backward compatible with readers of the old shape). */
  private async putStatus(
    journal: JournalLike,
    runId: string,
    s: Omit<WorkflowRunStatus, 'runId' | 'updatedAt' | 'workflowName'>,
    workflowName?: string,
  ): Promise<void> {
    try {
      await journal.put(statusKey(runId), {
        ...s,
        runId,
        ...(workflowName !== undefined ? { workflowName } : {}),
        updatedAt: Date.now(),
      } satisfies WorkflowRunStatus);
    } catch { /* advisory registry — the WorkflowResult return value is the source of truth */ }
  }
}

export type WorkflowResult<O = any> =
  | { status: 'completed'; output: O }
  | { status: 'suspended'; stepId: string; waitId?: string; reason?: unknown }
  /** Step-through: the maxSteps limit was reached — `stepId` is the NEXT (not yet run) step; `partial` is the output up to that point. */
  | { status: 'paused'; stepId: string; partial: unknown }
  /** P0.4: the run was canceled (durable `_canceled` flag or opts.signal) — `stepId` is the step that would have run next. Terminal: resuming returns `canceled` again. */
  | { status: 'canceled'; stepId?: string; reason?: unknown };

/** Signal that lets a step suspend the workflow (thrown by sleep/waitFor). */
export class WorkflowSuspended extends Error {
  constructor(public readonly waitId: string, public readonly reason?: unknown) {
    super(`workflow suspended: ${waitId}`);
    this.name = 'WorkflowSuspended';
  }
}

/** Suspend the workflow from a running step. Caught by `runResumable`; the step is retried on resume. */
export function suspendWorkflow(waitId: string, reason?: unknown): never {
  throw new WorkflowSuspended(waitId, reason);
}

/** Durable step that waits until a specific time (scheduled). Suspends if the time hasn't elapsed yet. */
export function sleep(id: string, untilMs: number): Step {
  return {
    id,
    run: async () => {
      if (Date.now() < untilMs) suspendWorkflow(id, { kind: 'time', untilMs });
      return { sleptUntil: untilMs };
    },
  };
}

/**
 * P0.4 — typed HITL resume: a durable step that suspends until a resume payload for `id` (its waitId)
 * is delivered via `runResumable(input, ctx, { resume: { [id]: payload } })`, then returns that
 * payload as the step's output. THE "resume step X with THIS approver decision" primitive.
 *
 * `validate` (optional): parses/narrows the raw payload — pass e.g. a zod schema's `.parse` (the
 * package stays zero-dependency; any `(v: unknown) => T` works). A validation THROW fails the run
 * WITHOUT consuming anything: the payload stays in the journal, the step has no journaled output, so
 * the operator can overwrite it with a corrected payload (`resume` again) and re-resume.
 *
 * Determinism: the payload is read from the journal, and once this step completes its OUTPUT is
 * journaled — replay never re-reads (or re-validates) the payload.
 */
export function waitForResume<T = unknown>(
  id: string,
  opts: { validate?: (v: unknown) => T; reason?: unknown } = {},
): Step<any, T> {
  return {
    id,
    run: async (_input, ctx) => {
      const v = ctx.resumeData ? await ctx.resumeData(id) : undefined;
      if (v === undefined) suspendWorkflow(id, opts.reason ?? { kind: 'resume' });
      return opts.validate ? opts.validate(v) : (v as T);
    },
  };
}

// ── P0.4 — durable cancel + suspended-run registry ─────────────────────────────

/** One workflow run's registry record (the top-level `wfrun:<runId>` key — see `statusKey`'s JSDoc). */
export interface WorkflowRunStatus {
  runId: string;
  status: 'suspended' | 'completed' | 'canceled';
  /** Suspended: the step waiting. Canceled: the step that would have run next. */
  stepId?: string;
  /** Suspended: the waitId to address in `runResumable({ resume: { [waitId]: … } })`. */
  waitId?: string;
  reason?: unknown;
  /** FLOW-08: the workflow's registered name (from `runResumable`'s opts), when the caller provided
   *  one. Absent on records written before FLOW-08 or when the caller didn't pass a name. */
  workflowName?: string;
  updatedAt: number;
}

/**
 * Durably cancels a workflow run: writes the `_canceled` flag (checked by `runResumable` before EVERY
 * step — reaches runs in-flight on OTHER workers at their next step boundary) and mirrors the registry
 * record. Terminal: a canceled run refuses to resume forever after (same principle as @gnl/durable's
 * compensated-run refusal). Never deletes journal state — completed steps stay replayable/inspectable.
 * Returns `false` (no-op) if the run had already COMPLETED (nothing left to cancel); `true` otherwise
 * (idempotent — canceling an already-canceled run is `true` again).
 */
export async function cancelWorkflowRun(
  journal: JournalLike,
  runId: string,
  opts: { reason?: unknown } = {},
): Promise<boolean> {
  const st = await journal.get<WorkflowRunStatus>(statusKey(runId));
  if (st?.status === 'completed') return false;
  await journal.put(canceledKey(runId), { at: Date.now(), ...(opts.reason !== undefined ? { reason: opts.reason } : {}) });
  await journal.put(statusKey(runId), {
    runId,
    status: 'canceled',
    ...(st?.stepId ? { stepId: st.stepId } : {}),
    // FLOW-08: carry the name forward from the existing record (same pattern as stepId above) —
    // an external cancelWorkflowRun() call doesn't know the name itself, only runResumable does.
    ...(st?.workflowName ? { workflowName: st.workflowName } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    updatedAt: Date.now(),
  } satisfies WorkflowRunStatus);
  return true;
}

/** Reads one run's registry record (undefined: the run never wrote one — pre-P0.4, or still mid-flight without a suspend). */
export async function getWorkflowRunStatus(journal: JournalLike, runId: string): Promise<WorkflowRunStatus | undefined> {
  return journal.get<WorkflowRunStatus>(statusKey(runId));
}

/**
 * The suspended-run registry query: every workflow run's registry record in ONE `wfrun:` prefix scan,
 * optionally filtered by status — answers "which runs are suspended right now, on which step, waiting
 * for which waitId" without touching any run's journal. Requires `listKeys` (throws a clear error
 * otherwise — no silent empty answer that would read as "nothing suspended").
 */
export async function listWorkflowRuns(
  journal: JournalLike,
  opts: { status?: WorkflowRunStatus['status'] } = {},
): Promise<WorkflowRunStatus[]> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error("@gnl/workflow: listWorkflowRuns requires the journal to implement `listKeys` (see JournalLike) — without it the registry cannot be enumerated.");
  }
  const keys = await journal.listKeys(WFRUN_PRE);
  const out: WorkflowRunStatus[] = [];
  for (const k of keys) {
    const st = await journal.get<WorkflowRunStatus>(k);
    if (st && (!opts.status || st.status === opts.status)) out.push(st);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Durable step that waits until a condition (event) is satisfied. If `check` returns a value, that
 * becomes the step's output; if null/undefined, it suspends. `check` typically hooks into @gnl/events
 * (e.g. searching for an event via listLog).
 */
export function waitFor<O = any>(
  id: string,
  check: (input: any, ctx: StepCtx) => Promise<O | null | undefined> | O | null | undefined,
): Step<any, O> {
  return {
    id,
    run: async (input, ctx) => {
      const v = await check(input, ctx);
      if (v == null) suspendWorkflow(id, { kind: 'event' });
      return v as O;
    },
  };
}

// ── Declarative retry-policy ("try N times → fallback") — common workflow retry-config semantics ──────────────

export interface RetryPolicy<I = any, O = any> {
  /** Total attempt count (including the first run, >=1). */
  attempts: number;
  /** Wait between attempts: a fixed ms value or a function computed from the attempt index (1-based). */
  backoffMs?: number | ((attempt: number) => number);
  /** Step to run when all attempts are exhausted (journaled under its own key). If omitted, throws RetryExhaustedError. */
  fallback?: Step<I, O>;
}

/** All attempts exhausted with no fallback — the last error is in `cause`. */
export class RetryExhaustedError extends Error {
  constructor(
    readonly stepId: string,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(`@gnl/workflow: '${stepId}' failed after ${attempts} attempts.`);
    this.name = 'RetryExhaustedError';
  }
}

// ── Retry counter read/write ──
// If the journal supports an atomic counter (incrBy + getCounters), use it: closes get→put's
// lost-update race (two workers can't read the same value and overwrite each other; increments
// accumulate). If not supported, falls back to the existing plain-value get→put path (single-process
// safe, behavior unchanged). Backward compatibility: older runs may have a counter written via plain
// `put` → the LARGER of the two sources is taken (the attempt count never rewinds).
const ATTEMPTS_FIELD = 'n';

async function readAttempts(journal: JournalLike, key: string): Promise<number> {
  const legacy = (await journal.get<number>(key)) ?? 0;
  if (journal.incrBy && journal.getCounters) {
    const c = await journal.getCounters(key);
    return Math.max(c?.[ATTEMPTS_FIELD] ?? 0, legacy);
  }
  return legacy;
}

async function bumpAttempts(journal: JournalLike, key: string, used: number): Promise<void> {
  if (journal.incrBy && journal.getCounters) {
    const counters = await journal.getCounters(key);
    if (counters?.[ATTEMPTS_FIELD] === undefined) {
      // First incrBy transition: the counter has never been initialized. At this point `used`
      // already includes legacy (if any) — readAttempts read Math.max(counter=0, legacy) at the
      // start of the call, and used has only grown by +1's since then — so seed the counter
      // DIRECTLY to `used` (one-time). That way subsequent resumes' Math.max(counter, legacy)
      // always yields the true total (counter now sits above legacy, even if legacy stays frozen).
      // The legacy FIELD itself is never written to — the "plain field untouched on the incrBy
      // path" contract (cas.test.ts) is preserved.
      await journal.incrBy(key, { [ATTEMPTS_FIELD]: used });
    } else {
      await journal.incrBy(key, { [ATTEMPTS_FIELD]: 1 });
    }
  } else {
    await journal.put(key, used);
  }
}

/**
 * Wraps a step with a retry-policy — drop-in: carries the same `id`, used everywhere in
 * `then/branch/parallel` just like an unwrapped step; a SUCCESSFUL output is still journaled
 * under the step's own key.
 *
 * Determinism/durable notes:
 * - **The attempt counter lives in the journal** (`<runId>:wf:<id>:attempts`) → doesn't start over
 *   on crash-resume; the "total N attempts" guarantee is kept independent of process deaths. A step
 *   that was already exhausted in a previous run goes straight to the fallback (if any) on resume —
 *   it does NOT retry N more times.
 * - **Suspension (WorkflowSuspended) is not an error** — it propagates outward as-is without consuming
 *   an attempt (sleep/waitFor work correctly inside retry too).
 * - **The fallback is journaled separately** (`runStep(policy.fallback)`): if the fallback runs and
 *   then crashes, it does NOT re-run on resume. The step being retried must be idempotent if it has
 *   side effects, or use a durable tool internally (the INSIDE of an attempt is not journaled — only
 *   the counter and the final output are).
 */
export function retry<I = any, O = any>(s: Step<I, O>, policy: RetryPolicy<I, O>): Step<I, O> {
  if (!(policy.attempts >= 1)) throw new Error(`@gnl/workflow: retry('${s.id}') requires attempts >= 1`);
  return {
    id: s.id,
    run: async (input, ctx) => {
      const attemptsKey = `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}:attempts`;
      let used = await readAttempts(ctx.journal, attemptsKey); // resume: consumed attempts are counted
      let lastErr: unknown;
      while (used < policy.attempts) {
        try {
          return await s.run(input, ctx);
        } catch (e) {
          if (e instanceof WorkflowSuspended) throw e; // suspension does NOT consume an attempt
          lastErr = e;
          used += 1;
          await bumpAttempts(ctx.journal, attemptsKey, used);
          if (used < policy.attempts && policy.backoffMs != null) {
            const ms = typeof policy.backoffMs === 'function' ? policy.backoffMs(used) : policy.backoffMs;
            if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          }
        }
      }
      if (policy.fallback) return (await runStep(policy.fallback, input, ctx)) as O;
      throw new RetryExhaustedError(s.id, policy.attempts, lastErr);
    },
  };
}

/** Start an empty workflow builder. */
export function workflow<I = any>(): Workflow<I, I> {
  return new Workflow<I, I>([]);
}

/**
 * Use a workflow as a NESTED step inside another workflow. Inner steps are namespaced via `keyPrefix`
 * (`${id}:`) → outer/inner steps with the same id don't collide. An inner suspend (sleep/waitFor)
 * propagates outward: the outer `runResumable` catches it, and on resume inner steps replay from
 * their prefixed keys.
 *   outer.then(asStep('payment', paymentWf))   // inner: ${runId}:wf:payment:checkFunds ...
 */
export function asStep<I = any, O = any>(id: string, wf: Workflow<I, O>): Step<I, O> {
  return {
    id,
    run: (input, ctx) => wf.run(input as I, { ...ctx, keyPrefix: `${ctx.keyPrefix ?? ''}${id}:` }),
  };
}
