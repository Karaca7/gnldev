// The one place that knows the AI SDK's value shapes changed between majors.
//
// DELIBERATELY INTERNAL: not exported from index.ts, not a package. The seam exists to keep shape
// knowledge out of the engine, not to offer an abstraction to users — `tool()`, `generateText` and
// the model types stay Vercel's, because gnl DECORATES the SDK rather than wrapping it (see
// gnlTool in types.ts, and the README's opening example, which imports `tool` from 'ai' directly).
// If a second SDK ever genuinely arrives, this file is what gets extracted; designing that package
// today would mean guessing the requirement.
//
// SCOPE — read carefully, the split is the point:
//
//   format.ts  owns records ON DISK. A journal written by an older gnl is converted ONCE, at read
//              time, through a versioned upgrader chain. That is where v5→v7 record migration lives.
//
//   THIS FILE  owns values IN FLIGHT that never became a versioned record, or that a caller needs
//              as a scalar: OTel span attributes, a `=== 'error'` comparison, a system prompt about
//              to be concatenated. These cannot go through format.ts because they are not records.
//
// Every helper here is tolerant of BOTH shapes on purpose: during a rolling deploy one process may
// hold an old in-memory value while another writes the new one, and a suspended run resumed after
// an upgrade carries whatever it carried. Tolerance here is bounded and explicit; tolerance in the
// engine is how four separate breaks went unnoticed under `any`.

/** Token counts, flattened, from either AI SDK usage shape. */
export interface FlatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached input tokens, when the provider reports them. */
  cachedTokens: number;
  totalTokens: number;
}

/**
 * AI SDK 7 restructured usage: the flat `{inputTokens, outputTokens, totalTokens}` of the v2 spec
 * became `{inputTokens: {total, noCache, cacheRead, cacheWrite}, outputTokens: {total, text,
 * reasoning}}` — with no top-level total at all.
 *
 * Reading the old fields off a v7 object yields `undefined`, which `?? 0` turns into a free run:
 * cost stays zero, token counters never move, and every `maxTokens`/`maxCostUsd` ceiling silently
 * stops firing. Nothing throws. For a spend guard that is the worst possible failure mode, and it
 * is exactly what happened — `run-limits` tests went from red to green-for-the-wrong-reason.
 *
 * NOTE the cached-token field name. gnl read `usage.cachedTokens` (cost.ts, pricing.ts); no AI SDK
 * version has ever had that field — v2 called it `cachedInputTokens`, v4 nests it as
 * `inputTokens.cacheRead`. The cache discount therefore never applied on any real provider, on any
 * version. That bug predates this migration and is fixed here.
 */
export function flattenUsage(usage: unknown): FlatUsage {
  const u = usage as any;
  const nested = u?.inputTokens !== null && typeof u?.inputTokens === 'object';
  const inputTokens = (nested ? u.inputTokens?.total : u?.inputTokens) ?? 0;
  const outputTokens = (nested ? u.outputTokens?.total : u?.outputTokens) ?? 0;
  const cachedTokens = (nested ? u.inputTokens?.cacheRead : u?.cachedInputTokens ?? u?.cachedTokens) ?? 0;
  const totalTokens = u?.totalTokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

/**
 * The finish reason as a string.
 *
 * AI SDK 7 turned this into `{ raw, unified }` — the provider's own word plus the SDK's normalised
 * one. Two consequences, neither type-visible because the value travels through `any`:
 * a span attribute typed as a string receives an object, and `finishReason === 'error'` becomes
 * permanently false — so a run that ended in an error is recorded as having SUCCEEDED.
 */
export function finishReasonText(reason: unknown): string | undefined {
  if (reason == null) return undefined;
  if (typeof reason === 'string') return reason;
  const r = reason as { unified?: unknown; raw?: unknown };
  return typeof r.unified === 'string' ? r.unified : typeof r.raw === 'string' ? r.raw : undefined;
}

/** A system message as it may arrive from AI SDK 7 (`Instructions`). */
export type SystemMessageLike = { role: 'system'; content: string };
export type InstructionsLike = string | SystemMessageLike | Array<SystemMessageLike>;

/**
 * The system prompt as text.
 *
 * AI SDK 7 widened `system` from `string` to `Instructions`. Memory and working-memory injection
 * APPEND to the system prompt with `[system, extra].join('\n\n')`; once `system` can be an object,
 * that join yields "[object Object]\n\n# Working Memory…" — the caller's instructions silently
 * replaced by a stringified object, with no error anywhere.
 */
export function systemText(s: InstructionsLike | undefined): string {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.map((m) => m?.content ?? '').filter(Boolean).join('\n\n');
  return s.content ?? '';
}

/**
 * Every message the turn produced, across all steps.
 *
 * AI SDK 7 narrowed `result.response.messages` to the FINAL step's messages. gnl persisted that to
 * thread memory, so a turn that called tools stored only the closing assistant text: the tool-call
 * and tool-result messages vanished from history, and the next turn showed the model a conversation
 * in which it had never used a tool. Silent, and it corrupts memory rather than crashing.
 *
 * Steps carry the full sequence, so read from there when present and fall back to the old field —
 * a journal or an SDK that only offers `response.messages` still works.
 */
export function producedMessages(result: unknown): any[] {
  const r = result as any;
  const steps = r?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    const all = steps.flatMap((s: any) => s?.response?.messages ?? []);
    if (all.length > 0) return all;
  }
  return r?.response?.messages ?? [];
}
