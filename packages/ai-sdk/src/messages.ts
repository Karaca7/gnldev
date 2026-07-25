// Journal history → `useChat({ messages: … })`-shaped `UIMessage[]`. Built on @gnldev/durable's
// `reconstructState` (packages/durable/src/time-travel.ts) — a PURE walk over `JournalEntry[]` that
// already solves the hard part (matching tool-calls to tool-results, including the args-mode
// idempotency dedup cases documented at the top of time-travel.ts). We deliberately do NOT touch
// time-travel.ts (shared, sensitive file with its own test suite) — this module only re-derives what it
// needs ON TOP of `reconstructState`'s output.
//
// v1 HONESTY NOTE (documented limitation, not silently dropped): `reconstructState`'s own assistant-
// message shape only special-cases `type: 'text'` and `type: 'tool-call'` content parts (see
// time-travel.ts ~151-153) — it drops `reasoning` parts. To recover reasoning (and to correctly handle
// STREAMED runs, whose journal shape is `{ parts, rest }` rather than `{ content }` — see
// durable-model.ts's wrapStream/wrapGenerate split), this module re-reads the RAW `model` journal entries
// itself (paired 1:1, in order, with reconstructState's assistant-role messages — see `seedLen` below)
// instead of relying on reconstructState's simplified content. Files/sources ARE dropped for v1 (no
// `file`/`source` UIMessage parts are produced) — a real limitation, called out here rather than papered
// over.
import { reconstructState } from '@gnldev/durable';
import type { Interrupt, JournalEntry, ReconstructSeed } from '@gnldev/durable';
import type { UIMessage } from 'ai';
import { maskSentinelOutput } from './sentinel-mask.js';

export interface ToUIMessagesOptions {
  /**
   * The run's invisible `:input` record (see persistInput/runKeys.input in run.ts — NOT returned by
   * `journal.readRun()`), fetched separately by the caller and passed through unchanged: same shape as
   * `reconstructState`'s own `seed` parameter.
   */
  seed?: ReconstructSeed;
  /** Prefix for deterministic UIMessage ids (`${runId}:msg:${i}`). Defaults to `'run'`. */
  runId?: string;
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input; // best-effort — see time-travel.ts's own `parseModelInput` for the same fallback policy
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p: any) => p?.type === 'text').map((p: any) => p.text ?? '').join('');
  return '';
}

/**
 * Settles a RAW `model` journal entry's value into an ordered content-part array, regardless of which
 * of the two shapes wrote it:
 *  - non-streaming (`runDurable`/`generateText`): `{ content: LanguageModelV2Content[] }` — already settled.
 *  - streaming (`streamDurable`/`streamText`, i.e. THIS package's normal path via chat-route.ts):
 *    `{ parts: LanguageModelV2StreamPart[], rest }` — raw provider stream chunks; text/reasoning arrive as
 *    `*-start`/`*-delta` pairs that must be accumulated, `tool-call` arrives whole (no accumulation needed
 *    — verified against @ai-sdk/provider's LanguageModelV2StreamPart: the `tool-call` variant already
 *    carries the full `input` string).
 * `tool-input-start/-delta/-end` (partial-args streaming) are intentionally ignored — the terminal
 * `tool-call` chunk supersedes them.
 */
function contentFromModelValue(value: unknown): any[] {
  const v = value as { content?: unknown; parts?: unknown } | undefined;
  if (Array.isArray(v?.content)) return v!.content as any[];
  if (!Array.isArray(v?.parts)) return [];
  const out: any[] = [];
  const buffers = new Map<string, { type: 'text' | 'reasoning'; text: string }>();
  for (const p of v!.parts as any[]) {
    if (p?.type === 'text-start') {
      const o = { type: 'text' as const, text: '' };
      buffers.set(p.id, o);
      out.push(o);
    } else if (p?.type === 'text-delta') {
      const o = buffers.get(p.id);
      if (o) o.text += p.delta ?? '';
    } else if (p?.type === 'reasoning-start') {
      const o = { type: 'reasoning' as const, text: '' };
      buffers.set(p.id, o);
      out.push(o);
    } else if (p?.type === 'reasoning-delta') {
      const o = buffers.get(p.id);
      if (o) o.text += p.delta ?? '';
    } else if (p?.type === 'tool-call') {
      out.push({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
    }
    // everything else ('*-end', 'stream-start', 'response-metadata', 'finish', 'tool-input-*', 'raw',
    // 'error', 'source', 'file') is deliberately NOT part of the v1 mapping — see the module header note.
  }
  return out;
}

/**
 * Reconstructs `useChat`-compatible `UIMessage[]` from a run's journal entries (`journal.readRun(runId)`).
 * Mapping: user/assistant text → `text` parts; assistant tool-call + its resolved tool-result → ONE
 * `tool-${toolName}` part (`state: 'output-available'`, sentinel-masked the SAME way as the live stream
 * — see sentinel-mask.ts); an assistant tool-call with NO tool-result yet → `state: 'input-available'`;
 * reasoning content parts → `reasoning` parts. `tool`-role journal-derived messages are never emitted as
 * their own `UIMessage` — they're merged into the owning assistant message's tool part.
 */
export function toUIMessages(entries: JournalEntry[], opts: ToUIMessagesOptions = {}): UIMessage[] {
  const runId = opts.runId ?? 'run';
  const { messages } = reconstructState(entries, entries.length, opts.seed);

  // Mirrors reconstructState's OWN seed-prepend rule (time-travel.ts) so we know which leading slice of
  // `messages` came from the seed (pre-existing/rolled-over history — no raw provider parts available
  // for it here) vs. which came from actually walking `entries` (and can be paired with a raw `model`
  // journal entry below).
  const seedLen = Array.isArray(opts.seed?.messages) ? opts.seed!.messages!.length : typeof opts.seed?.prompt === 'string' ? 1 : 0;

  const modelEntries = entries.filter((e) => e.kind === 'model');
  let modelIdx = 0;

  // toolCallId -> raw (unmasked) tool-result output. Built once from every 'tool'-role message
  // reconstructState produced — position doesn't matter, toolCallId is unique within a run. A SUSPENDED
  // tool-call still gets an entry here (reconstructState renders a 'tool' message for it too — see
  // time-travel.ts PASS 3 — with `output` being the raw `__gnl_suspend` sentinel), which is exactly what
  // lets the masking below apply to suspended-in-history tool calls, not just live ones.
  const toolOutputs = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const p of (m.content as any[]) ?? []) {
      if (p?.type === 'tool-result') toolOutputs.set(p.toolCallId, p.output);
    }
  }

  const out: UIMessage[] = [];
  messages.forEach((m: any, i: number) => {
    if (m.role === 'tool') return; // merged into the owning assistant message's tool part (see toolOutputs above)
    const id = `${runId}:msg:${i}`;
    if (m.role !== 'assistant') {
      out.push({
        id,
        role: m.role === 'system' ? 'system' : 'user',
        parts: [{ type: 'text', text: textFromContent(m.content) }],
      } as UIMessage);
      return;
    }
    const rawContent = i >= seedLen ? contentFromModelValue(modelEntries[modelIdx++]?.value) : undefined;
    const contentForParts: any[] = rawContent ?? (Array.isArray(m.content) ? m.content : []);
    const parts: UIMessage['parts'] = [];
    for (const p of contentForParts) {
      if (p?.type === 'text' && p.text) {
        parts.push({ type: 'text', text: p.text, state: 'done' });
      } else if (p?.type === 'reasoning' && p.text) {
        parts.push({ type: 'reasoning', text: p.text, state: 'done' });
      } else if (p?.type === 'tool-call') {
        const toolCallId: string = p.toolCallId;
        const toolName: string = p.toolName;
        const input = parseToolInput(p.input);
        if (toolOutputs.has(toolCallId)) {
          const { display } = maskSentinelOutput(toolOutputs.get(toolCallId), toolName);
          parts.push({ type: `tool-${toolName}`, toolCallId, state: 'output-available', input, output: display } as any);
        } else {
          // No tool-result journaled at all yet (still mid-flight — distinct from a SUSPENDED record,
          // which DOES have an entry in `toolOutputs`, see the note above).
          parts.push({ type: `tool-${toolName}`, toolCallId, state: 'input-available', input } as any);
        }
      }
    }
    if (parts.length === 0) parts.push({ type: 'text', text: '', state: 'done' });
    out.push({ id, role: 'assistant', parts } as UIMessage);
  });

  return out;
}

// Re-exported for callers who want to inspect a raw Interrupt shape alongside toUIMessages' output
// (e.g. to render an approval banner keyed by toolCallId) without a separate @gnldev/durable import.
export type { Interrupt };
