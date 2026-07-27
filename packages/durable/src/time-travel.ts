// M3 — Time-travel debugger core. reconstructState (pure): materialize the conversation state at
// step N from journal entries. forkRun: copy a prefix to a new runId → continue LIVE from step N
// (snapshot-based durability layers cannot do this structurally with an opaque snapshot).
import { runKeys } from './journal.js';
import { argsHash } from './hash.js';
import { assertNotCompensated } from './compensation.js';
import type { Journal, JournalReader, JournalEntry } from './journal.js';

export interface ReconstructedState {
  step: number;
  /** Messages materialized up to step N (assistant text/tool-call + tool-result). */
  messages: any[];
  /** Tool-calls not yet resolved at N. */
  pending: { toolCallId: string; toolName: string }[];
}

export interface ReconstructSeed {
  system?: string;
  messages?: any[];
  prompt?: unknown;
}

function toolIdFromKey(key: string): string {
  const i = key.lastIndexOf(':tool:');
  return i >= 0 ? key.slice(i + ':tool:'.length) : key;
}

/**
 * GOREV (args-based idempotency fidelity): a tool-call content part's `input` is the RAW provider
 * value — per the AI SDK `LanguageModelV2` spec this is a JSON-STRING (verified against
 * durable-model.ts: the journaled model record is `doGenerate()`'s result, untouched). durable-tool.ts,
 * however, computes `argsHash` over the PARSED object it receives in `execute(input, …)` (the AI SDK
 * parses the JSON string before calling execute). To reproduce the SAME hash from a journal entry we
 * must parse the string first. Best-effort: if `input` isn't a JSON string (already an object, or a
 * custom middleware stored it differently), it's hashed as-is — this only degrades fidelity for that
 * one entry (see the SINIR note on `reconstructState` below), it never throws.
 */
function parseModelInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Settles a RAW `model` journal entry's value into an ordered content-part array, whichever of the
 * TWO shapes wrote it:
 *  - non-streaming (`runDurable`/`generateText`, durable-model.ts wrapGenerate): `{ content: [...] }`
 *    — already settled, returned as-is.
 *  - streaming (`streamDurable`/`streamText`, wrapStream): `{ parts: LanguageModelV2StreamPart[], rest }`
 *    — raw provider chunks, where text/reasoning arrive as `*-start`/`*-delta` pairs that have to be
 *    accumulated before they read as content. `tool-call` arrives whole (the LanguageModelV2StreamPart
 *    `tool-call` variant already carries the full `input` string), so the partial
 *    `tool-input-start/-delta/-end` chunks are deliberately ignored — the terminal `tool-call`
 *    supersedes them.
 *
 * WHY THIS EXISTS: reconstructState used to read `value.content` directly, so a STREAMED run
 * reconstructed to nothing — no assistant text and no tool-calls, which also left every tool-call
 * stuck in `pending`. In Studio's Inspector that surfaced as every assistant bubble saying "(no text)"
 * while the run had plainly succeeded. Both shapes are legitimate and both are written by
 * durable-model.ts, so settling them here (rather than at each read site) is what keeps the two paths
 * from drifting apart again. `@gnldev/ai-sdk`'s messages.ts carries the same mapping for UIMessage
 * conversion — that copy is the one place allowed to diverge, since it additionally emits `reasoning`.
 */
export function settleModelContent(value: unknown): any[] {
  const v = value as { content?: unknown; parts?: unknown } | undefined;
  if (Array.isArray(v?.content)) return v!.content as any[];
  if (!Array.isArray(v?.parts)) return [];
  const out: any[] = [];
  const buffers = new Map<string, { type: 'text' | 'reasoning'; text: string }>();
  for (const p of v!.parts as any[]) {
    if (p?.type === 'text-start' || p?.type === 'reasoning-start') {
      const o = { type: p.type === 'text-start' ? ('text' as const) : ('reasoning' as const), text: '' };
      buffers.set(p.id, o);
      out.push(o);
    } else if (p?.type === 'text-delta' || p?.type === 'reasoning-delta') {
      const o = buffers.get(p.id);
      if (o) o.text += p.delta ?? '';
    } else if (p?.type === 'tool-call') {
      out.push({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
    }
    // Everything else ('*-end', 'stream-start', 'response-metadata', 'finish', 'tool-input-*', 'raw',
    // 'error', 'source', 'file') carries no conversation content and is dropped on purpose.
  }
  return out;
}

/**
 * Walks the ordered journal entries and materializes the state at step `uptoStep` (PURE; no journal
 * calls). If `seed` (the `:input` invisible to the reader) is given, the original user input is prepended.
 *
 * SINIR (args-mode idempotency, opt-in): a tool record's journal key is either
 * `${runId}:tool:${toolCallId}` ('call' mode, the default) or `${runId}:tool:args-${toolName}-${hash}`
 * ('args' mode — see journal.ts runKeys.toolByArgs). In 'args' mode the dedupe id embedded in the key
 * is NOT a real AI SDK toolCallId, so it can't be matched against `pending` directly. PRIMARY match:
 * the record's own `resolvedToolCallIds` (see journal.ts ToolJournalRecord + durable-tool.ts
 * writeToolTerminal/trackResolvedToolCallId) — the REAL toolCallId(s) durable-tool.ts observed serving
 * this record, stamped at write time. This is EXACT and is what resolves a custom `idempotencyKey`
 * function's records too (see types.ts AnyTool.idempotencyKey): that function lives in the tool
 * definition, not the journal, so it can never be recomputed HERE — `resolvedToolCallIds` sidesteps the
 * problem entirely by not needing to recompute anything. FALLBACK (records written before this field
 * existed): recompute the SAME `args-${toolName}-${hash}` form from each pending tool-call's `input`
 * (via `argsHash(parseModelInput(...))`) and match on that — best-effort, degrades for a custom
 * `idempotencyKey` (see git history / CHANGELOG: this used to be a KNOWN LIMITATION — a resolved
 * custom-idempotencyKey tool-call stayed "pending" forever, even on a genuinely completed run; fixed by
 * `resolvedToolCallIds`, kept here only for old records). A single args-keyed record can resolve
 * MULTIPLE pending entries at once (the documented same-turn duplicate case: N different
 * toolCallIds, same arguments, one execution) — each resolved pending entry gets its OWN tool-result
 * message (same output, its own REAL toolCallId — the AI SDK message format requires a real id, not the
 * dedupe key).
 */
export function reconstructState(
  entries: JournalEntry[],
  uptoStep: number = entries.length,
  seed?: ReconstructSeed,
): ReconstructedState {
  const messages: any[] = [];

  if (seed) {
    if (Array.isArray(seed.messages)) messages.push(...seed.messages);
    else if (typeof seed.prompt === 'string') messages.push({ role: 'user', content: seed.prompt });
  }

  const upto = Math.max(0, Math.min(uptoStep, entries.length));
  const window = entries.slice(0, upto);

  // PASS 1 (pure lookup building, no `messages` writes yet): collect every tool-call introduced by a
  // model entry in the window, in appearance order.
  // Internal only (NOT part of the public `pending` shape — keeping it out preserves the existing
  // toEqual({ toolCallId, toolName }) assertions in tests): toolCallId → recomputed args-mode dedupe id.
  const toolCalls: { toolCallId: string; toolName: string }[] = [];
  const argsKeyByToolCallId = new Map<string, string>();
  for (const e of window) {
    if (e.kind !== 'model') continue;
    for (const p of settleModelContent(e.value)) {
      if (p?.type === 'tool-call') {
        toolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName });
        argsKeyByToolCallId.set(p.toolCallId, `args-${p.toolName}-${argsHash(parseModelInput(p.input))}`);
      }
    }
  }

  // PASS 2 (GOREV — time-travel fidelity, args-mode custom idempotencyKey): decide, PER TOOL ENTRY,
  // which toolCallId(s) it resolves — independent of the entry's OWN position in `window`.
  //
  // WHY POSITION-INDEPENDENT: the journal stores ONE row per key, overwritten in place at ITS FIRST
  // write position (see journal.ts InMemoryJournal.put / the SQL adapters' UPSERT — position tracks
  // first-write time, not last-update time). An 'args' mode record can be updated LATER by
  // trackResolvedToolCallId (durable-tool.ts) to append a toolCallId from a LATER model step (e.g. a
  // custom `idempotencyKey` tool called again, same logical key, in a subsequent turn) — that
  // toolCallId's `tool-call` part appears AFTER this record's array position. A single forward pass
  // that only matches against toolCallIds seen so far would therefore NEVER resolve it (reproduced:
  // two chargeOrder-style calls to the same orderId in different turns — the second stayed "pending"
  // forever even though `resolvedToolCallIds` correctly listed it). Computing matches against the FULL
  // `toolCalls` list up front (this pass, independent of `window` order) fixes it; PASS 3 below still
  // renders `messages` in the ORIGINAL entry order using these pre-computed matches.
  const claimed = new Set<string>(); // toolCallIds already resolved by an earlier (in window order) record
  const matchesByIndex = new Map<number, { toolCallId: string; toolName: string }[]>();
  window.forEach((e, i) => {
    if (e.kind !== 'tool') return;
    const rec = e.value as any;
    const dedupeId = toolIdFromKey(e.key);
    // a succeeded/denied record written by a current durable-tool.ts carries `resolvedToolCallIds` —
    // the REAL toolCallId(s) it resolved (see journal.ts ToolJournalRecord + durable-tool.ts
    // writeToolTerminal/trackResolvedToolCallId). This is EXACT (no recomputation needed) and is the
    // ONLY way to resolve a custom `idempotencyKey` record, since that function lives in the tool
    // definition, not the journal. Records written before this field existed fall back to the old
    // best-effort key-recompute matching below.
    const resolvedIds: string[] | undefined = Array.isArray(rec?.resolvedToolCallIds) ? rec.resolvedToolCallIds : undefined;
    // 'call' mode: dedupeId IS the real toolCallId → matches x.toolCallId directly.
    // 'args' mode: dedupeId is `args-${toolName}-${hash}` → matches the recomputed argsKey, and MAY
    // match more than one pending entry (same-turn duplicate calls with identical arguments).
    const candidates = resolvedIds
      ? toolCalls.filter((x) => resolvedIds.includes(x.toolCallId))
      : toolCalls.filter((x) => x.toolCallId === dedupeId || argsKeyByToolCallId.get(x.toolCallId) === dedupeId);
    // defensive: a toolCallId already claimed by an earlier record in window order is not re-claimed
    // (mirrors the previous mutate-and-remove semantics; should not happen in correct operation).
    const matches = candidates.filter((m) => !claimed.has(m.toolCallId));
    matchesByIndex.set(i, matches);
    // suspended = still AWAITING APPROVAL, running = still executing → STAYS in pending.
    // Only resolved records (succeeded/denied/failed) drop from pending.
    const resolved = rec?.status !== 'suspended' && rec?.status !== 'running';
    if (resolved) for (const m of matches) claimed.add(m.toolCallId);
  });

  // PASS 3: render `messages` in the ORIGINAL window order (model/tool interleaving UNCHANGED from
  // before — only the matches driving each tool entry's rendering came from a position-independent
  // computation above).
  window.forEach((e, i) => {
    if (e.kind === 'model') {
      const assistant: any[] = [];
      for (const p of settleModelContent(e.value)) {
        if (p?.type === 'text') assistant.push({ type: 'text', text: p.text ?? '' });
        else if (p?.type === 'tool-call') assistant.push({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
      }
      messages.push({ role: 'assistant', content: assistant });
      return;
    }
    const rec = e.value as any;
    const dedupeId = toolIdFromKey(e.key);
    const matches = matchesByIndex.get(i)!;
    if (matches.length > 0) {
      for (const m of matches) {
        messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: m.toolCallId, output: rec?.output ?? rec }] });
      }
    } else {
      // SINIR: no pending entry could be matched back to this record (custom idempotencyKey, or
      // input that couldn't be recomputed) — best-effort, same as the pre-fix behavior.
      messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: dedupeId, output: rec?.output ?? rec }] });
    }
  });

  const pending = toolCalls.filter((t) => !claimed.has(t.toolCallId));

  return { step: upto, messages, pending };
}

export interface ForkResult {
  newRunId: string;
  copiedModel: number;
  copiedTool: number;
}

/**
 * Non-destructive "re-run from here": COPY `srcRunId`'s first `step` model steps + the tool
 * entries they reference + `:input` under `newRunId`. `model:step` and beyond are not copied →
 * resume replays the prefix and runs LIVE from step N. The journal must provide both write and read.
 *
 * SINIR (args-mode idempotency, opt-in): a tool-call referenced by a kept model step may have been
 * journaled under `runKeys.tool` ('call' mode) OR `runKeys.toolByArgs` ('args' mode) — the model
 * record alone doesn't say which. Both candidate keys are tried per tool-call and whichever is
 * PRESENT is copied to `dst` under the SAME key form (preserving 'args' mode's exactly-once
 * protection across the fork). Same known limitation as `reconstructState`: a custom `idempotencyKey`
 * function's key can't be rederived here, so that record is not copied (fork loses exactly-once for
 * that tool and it re-executes on resume — accepted, documented).
 */
export async function forkRun(
  journal: Journal & JournalReader,
  srcRunId: string,
  step: number,
  newRunId?: string,
): Promise<ForkResult> {
  // GOREV (saga): a fork of a COMPENSATED run is the same hazard class as resuming it — the copy
  // would replay memoized successes of side effects that were UNWOUND (the tombstone is a proc key,
  // invisible to readRun, so the copy itself would silently drop it) → refuse at the source.
  await assertNotCompensated(journal, srcRunId);
  const dst = newRunId ?? `${srcRunId}:fork:${Date.now()}`;
  const entries = await journal.readRun(srcRunId);
  const models = entries.filter((e) => e.kind === 'model');
  const keep = models.slice(0, Math.max(0, step)); // first `step` model steps

  let copiedModel = 0;
  let copiedTool = 0;
  const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];

  for (const m of keep) {
    const n = m.key.slice(m.key.lastIndexOf(':model:') + ':model:'.length);
    await journal.put(runKeys.model(dst, n), m.value);
    copiedModel++;
    for (const p of ((m.value as any)?.content ?? []) as any[]) {
      if (p?.type === 'tool-call' && p.toolCallId) toolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
    }
  }

  const entryByKey = new Map<string, JournalEntry>();
  for (const e of entries) if (e.kind === 'tool') entryByKey.set(e.key, e);

  const copiedDstKeys = new Set<string>(); // avoid double-copy/double-count when several toolCallIds share one args-mode record
  for (const tc of toolCalls) {
    const hash = argsHash(parseModelInput(tc.input));
    const candidates: [string, string][] = [
      [runKeys.tool(srcRunId, tc.toolCallId), runKeys.tool(dst, tc.toolCallId)],
      [runKeys.toolByArgs(srcRunId, tc.toolName, hash), runKeys.toolByArgs(dst, tc.toolName, hash)],
    ];
    for (const [srcKey, dstKey] of candidates) {
      if (copiedDstKeys.has(dstKey)) continue;
      const e = entryByKey.get(srcKey);
      if (e) {
        await journal.put(dstKey, e.value);
        copiedDstKeys.add(dstKey);
        copiedTool++;
      }
    }
  }

  const input = await journal.get(runKeys.input(srcRunId));
  if (input !== undefined) await journal.put(runKeys.input(dst), input);

  return { newRunId: dst, copiedModel, copiedTool };
}
