// W2 — Replay-based regression core. RERUNS a recorded run with a new model/prompt/tool version
// (replayRun), diffs the DECISION POINTS (model step + tool call) of the two runs (diffRuns).
// Scoring (LLM-judge etc.) lives in the evals package — only the interface is DEFINED here,
// the diff logic has no dependency on evals whatsoever (dependency is one-directional: evals -> durable).
import { runKeys } from './journal.js';
import type { Journal, JournalEntry, JournalReader } from './journal.js';
import { runDurable } from './run.js';
import type { DurableResult, RunDurableArgs } from './run.js';
import { argsHash, stableStringify } from './hash.js';
import type { Guard } from './guard.js';

// ── Decision point sequence ────────────────────────────────────────────────────
// toolCallIds CAN BE DIFFERENT across runs (the model/SDK assigns random ids) → alignment is based
// not on toolCallId equality but on "model step + the content order of the tool-calls that step
// produced". This makes the decision points of two independent runs comparable positionally.
export interface DecisionPoint {
  /** The model step this decision belongs to (for tool, the step of the model step that produced it). */
  step: number;
  kind: 'model' | 'tool';
  toolCallId?: string;
  toolName?: string;
  /** model: doGenerate result (the raw value in the journal) · tool: ToolJournalRecord. */
  value: unknown;
}

function toolIdFromKey(key: string): string {
  const i = key.lastIndexOf(':tool:');
  return i >= 0 ? key.slice(i + ':tool:'.length) : key;
}

function modelStepFromKey(key: string): number {
  const i = key.lastIndexOf(':model:');
  const raw = i >= 0 ? key.slice(i + ':model:'.length) : key;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converts journal entries into a sequence of decision points: model steps in step order, followed
 * immediately by the tool-calls (if any) produced in that step's content — a PURE function.
 * Exported for P1.1 (AUDIT-R2): @gnldev/evals' trajectory scorer (`trajectory.ts`) reuses this
 * same primitive to build the tool-call sequence it scores against expectations — no duplicate logic.
 */
export function buildDecisionSequence(entries: JournalEntry[]): DecisionPoint[] {
  const models = entries
    .filter((e) => e.kind === 'model')
    .slice()
    .sort((a, b) => modelStepFromKey(a.key) - modelStepFromKey(b.key));
  const toolById = new Map<string, JournalEntry>();
  for (const e of entries) if (e.kind === 'tool') toolById.set(toolIdFromKey(e.key), e);

  const out: DecisionPoint[] = [];
  for (const m of models) {
    const step = modelStepFromKey(m.key);
    out.push({ step, kind: 'model', value: m.value });
    const content = ((m.value as any)?.content ?? []) as any[];
    for (const p of content) {
      if (p?.type === 'tool-call' && p.toolCallId) {
        const te = toolById.get(p.toolCallId);
        out.push({ step, kind: 'tool', toolCallId: p.toolCallId, toolName: p.toolName, value: te?.value });
      }
    }
  }
  return out;
}

// ── Comparison ────────────────────────────────────────────────────────────

/** Readable detail of a decision point difference (some fields are populated depending on kind). */
export interface DiffDetail {
  /** model: the combined text output of both sides. */
  textA?: string;
  textB?: string;
  /** model: the tool-call list of both sides (toolName + argsHash — order is content order). */
  toolCallsA?: { toolName: string; argsHash: string }[];
  toolCallsB?: { toolName: string; argsHash: string }[];
  /** tool: the decision point's tool name (a single name if unchanged, "old -> new" if changed). */
  toolName?: string;
  /** tool: the argsHash from ToolJournalRecord.succeeded (secondary integrity signature). */
  argsHashA?: string;
  argsHashB?: string;
  statusA?: string;
  statusB?: string;
  outputA?: unknown;
  outputB?: unknown;
  /** Structural mismatch note (e.g. kind changed: model -> tool). */
  note?: string;
}

export interface DiffEntry {
  /** The model step the decision point belongs to. */
  step: number;
  kind: 'model' | 'tool';
  durum: 'same' | 'changed' | 'missing' | 'added';
  detay?: DiffDetail;
}

export interface RunDiff {
  steps: DiffEntry[];
  /** Index of the first decision point where the two runs diverge (over steps[]) — undefined if all are same. */
  divergentAt?: number;
  summary: { same: number; changed: number; missing: number; added: number };
}

function parseMaybeJSON(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function modelText(value: unknown): string {
  return (((value as any)?.content ?? []) as any[])
    .filter((p) => p?.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

function modelToolCalls(value: unknown): { toolName: string; argsHash: string }[] {
  return (((value as any)?.content ?? []) as any[])
    .filter((p) => p?.type === 'tool-call')
    .map((p) => ({ toolName: p.toolName, argsHash: argsHash(parseMaybeJSON(p.input)) }));
}

function compareModelPoints(av: unknown, bv: unknown): { same: boolean; detay?: DiffDetail } {
  const textA = modelText(av);
  const textB = modelText(bv);
  const callsA = modelToolCalls(av);
  const callsB = modelToolCalls(bv);
  const same = textA === textB && stableStringify(callsA) === stableStringify(callsB);
  if (same) return { same: true };
  return { same: false, detay: { textA, textB, toolCallsA: callsA, toolCallsB: callsB } };
}

function compareToolPoints(a: DecisionPoint, b: DecisionPoint): { same: boolean; detay?: DiffDetail } {
  const va = a.value as any;
  const vb = b.value as any;
  const statusA = va?.status;
  const statusB = vb?.status;
  const argsHashA = va?.argsHash;
  const argsHashB = vb?.argsHash;
  const outputA = va?.output;
  const outputB = vb?.output;
  const same =
    a.toolName === b.toolName &&
    statusA === statusB &&
    argsHashA === argsHashB &&
    stableStringify(outputA) === stableStringify(outputB);
  if (same) return { same: true };
  return {
    same: false,
    detay: {
      toolName: a.toolName === b.toolName ? a.toolName : `${a.toolName} -> ${b.toolName}`,
      statusA,
      statusB,
      argsHashA,
      argsHashB,
      outputA,
      outputB,
    },
  };
}

function comparePoints(a: DecisionPoint, b: DecisionPoint): { same: boolean; detay?: DiffDetail } {
  if (a.kind !== b.kind) {
    return { same: false, detay: { note: `kind changed: ${a.kind} -> ${b.kind}` } };
  }
  return a.kind === 'model' ? compareModelPoints(a.value, b.value) : compareToolPoints(a, b);
}

function describePoint(side: 'A' | 'B', p: DecisionPoint): DiffDetail {
  if (p.kind === 'model') {
    return side === 'A'
      ? { textA: modelText(p.value), toolCallsA: modelToolCalls(p.value) }
      : { textB: modelText(p.value), toolCallsB: modelToolCalls(p.value) };
  }
  const v = p.value as any;
  return side === 'A'
    ? { toolName: p.toolName, statusA: v?.status, argsHashA: v?.argsHash, outputA: v?.output }
    : { toolName: p.toolName, statusB: v?.status, argsHashB: v?.argsHash, outputB: v?.output };
}

/**
 * Aligns and compares the decision points (model steps + tool calls) of two runs.
 * Alignment is positional (see buildDecisionSequence) — it does not rely on toolCallId equality.
 * If there's a length difference, the extra points after the common prefix ends are marked 'missing'
 * (only in A) or 'added' (only in B). `divergentAt` is the index of the first non-same point.
 *
 * TRUST BOUNDARY (Decision #3): if the tool-call COUNT changes at the divergence point, the tail
 * shifts positionally — the `durum` labels AND `summary` counts AFTER `divergentAt` may contain
 * noise (re-alignment is deliberately NOT DONE: LCS-style alignment produces a multi-solution/unstable
 * diff). The reliable signal is `divergentAt` and everything before it; read the `steps.slice(divergentAt)`
 * record with this caveat in mind for post-divergence analysis. Scorers should tie their score to
 * `divergentAt` (not to summary).
 */
export async function diffRuns(reader: JournalReader, runIdA: string, runIdB: string): Promise<RunDiff> {
  const [entriesA, entriesB] = await Promise.all([reader.readRun(runIdA), reader.readRun(runIdB)]);
  const seqA = buildDecisionSequence(entriesA);
  const seqB = buildDecisionSequence(entriesB);

  const steps: DiffEntry[] = [];
  const summary = { same: 0, changed: 0, missing: 0, added: 0 };
  let divergentAt: number | undefined;
  const len = Math.max(seqA.length, seqB.length);

  for (let i = 0; i < len; i++) {
    const a = seqA[i];
    const b = seqB[i];
    let entry: DiffEntry;
    if (a && b) {
      const cmp = comparePoints(a, b);
      entry = { step: a.step, kind: a.kind, durum: cmp.same ? 'same' : 'changed', detay: cmp.detay };
    } else if (a) {
      entry = { step: a.step, kind: a.kind, durum: 'missing', detay: describePoint('A', a) };
    } else {
      entry = { step: b!.step, kind: b!.kind, durum: 'added', detay: describePoint('B', b!) };
    }
    if (entry.durum !== 'same' && divergentAt === undefined) divergentAt = i;
    summary[entry.durum]++;
    steps.push(entry);
  }

  return { steps, divergentAt, summary };
}

// ── Replay ───────────────────────────────────────────────────────────────────

/** Configuration for RERUNNING a recorded run's input with a new, independent runId. */
export interface ReplayRunConfig {
  /** The journal used to read the source run's input AND write the new run (same instance). */
  journal: Journal & JournalReader;
  /** The recorded (base) run whose input will be replayed. */
  runId: string;
  /** The new run's runId (auto-derived if not given). The source run's journal is NOT TOUCHED. */
  newRunId?: string;
  /** The model to use for the new run — this is the point of a regression test (overridable). */
  model: RunDurableArgs['model'];
  /** Overridable tool set (if not given, no tools are passed to the original input). */
  tools?: RunDurableArgs['tools'];
  /** System prompt override (uses the original input's system if not given). */
  system?: string;
  guard?: Guard;
  approvals?: Record<string, boolean>;
  stopWhen?: RunDurableArgs['stopWhen'];
  /** Replay determinism mode (see DurableCtx.replay) — the new run is the first run in its own journal. */
  replay?: 'strict' | 'lenient';
  /**
   * COUNTERFACTUAL memory-off replay: re-run the turn WITHOUT what memory injected. Reads the run's
   * ':memctx' provenance record (runKeys.memoryContext) and keeps only the turn's own incoming
   * message(s) — the recalled/window/observation messages that memory composed in front of them are
   * dropped. This turns "the model must have read it from the recall snippet" from an inference into
   * an experiment: strip the injection, re-ask, diff the answers. Requires a ':memctx' record
   * (throws otherwise — runs from before provenance existed can't be stripped honestly).
   * HONEST BOUNDARY: the frozen `system` string is NOT surgically edited — if working memory was
   * injected there (provenance.workingMemoryChars), it remains; callers should disclose that.
   */
  stripMemoryContext?: boolean;
}

export interface ReplayRunResult {
  newRunId: string;
  result: DurableResult;
}

let replaySeq = 0;

/**
 * Reads `runId`'s recorded input (`runKeys.input`) and runs it fresh, independently, under a NEW
 * runId (`runDurable`). This is NOT `forkRun`: it doesn't copy prefixes, doesn't replay any step
 * from the journal — it's a brand-new run with overridable model/tool/system. It never writes to
 * or touches the original `runId`'s journal records (only writes under `newRunId`).
 */
export async function replayRun(cfg: ReplayRunConfig): Promise<ReplayRunResult> {
  const { journal, runId, newRunId, model, tools, system, guard, approvals, stopWhen, replay, stripMemoryContext } = cfg;
  const input = await journal.get<{ prompt?: unknown; messages?: unknown; system?: unknown }>(runKeys.input(runId));
  if (!input) {
    throw new Error(`@gnldev/durable: no recorded input for runId "${runId}" — cannot replay.`);
  }

  let messages = input.messages as any[] | undefined;
  if (stripMemoryContext) {
    const memctx = await journal.get<{ incomingCount?: number }>(runKeys.memoryContext(runId));
    const incoming = memctx?.incomingCount ?? 0;
    if (!memctx || incoming <= 0 || !Array.isArray(messages)) {
      throw new Error(
        `@gnldev/durable: run "${runId}" has no usable ':memctx' provenance — a memory-off replay can only strip what was provably injected.`,
      );
    }
    // The frozen input is [ ...memory-composed history, ...incoming ] (see run.ts prepareMemoryContext)
    // — the turn's own contribution is exactly the trailing incomingCount messages.
    messages = messages.slice(-incoming);
  }

  const dst = newRunId ?? `${runId}:replay:${Date.now()}:${replaySeq++}`;

  const result = await runDurable({
    runId: dst,
    journal,
    model,
    tools,
    guard,
    approvals,
    stopWhen,
    replay,
    ...(messages ? { messages } : {}),
    ...(input.prompt && !messages ? { prompt: input.prompt } : {}),
    system: system ?? (input.system as string | undefined),
  } as any);

  return { newRunId: dst, result };
}

// ── Report skeleton ────────────────────────────────────────────────────────────

/**
 * Optional function producing a score from a diff result. The concrete Scorer type is defined in
 * the evals package (@gnldev/evals -> @gnldev/durable dependency is one-directional); only a loose
 * interface is given here.
 */
export type RegressionScorer = (diff: RunDiff) => unknown | Promise<unknown>;

export interface RegressionReportOptions {
  scorer?: RegressionScorer;
}

export interface RegressionReport {
  baseRunId: string;
  newRunId: string;
  diff: RunDiff;
  /** undefined if `opts.scorer` isn't given — scoring is entirely opt-in. */
  score?: unknown;
}

/**
 * A thin report skeleton around `diffRuns`: diffs the base/new run, runs `scorer` on the diff if
 * given. Scoring logic is NOT here — the evals side supplies `scorer`.
 */
export async function regressionReport(
  reader: JournalReader,
  baseRunId: string,
  newRunId: string,
  opts?: RegressionReportOptions,
): Promise<RegressionReport> {
  const diff = await diffRuns(reader, baseRunId, newRunId);
  const score = opts?.scorer ? await opts.scorer(diff) : undefined;
  return { baseRunId, newRunId, diff, score };
}
