// Durable deterministic workflow: each step's output is journaled with (runId, stepId).
// On crash→resume, COMPLETED steps do NOT run again (exactly-once); resumes from where it left off.
// Structurally compatible with @gnldev/durable's Journal (JournalLike) — zero dependency for the package.

export interface JournalLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /**
   * Optional (CAS): writes and returns `true` when the key is ABSENT, returns `false` without
   * Touching anything if it exists. Prevents the same step from running twice in multi-worker
   * Setups (structurally compatible with @gnldev/durable Journal.putIfAbsent). If undefined, falls
   * Back to get+put (single-process safe, behavior unchanged).
   */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
  /**
   * Optional: field-based ATOMIC counter increment (structurally compatible with @gnldev/durable
   * Journal.incrBy). Saves the retry counter from get→put's lost-update race. If undefined,
   * Falls back to the existing path.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<void>;
  /** Optional: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P0.4 (optional): keys starting with a prefix — structurally compatible with @gnldev/durable
   * Journal.listKeys. Only `listWorkflowRuns` (the suspended-run registry query) needs it; every
   * Engine path works without it.
   */
  listKeys?(prefix: string): Promise<string[]>;
  /**
   * Optional (CAS): conditional replace — writes `value` and returns `true` ONLY if the current
   * Record equals `expected` (serialized equality); `false` without touching anything otherwise.
   * Structurally compatible with @gnldev/durable Journal.putIfMatch. Used by the side-effect claim
   * Takeover (a stale claim is adopted atomically — two resuming workers can't both run the step).
   * If undefined, falls back to best-effort get→put (single-process safe, documented risk).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * Optional: the STORAGE's own clock (ms epoch) — structurally compatible with @gnldev/durable
   * Journal.now. Claim-staleness decisions use it when present, so wall-clock skew between workers
   * Cannot disrupt takeover timing (same posture as run-lock's H2).
   */
  now?(): Promise<number>;
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
   * Completes, its output is journaled and the payload is never re-read on replay.
   * NOTE: `waitId`s share ONE per-run namespace (deliberately NOT keyPrefix-scoped — the operator
   * Resuming a run addresses a waitId without knowing which nested workflow hosts it); keep them
   * Unique across nested workflows the same way you already must for `_suspend`.
   */
  resumeData?<T = unknown>(waitId: string): Promise<T | undefined>;
  /**
   * This step's own journal key (`<runId>:wf:<keyPrefix><stepId>`) — ENGINE-INJECTED by `runStep`
   * Before every step run, so inside a step's `run()` it is always present (optional only because
   * The ctx object callers construct doesn't carry it). Single source of truth with the record key.
   * Carry it to external APIs (e.g. as a Stripe-style Idempotency-Key header) and the journal's
   * Exactly-once extends into the downstream system: a crash-window duplicate then dedupes THERE too.
   */
  idempotencyKey?: string;
  /** FAZ-8 (critical preset'in runtime ağı): true iken, `sideEffect: true` beyan edip `recover`
   *  Taşımayan bir adım claim'inden ÖNCE reddedilir — build()'in göremediği kombinatör kolları ve
   *  Nested çocuklar dahil her yolda. Registry critical'de kurar; elle kullanılabilir. */
  strictSideEffects?: boolean;
}

// ── P0.4 key builders (single source of truth for the new key shapes) ──────────
/** Resume payload for a waitId (per-run namespace, NOT keyPrefix-scoped — see StepCtx.resumeData). */
const resumeKey = (runId: string, waitId: string) => `${runId}:wf:_resume:${waitId}`;
/** Durable cancel flag — once written, NO worker will run further steps of this run (cross-process). */
const canceledKey = (runId: string) => `${runId}:wf:_canceled`;

/**
 * Where a retry records that a step's output came from its fallback rather than from the step.
 *
 * The `_` is the reserved-control-key convention (`_suspend`, `_resume:*`, `_canceled`) and it is
 * Load-bearing here rather than cosmetic. A nested workflow's steps live at
 * `<runId>:wf:<outerId>:<innerId>`, so a plain `:fallback` suffix is ALSO the key of an inner step
 * Literally named `fallback` — measured, its output was then read back as a substitution marker, and
 * A step that never failed reported that it had. That is worse than the ambiguity this marker exists
 * To remove: it does not fail to say, it says the wrong thing.
 *
 * The prefix also puts the key inside `forkWorkflowRun`'s existing `:_` skip, which is what a fork
 * Needs: the marker describes a specific output and must not outlive it (see the explicit copy there).
 */
const FALLBACK_MARKER_BRAND = '__gnlFallback' as const;
const fallbackMarkerKey = (runId: string, keyPrefix: string | undefined, stepId: string) =>
  `${runId}:wf:${keyPrefix ?? ''}${stepId}:_fallback`;
/**
 * Top-level status registry key. Deliberately NOT under `<runId>:` — a `wfrun:` prefix scan
 * (`listKeys('wfrun:')`) enumerates every workflow run in ONE query, which a runId-prefixed key
 * Cannot offer (no suffix scans). Same pattern precedent as @gnldev/durable's `xrun:` cross-run keys:
 * Invisible to parseJournalKey (not part of any single run's timeline) and org-prefixed automatically
 * By `withOrg` (it prefixes ALL keys unconditionally) → organization isolation is preserved.
 * Cleanup note (same as xrun:): a `<runId>:*` prefix delete does NOT touch this key — @gnldev/durable's
 * `purgeRun` deletes it for the run it purges (and for the nested workflow children it cascades into),
 * neighbor-safely; anything sweeping the journal itself must handle it.
 * Purge explicitly via `deletePrefix('wfrun:')` (all) — but BEWARE the per-run form:
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
  /** FAZ-1 (optional): side-effect durability contract — see `StepDurability` and `step()`'s 3rd arg. */
  durability?: StepDurability<I, O>;
}

/**
 * FAZ-1 — durability contract for a step whose body fires a NON-IDEMPOTENT external effect (an HTTP
 * POST, a charge, an email). Without it, the engine journals the step AFTER it runs — a crash between
 * The effect and the journal write leaves no record, and the resume re-fires the effect (the classic
 * Crash-window duplicate). With `sideEffect: true` the engine writes a WRITE-AHEAD CLAIM
 * (`<stepKey>:_claim`) before executing, so a resume can TELL "never started" from "died mid-flight":
 *   Claim absent            → never started, run normally.
 *   Output present          → completed, replay (unchanged).
 *   Claim live (< ttl)      → another worker / a very recent attempt is in flight → StepRetryBlockedError.
 *   Claim stale or `failed` → THE CRASH WINDOW: the effect may or may not have fired. `recover` is
 *     Asked first ("check the external system — did it land?"); without `recover`, the engine refuses
 *     To guess (StepRetryBlockedError with state 'unresolved') instead of silently double-firing.
 * A step WITHOUT `sideEffect` keeps today's path byte-for-byte (no claim key is ever written).
 */
export interface StepDurability<I = any, O = any> {
  /** Declare the step's body non-idempotent → the write-ahead claim protocol above activates. */
  sideEffect?: boolean;
  /**
   * Crash-window resolver: consult the EXTERNAL system ("does a payment with this idempotencyKey
   * exist?") and report. `{done: true, output}` → the effect landed; `output` is journaled as the
   * Step's record and the body is NOT re-run. `{done: false}` → the effect never landed; the claim is
   * Taken over (CAS) and the body runs for real. Any other shape is rejected loudly (same shape
   * Discipline as @gnldev/durable's recover — a malformed recovery must not masquerade as an output).
   */
  recover?(input: I, opts: { idempotencyKey: string }): Promise<{ done: true; output: O } | { done: false }>;
  /**
   * How long a claim with no output record is presumed IN-FLIGHT before a resume treats it as a
   * Crash (default 60s). Calibrate ABOVE the step's real worst-case duration: a too-short TTL lets a
   * Resume adopt a step that is still running on another worker (double side effect — the exact thing
   * This exists to prevent); a too-long one only delays recovery after a genuine crash.
   */
  claimTtlMs?: number;
}

const DEFAULT_CLAIM_TTL_MS = 60_000;

/** The write-ahead claim record (at `<stepKey>:_claim` — inside the `:_` control-key namespace). */
interface StepClaimRecord {
  startedAt: number;
  /** The attempt ended in a CLEAN suspend (WorkflowSuspended) — re-running on resume is the step's documented contract. */
  released?: true;
  /** The attempt THREW — the effect is uncertain, but we know it's not in flight → resume skips the TTL wait and goes straight to recover/blocked. */
  failed?: true;
}

/**
 * FAZ-1 — a side-effect step's resume was refused. Two states:
 * 'in-flight': a live claim exists (another worker, or an attempt younger than claimTtlMs) — retry
 *   After the TTL; the block clears on its own.
 * 'unresolved': the previous attempt died inside the crash window (stale claim / stamped `failed`)
 *   And the step has no `recover` — the engine will not guess whether the effect fired. Provide
 *   `recover()` on the step, or resolve manually after checking the external system:
 *   · effect LANDED   → `journal.put(detail.key, <the real output>)` — the resume replays it.
 *   · effect NOT fired → `journal.put(`${detail.key}:_claim`, { startedAt: Date.now(), released: true })`
 *     — the resume adopts the claim and re-runs the step.
 */
export class StepRetryBlockedError extends Error {
  constructor(
    stepId: string,
    public readonly detail: { key: string; state: 'in-flight' | 'unresolved'; ageMs?: number; claimTtlMs?: number },
  ) {
    super(
      detail.state === 'in-flight'
        ? `@gnldev/workflow: step '${stepId}' has a live side-effect claim (age ${detail.ageMs ?? '?'}ms < ttl ${detail.claimTtlMs ?? '?'}ms) — another worker may be running it; retry after the TTL.`
        : `@gnldev/workflow: step '${stepId}' died inside the side-effect crash window — the effect may have fired. Provide 'recover()' on the step, or verify the external system and write '${detail.key}' manually.`,
    );
    this.name = 'StepRetryBlockedError';
  }
}

export function step<I = any, O = any>(
  id: string,
  run: (input: I, ctx: StepCtx) => Promise<O>,
  opts?: StepDurability<I, O>,
): Step<I, O> {
  return opts ? { id, run, durability: opts } : { id, run };
}

// Atomic claim — identical contract to `claim` in @gnldev/durable (packages/durable/src/journal.ts;
// Kept as a local copy since the package stays zero-dependency): CAS if putIfAbsent exists, else
// Get+put fallback (single-process safe). Returns `true` if this call created the key.
async function claim(journal: JournalLike, key: string, value: unknown): Promise<boolean> {
  if (journal.putIfAbsent) return journal.putIfAbsent(key, value);
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, value);
  return true;
}

// Runs a step exactly-once: if a record exists, returns it (replay); otherwise runs it and records
// It via CAS — the loser of the race DISCARDS its own result and returns the winner's record (single
// Source of truth in multi-worker setups). This is @gnldev/durable's `frozenGet` adapted to workflow;
// The ONLY difference is the record shape: existing workflow records are plain values WITHOUT a `{ v }`
// Wrapper, kept this way for backward compatibility (using frozenGet would make old records unreadable).
// The plain shape's known limitation still holds: an `undefined` output cannot be distinguished from
// "no record" (that step re-runs on replay) — behavior unchanged.
async function runStep(s: Step, input: any, ctx: StepCtx): Promise<any> {
  const key = `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}`;
  const cached = await ctx.journal.get(key);
  if (cached !== undefined) return cached;
  // FAZ-1: the step's journal key doubles as its idempotencyKey — single source of truth, injected
  // Into ctx so the step body can hand it to external APIs (see StepCtx.idempotencyKey).
  const ctx2: StepCtx = { ...ctx, idempotencyKey: key };
  if (s.durability?.sideEffect) return runSideEffectStep(s, s.durability, input, ctx2, key);
  const out = await s.run(input, ctx2);
  if (await claim(ctx.journal, key, out)) return out;
  // Race lost: the winner's record is the single source of truth. If the winner wrote `undefined`
  // (indistinguishable in the plain shape) we fall back to our own output — both results are products
  // Of the same step anyway.
  const winner = await ctx.journal.get(key);
  return winner === undefined ? out : winner;
}

/** The storage's clock when it has one (multi-worker skew safety — run-lock's H2 posture), else local. */
async function clockOf(journal: JournalLike): Promise<number> {
  return journal.now ? journal.now() : Date.now();
}

/** Adopt an existing claim atomically. CAS operand is the RAW record we read (durable-tool's war
 * Story: hashing/reshaping the operand makes the CAS compare a record that was never stored). A lost
 * CAS means another resume adopted it first → blocked, the winner runs. Fallback without putIfMatch
 * Is best-effort put (single-process safe — same posture as `claim` above). */
async function adoptClaim(
  journal: JournalLike,
  claimKey: string,
  cur: StepClaimRecord,
  next: StepClaimRecord,
  stepId: string,
  key: string,
  info?: { ageMs?: number; claimTtlMs?: number },
): Promise<void> {
  if (journal.putIfMatch) {
    if (!(await journal.putIfMatch(claimKey, cur, next))) {
      throw new StepRetryBlockedError(stepId, { key, state: 'in-flight', ...info });
    }
    return;
  }
  await journal.put(claimKey, next);
}

function assertRecoverShape(r: unknown, stepId: string): asserts r is { done: true; output: unknown } | { done: false } {
  const v = r as { done?: unknown } | null | undefined;
  const ok = !!v && typeof v === 'object' && (v.done === true ? 'output' in v : v.done === false);
  if (!ok) {
    throw new Error(
      `@gnldev/workflow: recover('${stepId}') must return {done:true, output} or {done:false} — got ${JSON.stringify(r)?.slice(0, 120)}. A malformed recovery must not masquerade as a step output.`,
    );
  }
}

// FAZ-1 — the side-effect path: write-ahead claim BEFORE execute, so the effect can never fire
// Without a trace. Protocol details on StepDurability's JSDoc. Ordering is the whole point: the old
// Get→run→claim sequence journaled the step only AFTER its body ran, so the CAS chose which OUTPUT
// Survived but never prevented a duplicate EFFECT.
async function runSideEffectStep(
  s: Step,
  d: StepDurability,
  input: any,
  ctx: StepCtx,
  key: string,
): Promise<any> {
  const journal = ctx.journal;
  if (ctx.strictSideEffects && typeof d.recover !== 'function') {
    // The critical preset's runtime net (K6): build()-time scanning cannot see a parallel leg's or a
    // Nested child's declaration — this point CAN, because every path funnels through runStep.
    throw new Error(
      `@gnldev/workflow: strictSideEffects — step '${s.id}' declares sideEffect without recover(); the crash window must be answered (give recover(), or run without the critical policy).`,
    );
  }
  const claimKey = `${key}:_claim`; // `:_` control-key namespace → skipped by fork's sweep (a fork gets a fresh claim budget)
  const ttl = d.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;

  let mine: StepClaimRecord = { startedAt: await clockOf(journal) };
  if (!(await claim(journal, claimKey, mine))) {
    // A claim already exists: crash-resume, a clean suspend, or a concurrent worker.
    const done = await journal.get(key);
    if (done !== undefined) return done; // completed between the cache check and here
    const cur = await journal.get<StepClaimRecord>(claimKey); // RAW record — the CAS operand
    const at = await clockOf(journal);
    if (!cur) {
      // The claim was lost but the record can't be read either (raced with a purge) → one more atomic try.
      mine = { startedAt: at };
      if (!(await claim(journal, claimKey, mine))) {
        throw new StepRetryBlockedError(s.id, { key, state: 'in-flight' });
      }
    } else if (cur.released) {
      // A clean suspend: re-running on resume is the step's documented contract (suspendWorkflow) — adopt and run.
      mine = { startedAt: at };
      await adoptClaim(journal, claimKey, cur, mine, s.id, key, { ageMs: at - cur.startedAt, claimTtlMs: ttl });
      const landed = await journal.get(key);
      if (landed !== undefined) return landed; // a sibling completed between our reads — replay, don't re-fire
    } else if (!cur.failed && at - cur.startedAt < ttl) {
      throw new StepRetryBlockedError(s.id, { key, state: 'in-flight', ageMs: at - cur.startedAt, claimTtlMs: ttl });
    } else {
      // THE CRASH WINDOW: a stale claim (process death) or a stamped `failed` attempt — the effect
      // May or may not have fired. Ask the external system first; never guess.
      if (!d.recover) {
        throw new StepRetryBlockedError(s.id, { key, state: 'unresolved', ageMs: at - cur.startedAt, claimTtlMs: ttl });
      }
      const r = await d.recover(input, { idempotencyKey: key });
      assertRecoverShape(r, s.id);
      if (r.done) {
        if (await claim(journal, key, r.output)) return r.output;
        const winner = await journal.get(key);
        return winner === undefined ? r.output : winner;
      }
      // The effect never landed → adopt the claim (atomically — two resumes must not both re-run) and execute.
      mine = { startedAt: at };
      await adoptClaim(journal, claimKey, cur, mine, s.id, key, { ageMs: at - cur.startedAt, claimTtlMs: ttl });
      // A sibling resume's recover({done:true}) writes the OUTPUT without touching the claim — one
      // Last point-read closes that window before re-firing (heyet: Deniz'in çift-recover senaryosu).
      const landed = await journal.get(key);
      if (landed !== undefined) return landed;
    }
  }
  try {
    const out = await s.run(input, ctx);
    if (await claim(journal, key, out)) return out;
    const winner = await journal.get(key);
    return winner === undefined ? out : winner;
  } catch (e) {
    // Stamp what we KNOW onto the claim so the resume needn't wait out the TTL: a clean suspend is
    // Safe to re-run; a throw means "not in flight, effect uncertain". Best-effort CAS against OUR
    // Record — a takeover in between wins, and a stamp failure must never mask the step's own error.
    const stamp: StepClaimRecord =
      e instanceof WorkflowSuspended ? { ...mine, released: true } : { ...mine, failed: true };
    try {
      if (journal.putIfMatch) {
        await journal.putIfMatch(claimKey, mine, stamp);
      } else {
        // No CAS: narrow the window with a read-compare — never stamp over a claim that is no
        // Longer ours (a takeover adopted it while our attempt was still failing).
        const cur = await journal.get<StepClaimRecord>(claimKey);
        if (cur && cur.startedAt === mine.startedAt && !cur.released && !cur.failed) {
          await journal.put(claimKey, stamp);
        }
      }
    } catch {
      /* the step's own error wins */
    }
    throw e;
  }
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
    // Position-unique, like `.map` above. A default derived only from CONTENT collides with itself:
    // two `.parallel` over the same sub-steps produced one journal key, so the second never ran and
    // the workflow returned the first one's output — silently.
    const pid = id ?? `parallel#${this.steps.length}(${steps.map((s) => s.id).join('+')})`;
    const composite: Step<O, Record<string, any>> = {
      id: pid,
      run: async (input, ctx) => {
        const entries = await Promise.all(
          // Journal each leg under THIS parallel, for the same reason as branch above: the legs are
          // the caller's steps and may appear in more than one parallel. The returned record is still
          // keyed by the leg's own id, so the output shape does not change.
          // FAZ-1: carry the leg's durability — rebuilding the step as a bare {id, run} silently
          // Dropped the claim protocol for a leg the user EXPLICITLY marked sideEffect (heyet blokeri).
          steps.map(async (s) => [s.id, await runStep({ id: `${pid}/${s.id}`, run: s.run, ...(s.durability ? { durability: s.durability } : {}) }, input, ctx)] as const),
        );
        return Object.fromEntries(entries);
      },
    };
    return new Workflow<I, Record<string, any>>([...this.steps, composite]);
  }

  /** Conditional branch: cond(input) ? ifStep : elseStep. */
  branch<NO>(cond: (input: O) => boolean, ifStep: Step<O, NO>, elseStep: Step<O, NO>, id?: string): Workflow<I, NO> {
    const bid = id ?? `branch#${this.steps.length}(${ifStep.id}|${elseStep.id})`;
    const composite: Step<O, NO> = {
      id: bid,
      run: async (input, ctx) => {
        // Scope the chosen arm under this branch. The arms are the caller's own steps, so reusing one
        // step object in two branches would otherwise put both under its own id and replay the first.
        const arm = cond(input) ? ifStep : elseStep;
        // FAZ-1: same durability carry as parallel above — an arm marked sideEffect keeps its claim.
        return runStep({ id: `${bid}/${arm.id}`, run: arm.run, ...(arm.durability ? { durability: arm.durability } : {}) }, input, ctx);
      },
    };
    return new Workflow<I, NO>([...this.steps, composite]);
  }

  /** Run `run` for each item (journaled separately per item → completed ones are skipped on resume).
   * FAZ-1 note: the iteration body is a bare function — it has NO StepDurability surface, so a
   * Side-effecting body is NOT claim-protected here (a crash after the effect re-runs that index on
   * Resume). Need the claim protocol per item? Put the effect in a `step(..., {sideEffect:true})`
   * Inside a nested workflow via `asStep`, or make the body idempotent (carry ctx.idempotencyKey +
   * The index to the external call). Same applies to loop/dowhile/dountil below. */
  foreach<IT, OT>(
    itemsOf: IT[] | ((input: O) => IT[]),
    run: (item: IT, index: number, ctx: StepCtx) => Promise<OT>,
    id?: string,
  ): Workflow<I, OT[]> {
    const fid = id ?? `foreach#${this.steps.length}`;
    const composite: Step<O, OT[]> = {
      id: fid,
      run: async (input, ctx) => {
        const list = typeof itemsOf === 'function' ? (itemsOf as (i: O) => IT[])(input) : itemsOf;
        const out: OT[] = [];
        for (let i = 0; i < list.length; i++) {
          out.push(await runStep({ id: `${fid}[${i}]`, run: (it, c) => run(it, i, c) }, list[i], ctx));
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
    const id = opts.id ?? `loop#${this.steps.length}`;
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
   * Each round journaled separately (`dowhile#<iter>`) → completed rounds don't re-run on crash/resume. */
  dowhile(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, cond, { id: opts.id ?? `dowhile#${this.steps.length}`, maxIters: opts.maxIters });
  }

  /** Common workflow-DSL `.dountil` semantics: run `run` at least once, repeat UNTIL `cond` becomes TRUE. */
  dountil(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, (o, i) => !cond(o, i), { id: opts.id ?? `dountil#${this.steps.length}`, maxIters: opts.maxIters });
  }

  build(): Step[] {
    return this.steps;
  }

  /** Run the workflow durably. Calling again with the same runId = resume (completed steps don't re-run).
   * Note: if it contains a suspending step (sleep/waitFor), use `runResumable` (run() throws the suspend). */
  async run(input: I, ctx: StepCtx): Promise<O> {
    let cur: any = input;
    for (const s of this.steps) cur = await runStep(s, cur, ctx);
    return cur as O;
  }

  /**
   * Suspend-aware execution: if a step suspends via `suspendWorkflow` (sleep/waitFor/waitForResume),
   * It writes to the journal and returns `{status:'suspended'}`. Calling again with the same runId =
   * Resume → completed steps replay, the suspended step is re-evaluated (continues if the event
   * Arrived / time elapsed / a resume payload was delivered). Evented + scheduled.
   *
   * Step-through debug: if `opts.maxSteps` is given, only the FIRST maxSteps steps (position-based)
   * Run; if a step remains, it returns `{status:'paused', stepId}`. To continue, call again with the
   * Same runId and maxSteps+1: earlier steps REPLAY from the journal (don't re-run), only the next
   * Step actually runs.
   *
   * P0.4 additions:
   * `opts.resume` — typed resume payloads: `{ [waitId]: payload }` is journaled BEFORE any step
   *   Runs, then read by the suspended step via `ctx.resumeData(waitId)` / `waitForResume`. This is
   *   The "resume step X with THIS approver decision" HITL primitive: the payload travels through the
   *   Journal, so a crash between delivery and consumption loses nothing, and replay is deterministic.
   * `opts.signal` — in-process cancellation: checked between steps (and exposed as `ctx.signal` for
   *   Steps to observe); an abort marks the run canceled DURABLY (see below).
   * Durable cancel: `cancelWorkflowRun()` writes a `_canceled` journal flag — checked here BEFORE
   * EVERY step, so cancellation reaches runs on OTHER workers at their next step boundary, and a
   *   Canceled run REFUSES to resume forever after (same terminal-refusal principle as
   *   @gnldev/durable's compensated runs). Cancel never deletes journal state — completed steps stay
   *   Replayable/inspectable; the run just stops producing new work.
   * Status registry: every terminal/suspend transition is mirrored to a top-level `wfrun:<runId>`
   *   Record → `listWorkflowRuns` answers "which runs are suspended right now, on which step,
   *   Waiting for which waitId" in ONE prefix scan.
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
       * Re-deriving it from the runId. Purely additive — the `Workflow` class itself still doesn't
       * Carry a name (its constructor stays name-less); callers that know the name (e.g.
       * @gnldev/durable's `runWorkflow`, which registers workflows by name) pass it here. Omitted =
       * Today's behavior exactly (no field written to the record).
       */
      workflowName?: string;
    } = {},
  ): Promise<WorkflowResult<O>> {
    const limit = opts.maxSteps ?? Infinity;
    const journal = ctx.journal;
    // Deliver typed resume payloads FIRST (plain put — before consumption an operator may overwrite a
    // Wrong payload with a corrected one; after consumption the step's journaled output wins anyway).
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
      // Read per step) and the in-process signal. Order matters: the flag wins even if the signal is
      // Quiet (another worker/operator canceled), and an in-process abort is made durable immediately.
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
   * FLOW-08: `workflowName` (from `runResumable`'s opts) is mirrored in ONLY when the caller passed
   *  One — omitted entirely otherwise, so a `wfrun:` record written without a name is byte-for-byte
   *  Identical to pre-FLOW-08 records (backward compatible with readers of the old shape). */
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
 * Is delivered via `runResumable(input, ctx, { resume: { [id]: payload } })`, then returns that
 * Payload as the step's output. THE "resume step X with THIS approver decision" primitive.
 *
 * `validate` (optional): parses/narrows the raw payload — pass e.g. a zod schema's `.parse` (the
 * Package stays zero-dependency; any `(v: unknown) => T` works). A validation THROW fails the run
 * WITHOUT consuming anything: the payload stays in the journal, the step has no journaled output, so
 * The operator can overwrite it with a corrected payload (`resume` again) and re-resume.
 *
 * Determinism: the payload is read from the journal, and once this step completes its OUTPUT is
 * Journaled — replay never re-reads (or re-validates) the payload.
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
   *  One. Absent on records written before FLOW-08 or when the caller didn't pass a name. */
  workflowName?: string;
  updatedAt: number;
}

/**
 * Durably cancels a workflow run: writes the `_canceled` flag (checked by `runResumable` before EVERY
 * Step — reaches runs in-flight on OTHER workers at their next step boundary) and mirrors the registry
 * Record. Terminal: a canceled run refuses to resume forever after (same principle as @gnldev/durable's
 * Compensated-run refusal). Never deletes journal state — completed steps stay replayable/inspectable.
 * Returns `false` (no-op) if the run had already COMPLETED (nothing left to cancel); `true` otherwise
 * (idempotent — canceling an already-canceled run is `true` again).
 */
/**
 * Forks a workflow run at a step — the workflow twin of @gnldev/durable's `forkRun`.
 *
 * The substrate has carried this all along: every step's output already sits in the journal under
 * `<runId>:wf:<stepId>`, exactly-once. What was missing was only the wiring:
 * Copy the recorded outputs of every step BEFORE the fork point to a new runId, run the workflow
 * Under that id, and `runStep`'s cache check replays the prefix while everything from `fromStepId`
 * On executes for real.
 *
 * Honest bounds, stated rather than discovered:
 *  · order comes from `build()`, so the copied prefix is exact for sequential flows; nested
 *    Sub-workflow keys (`asStep`) are swept in when the journal has `listKeys`, best-effort
 *    Without it.
 *  · the ORIGINAL INPUT is not recorded by the engine, so the caller passes it again when running
 *    The fork. For a fork past step 0 it only feeds already-cached steps and is inert.
 *  · retry counters are deliberately NOT copied — a forked step deserves its full retry budget.
 *  · FAZ-1: `:_claim` records are NOT copied either (the `:_` sweep skip) — the fork gets a fresh
 *    Claim budget. Corollary the operator must own: forking AT a step whose source run is blocked
 *    'unresolved' (crash-window) side-steps that protection — the fork re-runs the step under a NEW
 *    IdempotencyKey, so the effect can fire a second time. Verify the external system first.
 */
export async function forkWorkflowRun(
  journal: JournalLike,
  wf: { build(): { id: string }[] },
  srcRunId: string,
  fromStepId: string,
  dstRunId: string,
): Promise<{ dstRunId: string; copiedSteps: string[] }> {
  const order = wf.build().map((s) => s.id);
  const at = order.indexOf(fromStepId);
  if (at < 0) {
    throw new Error(`forkWorkflowRun: step '${fromStepId}' is not in this workflow. Steps: ${order.join(' → ')}`);
  }
  // A destination that already has records would silently MERGE two histories — the reader of the
  // Forked run could no longer tell which parts came from where. Refused instead. Probed at the
  // STEP keys, not only the registry record: a plain `run()` journals its steps without writing a
  // `wfrun:` record, and the registry-only check sailed straight past exactly that case in test.
  if ((await journal.get(statusKey(dstRunId))) !== undefined) {
    throw new Error(`forkWorkflowRun: '${dstRunId}' already has a workflow run recorded — pick a fresh id`);
  }
  for (const id of order) {
    if ((await journal.get(`${dstRunId}:wf:${id}`)) !== undefined) {
      throw new Error(`forkWorkflowRun: '${dstRunId}' already has step records — a fork must start from a fresh id, not merge into an existing run`);
    }
  }

  const prefixIds = order.slice(0, at);
  const copiedSteps: string[] = [];
  for (const id of prefixIds) {
    const flat = await journal.get(`${srcRunId}:wf:${id}`);
    if (flat !== undefined) {
      await journal.put(`${dstRunId}:wf:${id}`, flat);
      copiedSteps.push(id);
      // The fallback marker travels WITH the output it describes, and only with it. Copying it
      // Unconditionally (which the `:_`-skipping sweep below would never do, but an earlier
      // Unprefixed key did) produced a fork whose record claimed a substitution for an output that
      // Was never copied: measured on a source that crashed between writing the marker and writing
      // The step output, the fork then reported "failed twice, fell back to B" for a step it ran
      // Itself and got right first time. A provenance record must not outlive its subject.
      const marker = await journal.get(`${srcRunId}:wf:${id}:_fallback`);
      if (marker !== undefined) await journal.put(`${dstRunId}:wf:${id}:_fallback`, marker);
    }
    // Nested sub-workflow steps live under `<runId>:wf:<id>:<inner>` — sweep them when the journal
    // Can list, skipping control keys (`_suspend`, `_resume:*`, ...) and retry counters.
    if (journal.listKeys) {
      for (const key of await journal.listKeys(`${srcRunId}:wf:${id}:`)) {
        const tail = key.slice(`${srcRunId}:wf:`.length);
        if (tail.includes(':_') || tail.endsWith(':attempts')) continue;
        const v = await journal.get(key);
        if (v !== undefined) await journal.put(`${dstRunId}:wf:${tail}`, v);
      }
    }
  }
  // The registry record, so the fork is FINDABLE and says where it came from.
  await journal.put(statusKey(dstRunId), {
    runId: dstRunId, status: 'forked', forkedFrom: { runId: srcRunId, fromStepId }, at: Date.now(),
  });
  return { dstRunId, copiedSteps };
}

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
    // An external cancelWorkflowRun() call doesn't know the name itself, only runResumable does.
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
 * Optionally filtered by status — answers "which runs are suspended right now, on which step, waiting
 * For which waitId" without touching any run's journal. Requires `listKeys` (throws a clear error
 * Otherwise — no silent empty answer that would read as "nothing suspended").
 */
export async function listWorkflowRuns(
  journal: JournalLike,
  opts: { status?: WorkflowRunStatus['status'] } = {},
): Promise<WorkflowRunStatus[]> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error("@gnldev/workflow: listWorkflowRuns requires the journal to implement `listKeys` (see JournalLike) — without it the registry cannot be enumerated.");
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
 * Becomes the step's output; if null/undefined, it suspends. `check` typically hooks into @gnldev/events
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
    super(`@gnldev/workflow: '${stepId}' failed after ${attempts} attempts.`);
    this.name = 'RetryExhaustedError';
  }
}

// ── Retry counter read/write ──
// If the journal supports an atomic counter (incrBy + getCounters), use it: closes get→put's
// Lost-update race (two workers can't read the same value and overwrite each other; increments
// Accumulate). If not supported, falls back to the existing plain-value get→put path (single-process
// Safe, behavior unchanged). Backward compatibility: older runs may have a counter written via plain
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
      // Already includes legacy (if any) — readAttempts read Math.max(counter=0, legacy) at the
      // Start of the call, and used has only grown by +1's since then — so seed the counter
      // DIRECTLY to `used` (one-time). That way subsequent resumes' Math.max(counter, legacy)
      // Always yields the true total (counter now sits above legacy, even if legacy stays frozen).
      // The legacy FIELD itself is never written to — the "plain field untouched on the incrBy
      // Path" contract (cas.test.ts) is preserved.
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
 * Under the step's own key.
 *
 * Determinism/durable notes:
 * **The attempt counter lives in the journal** (`<runId>:wf:<id>:attempts`) → doesn't start over
 *   On crash-resume; the "total N attempts" guarantee is kept independent of process deaths. A step
 *   That was already exhausted in a previous run goes straight to the fallback (if any) on resume —
 *   It does NOT retry N more times.
 * **Suspension (WorkflowSuspended) is not an error** — it propagates outward as-is without consuming
 *   An attempt (sleep/waitFor work correctly inside retry too).
 * **The fallback is journaled separately** (`runStep(policy.fallback)`): if the fallback runs and
 *   Then crashes, it does NOT re-run on resume. The step being retried must be idempotent if it has
 *   Side effects, or use a durable tool internally (the INSIDE of an attempt is not journaled — only
 *   The counter and the final output are).
 */
export function retry<I = any, O = any>(s: Step<I, O>, policy: RetryPolicy<I, O>): Step<I, O> {
  if (!(policy.attempts >= 1)) throw new Error(`@gnldev/workflow: retry('${s.id}') requires attempts >= 1`);
  return {
    id: s.id,
    // FAZ-1: the wrapper carries the wrapped step's durability — a sideEffect step keeps its
    // Write-ahead claim under retry (the claim then covers the whole attempt sequence: one claim,
    // N in-process attempts, and a crash mid-sequence still resolves through recover/blocked).
    ...(s.durability ? { durability: s.durability as StepDurability } : {}),
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
          // FAZ-1: a sideEffect step's throw leaves the effect UNCERTAIN — the exact ambiguity the
          // Crash-window state machine refuses to guess about. An in-process re-fire must clear the
          // SAME bar: consult recover between attempts ({done:true} → that IS the step's output,
          // Journaled by the caller; {done:false} → certified not-landed, the next attempt may fire).
          // Without recover there is no honest way to re-run a non-idempotent body — the error
          // Propagates (the claim's `failed` stamp then routes the cross-process resume through the
          // Same recover/blocked discipline).
          if (s.durability?.sideEffect) {
            if (!s.durability.recover) throw e;
            const idempotencyKey = ctx.idempotencyKey ?? `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}`;
            const r = await s.durability.recover(input, { idempotencyKey });
            assertRecoverShape(r, s.id);
            if (r.done) return r.output as O;
          }
          if (used < policy.attempts && policy.backoffMs != null) {
            const ms = typeof policy.backoffMs === 'function' ? policy.backoffMs(used) : policy.backoffMs;
            if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          }
        }
      }
      if (policy.fallback) {
        const out = (await runStep(policy.fallback, input, ctx)) as O;
        // The fallback's output is written under the RETRIED step's id (this wrapper carries `s.id`),
        // So the record cannot say which of the two produced it: a "charged via provider A" step reads
        // Identically whether it worked first time or failed twice and landed on provider B. The
        // `:attempts` counter next to it does not close the gap — it may live in a counter map rather
        // Than a field, and the introspection in @gnldev/durable cannot import the reader that knows
        // The difference without a circular dependency.
        //
        // A plain `put` for that reason: whatever reads this only needs `journal.get`. Written after
        // The fallback, so a crash in between leaves no claim of a substitution that never ran; the
        // Repeat on resume is a same-value overwrite.
        await ctx.journal.put(fallbackMarkerKey(ctx.runId, ctx.keyPrefix, s.id), {
          [FALLBACK_MARKER_BRAND]: true,
          attempts: used,
          stepId: policy.fallback.id,
        });
        return out;
      }
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
 * Propagates outward: the outer `runResumable` catches it, and on resume inner steps replay from
 * Their prefixed keys.
 *   Outer.then(asStep('payment', paymentWf))   // inner: ${runId}:wf:payment:checkFunds ...
 */
export function asStep<I = any, O = any>(id: string, wf: Workflow<I, O>): Step<I, O> {
  return {
    id,
    run: (input, ctx) => wf.run(input as I, { ...ctx, keyPrefix: `${ctx.keyPrefix ?? ''}${id}:` }),
  };
}
