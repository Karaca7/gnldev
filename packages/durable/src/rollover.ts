// Rollover — a first-class period-closing helper for the long-lived SINGLE run problem
// (mitigation for the core-hardening review risk #1). Since the journal is append-only it can't be
// trimmed, and replay always starts from the beginning; for an agent that lives for weeks, the
// solution is to split the run into LOGICAL PERIODS: at period close, the old run's materialized
// final state (messages) is carried over into a new runId's `:input` seed, and the new period
// continues from that context with a fresh journal. This file turns that user pattern into a
// deterministic + idempotent API. IT DELETES NOTHING — the old journal remains as-is
// (purge/sweep is a separate decision, see retention.ts).
//
// PATTERN (long-lived agent):
//   1. Period N runs:              await runDurable({ runId: 'agent', journal, model, tools, ... })
//   2. Period close:               const r = await rolloverRun(journal, 'agent')          // → 'agent@2'
//   3. Period N+1 continuation (plain): await resumeRun(r.newRunId, { journal, model, tools }) // from :input seed
//      — or explicitly:            await runDurable({ runId: r.newRunId, journal, model, tools, messages: r.messages })
//
// INPUT-SEED CONTRACT: the seed is written to `runKeys.input(newRunId)` in the shape run.ts's
// `persistInput` writes (`{ messages, system? }`) → WITHOUT BREAKING `resumeRun`/`persistInput`
// semantics, the new run naturally inherits the input (persistInput sees the key already filled
// and skips it; resumeRun reads from there). IMPORTANT LIMIT: do NOT pass `messages` DIFFERENT
// from the seed to the new period's FIRST call — since `:input` is already filled, the difference
// is not written to the journal and a subsequent resume won't see those messages. If the new
// period needs extra instructions/a summary, do it inside `carry` (the seed and the live call
// always stay the same). For convenience, the seed messages are also returned in `RolloverResult.messages`.
//
// FORMAT NOTE (honest deviation): reconstructState's raw output is in journal-record shape —
// tool-result parts have no `toolName` and `output` is untyped; AI SDK v5's `generateText`
// VALIDATES messages against a schema (missing toolName → InvalidPromptError). Therefore the
// carried-over messages are normalized into ModelMessage shape while preserving CONTENT exactly
// (filling in toolName, typing `output` as `{type:'json'|'text', value}`, parsing the tool-call
// `input` JSON string into an object). "Carried over exactly" is at the content level, not the byte level.
import { runKeys, claim } from './journal.js';
import { stampFormat, upgradeFormat } from './format.js';
import { reconstructState } from './time-travel.js';
import type { ReconstructSeed } from './time-travel.js';
import type { Journal, JournalReader } from './journal.js';

export interface RolloverOptions {
  /** New runId (if not given, `${runId}@2`, incrementing @N — existing @N's are counted/skipped). */
  newRunId?: string;
  /** Summarize and carry over the old conversation: (messages) => messages to carry over. If not given, messages are carried over EXACTLY. */
  carry?: (messages: unknown[]) => unknown[] | Promise<unknown[]>;
}

export interface RolloverResult {
  newRunId: string;
  seededMessages: number;
  /** Messages seeded into the new run (identical to the `messages` in `runKeys.input(newRunId)`). */
  messages: unknown[];
}

/** Handoff marker on the old run: `${runId}:rollover` → `{ to, at }` (invisible to parseJournalKey). */
export const rolloverKey = (runId: string) => `${runId}:rollover`;

// Any run with `:input` written is considered "filled" (persistInput/forkRun/rollover all write input).
async function pickNextRunId(journal: Journal, runId: string): Promise<string> {
  const m = /^(.*)@(\d+)$/.exec(runId); // handoff of 'agent@2' → start searching from 'agent@3'
  const base = m ? m[1]! : runId;
  const start = m ? Number(m[2]) + 1 : 2;
  for (let n = start; n < start + 10_000; n++) {
    const cand = `${base}@${n}`;
    if ((await journal.get(runKeys.input(cand))) === undefined) return cand;
  }
  throw new Error(`@gnldev/durable: rolloverRun could not find a free epoch name (all '${base}@N' are taken).`);
}

function parseMaybeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Type the raw tool output as AI SDK v5's `LanguageModelV2ToolResultOutput` (leave untouched if already typed).
function toTypedToolOutput(v: unknown): unknown {
  if (
    v !== null &&
    typeof v === 'object' &&
    'value' in (v as any) &&
    ['text', 'json', 'error-text', 'error-json', 'content'].includes((v as any).type)
  ) {
    return v; // already typed (e.g. coming from a period that was already normalized and carried over)
  }
  return typeof v === 'string' ? { type: 'text', value: v } : { type: 'json', value: v ?? null };
}

/** Normalizes reconstructState's output into the ModelMessage shape `generateText` accepts (pure). */
export function toModelMessages(raw: unknown[]): unknown[] {
  const toolNames = new Map<string, string>(); // toolCallId → toolName (from assistant tool-calls)
  const out: unknown[] = [];
  for (const msg of raw as any[]) {
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      out.push({
        role: 'assistant',
        content: msg.content.map((p: any) => {
          if (p?.type !== 'tool-call') return p;
          if (p.toolCallId && p.toolName) toolNames.set(p.toolCallId, p.toolName);
          return { type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: parseMaybeJson(p.input) };
        }),
      });
    } else if (msg?.role === 'tool' && Array.isArray(msg.content)) {
      out.push({
        role: 'tool',
        content: msg.content.map((p: any) =>
          p?.type === 'tool-result'
            ? {
                type: 'tool-result',
                toolCallId: p.toolCallId,
                toolName: p.toolName ?? toolNames.get(p.toolCallId) ?? 'unknown',
                output: toTypedToolOutput(p.output),
              }
            : p,
        ),
      });
    } else {
      out.push(msg); // user/system (from the seed) — as-is
    }
  }
  return out;
}

/**
 * Period handoff: carries the old run's FINAL state (`reconstructState`) into a new runId's
 * `:input` seed. Deterministic + idempotent + non-destructive:
 *
 * - **Deterministic target:** a `${runId}:rollover` → `{ to, at }` marker is written to the old run
 *   via `claim`. The same old run CANNOT be handed off a SECOND time (even with a different
 *   `newRunId`) — the EXISTING target in the marker is returned. Of two concurrent rollovers, only
 *   one determines the target.
 * - **Idempotent seed:** `runKeys.input(newRunId)` is written via `claim`; if the key already
 *   exists, the EXISTING seed is preserved (not overwritten), and the second call returns the same
 *   result as a no-op. This also freezes the non-deterministic `carry` (e.g. an LLM summary) exactly once.
 * - **No deletion:** the old journal is untouched; trimming/purge is a separate decision (retention.ts).
 *
 * The old run's `system` (if present, from its `:input`) is carried over to the new seed exactly.
 * `journal` must provide a read surface (`readRun`) — the SQLite/Postgres/InMemory adapters provide
 * it; a journal that doesn't provide it throws a clear error. Handing off a period that has a
 * suspended tool works structurally but is not recommended — do the handoff at period close (when nothing is suspended).
 */
export async function rolloverRun(journal: Journal, runId: string, opts?: RolloverOptions): Promise<RolloverResult> {
  const readRun = (journal as Partial<JournalReader>).readRun;
  if (typeof readRun !== 'function') {
    throw new Error(
      `@gnldev/durable: rolloverRun requires 'readRun' (JournalReader) — this journal does not provide a read surface. ` +
        `Use an adapter like InMemoryJournal / SqliteStorage.runs / PostgresStorage.runs.`,
    );
  }

  // 1) Determine the target deterministically: the marker claim's winner writes the target; the loser reads the EXISTING target.
  const candidate = opts?.newRunId ?? (await pickNextRunId(journal, runId));
  let newRunId = candidate;
  if (!(await claim(journal, rolloverKey(runId), { to: candidate, at: Date.now() }))) {
    const existing = await journal.get<{ to: string }>(rolloverKey(runId));
    if (!existing?.to) throw new Error(`@gnldev/durable: the '${rolloverKey(runId)}' marker could not be read (corrupt record?).`);
    newRunId = existing.to;
  }

  // 2) If the seed already exists → no-op: report the existing seed exactly WITHOUT OVERWRITING it (idempotent second call).
  const inputKey = runKeys.input(newRunId);
  const already = await journal.get<{ messages?: unknown[] }>(inputKey);
  if (already !== undefined) {
    const msgs = Array.isArray(already.messages) ? already.messages : [];
    return { newRunId, seededMessages: msgs.length, messages: msgs };
  }

  // 3) Materialize the old run's final state (input + all model/tool steps).
  const entries = await readRun.call(journal, runId);
  const oldInput = upgradeFormat(await journal.get<ReconstructSeed>(runKeys.input(runId)), runKeys.input(runId)); // H13
  if (entries.length === 0 && oldInput === undefined) {
    throw new Error(`@gnldev/durable: rolloverRun — no journal record for '${runId}' (no state found to hand over).`);
  }
  const state = reconstructState(entries, entries.length, oldInput);
  let messages = toModelMessages(state.messages);
  if (opts?.carry) messages = await opts.carry(messages);

  // 4) Write the seed via claim (the race loser discards its own result and reports the winner's seed).
  const seed = { messages, ...(oldInput?.system !== undefined ? { system: oldInput.system } : {}) };
  if (!(await claim(journal, inputKey, stampFormat(seed as object)))) {
    const winner = await journal.get<{ messages?: unknown[] }>(inputKey);
    const msgs = Array.isArray(winner?.messages) ? winner!.messages! : [];
    return { newRunId, seededMessages: msgs.length, messages: msgs };
  }
  return { newRunId, seededMessages: messages.length, messages };
}
