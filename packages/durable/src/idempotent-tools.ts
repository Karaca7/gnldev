// `withIdempotency` — LLM-aware idempotency for a PLAIN AI SDK loop.
//
// The exactly-once mechanism already lives in durableTool (args-keyed journal records, the
// claim/poll ladder, cross-run windowing). But today it's reached through runDurable/streamDurable's
// full loop. A developer using bare `generateText`/`streamText` + `tools` (NO runDurable) should be
// able to add "the same arguments never run twice" WITHOUT leaving their own loop.
//
// This is a THIN wrapper, not a re-implementation: each tool is passed to `durableTool` with a MINIMAL
// ctx (`{ journal, runId }` — no `blockedAsSentinel`, no guard/limits/replay) and its tool-level
// idempotency fields (`idempotency: 'args'` + `idempotencyWindow` + optional `idempotencyKey`) are set
// so the EXISTING mode/window resolution in durable-tool.ts picks them up unchanged.
//
// HONEST LIMIT (see README): without loop integration, the blocked/retry/approval ladder THROWS in
// standalone mode (there is no sentinel path — durable-tool.ts's `blockedOrThrow` throws when
// `ctx.blockedAsSentinel` is unset). The happy-path dedup + cross-run single-execution work fully;
// crash-recovery / approval gating still require `runDurable`. This layer gives you "the same argument
// never runs twice", not full durability.
import { durableTool } from './durable-tool.js';
import type { Journal } from './journal.js';
import type { AnyTool, ToolSet } from './types.js';

export interface WithIdempotencyOptions {
  /** The journal that records exactly-once tool outcomes (e.g. `new SqliteStorage(path).runs`, or `new InMemoryJournal()`). */
  journal: Journal;
  /**
   * The dedup window scope. DEFAULT `'cross-run'` — global dedup keyed by arguments, with no runId
   * bookkeeping ("orderId charged once, no matter which call/run it came from"). Use `'run'` to scope
   * dedup to a single `runId` (pass `runId` below).
   */
  window?: 'run' | 'cross-run';
  /**
   * Only meaningful when `window: 'run'` — the run scope for dedup. Defaults to `'ambient'`. In the
   * default `'cross-run'` window the journal key drops the runId prefix entirely, so this is ignored.
   */
  runId?: string;
  /**
   * Optional logical dedup key (e.g. `(_name, args) => (args as any).orderId`). If given, tools dedup
   * by this key instead of the full argument hash — different incidental fields sharing the same
   * logical key collapse to a single execution.
   */
  key?: (toolName: string, args: unknown) => string;
}

/**
 * Wrap a ToolSet so duplicate calls with the SAME arguments (or the same logical `key`) execute their
 * side effect only ONCE — in a plain AI SDK loop, without `runDurable`. See `WithIdempotencyOptions`.
 */
export function withIdempotency<T extends ToolSet>(tools: T, opts: WithIdempotencyOptions): T {
  const window: 'run' | 'cross-run' = opts.window ?? 'cross-run';
  // MINIMAL ctx: journal + runId only. No `blockedAsSentinel` → standalone throw semantics (documented
  // honest limit). runId is irrelevant in the cross-run window (the journal key is runId-free), and
  // scopes dedup in the 'run' window.
  const ctx = { journal: opts.journal, runId: opts.runId ?? 'ambient' };
  const out: Record<string, AnyTool> = {};
  for (const [name, tool] of Object.entries(tools) as [string, AnyTool][]) {
    if (typeof tool.execute !== 'function') {
      out[name] = tool;
      continue;
    }
    // Set the tool-level idempotency fields the EXISTING durable-tool.ts resolution reads (mode/window
    // are computed there from these fields) — this is the mechanism-conformant way, not a ctx side-channel.
    const configured: AnyTool = { ...tool, idempotency: 'args', idempotencyWindow: window };
    if (opts.key) {
      const keyFn = opts.key;
      configured.idempotencyKey = (args: unknown) => keyFn(name, args);
    }
    out[name] = durableTool(configured, ctx, name);
  }
  return out as T;
}
