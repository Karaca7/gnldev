// `withIdempotency` — LLM-aware idempotency for a PLAIN AI SDK loop.
//
// The exactly-once mechanism already lives in durableTool (args-keyed journal records, the
// Claim/poll ladder, cross-run windowing). But today it's reached through runDurable/streamDurable's
// Full loop. A developer using bare `generateText`/`streamText` + `tools` (NO runDurable) should be
// Able to add "the same arguments never run twice" WITHOUT leaving their own loop.
//
// This is a THIN wrapper, not a re-implementation: each tool is passed to `durableTool` with a MINIMAL
// Ctx (`{ journal, runId }` — no `blockedAsSentinel`, no guard/limits/replay) and its tool-level
// Idempotency fields (`idempotency: 'args'` + `idempotencyWindow` + optional `idempotencyKey`) are set
// So the EXISTING mode/window resolution in durable-tool.ts picks them up unchanged.
//
// HONEST LIMIT (see README): without loop integration, the blocked/retry/approval ladder THROWS in
// Standalone mode (there is no sentinel path — durable-tool.ts's `blockedOrThrow` throws when
// `ctx.blockedAsSentinel` is unset). The happy-path dedup + cross-run single-execution work fully;
// Crash-recovery / approval gating still require `runDurable`. This layer gives you "the same argument
// Never runs twice", not full durability.
import { durableTool } from './durable-tool.js';
import { runKeys, type Journal } from './journal.js';
import { argsHash } from './hash.js';
import type { AnyTool, ToolSet } from './types.js';

export interface WithIdempotencyOptions {
  /** The journal that records exactly-once tool outcomes (e.g. `new SqliteStorage(path).runs`, or `new InMemoryJournal()`). */
  journal: Journal;
  /**
   * The dedup window scope. DEFAULT `'cross-run'` — global dedup keyed by arguments, with no runId
   * Bookkeeping ("orderId charged once, no matter which call/run it came from"). Use `'run'` to scope
   * Dedup to a single `runId` (pass `runId` below).
   */
  window?: 'run' | 'cross-run';
  /**
   * Only meaningful when `window: 'run'` — the run scope for dedup. Defaults to `'ambient'`. In the
   * Default `'cross-run'` window the journal key drops the runId prefix entirely, so this is ignored.
   */
  runId?: string;
  /**
   * Optional logical dedup key (e.g. `(_name, args) => (args as any).orderId`). If given, tools dedup
   * By this key instead of the full argument hash — different incidental fields sharing the same
   * Logical key collapse to a single execution.
   */
  key?: (toolName: string, args: unknown) => string;
}

/**
 * Wrap a ToolSet so duplicate calls with the SAME arguments (or the same logical `key`) execute their
 * Side effect only ONCE — in a plain AI SDK loop, without `runDurable`. See `WithIdempotencyOptions`.
 */
export function withIdempotency<T extends ToolSet>(tools: T, opts: WithIdempotencyOptions): T {
  const window: 'run' | 'cross-run' = opts.window ?? 'cross-run';
  // MINIMAL ctx: journal + runId only. No `blockedAsSentinel` → standalone throw semantics (documented
  // Honest limit). runId is irrelevant in the cross-run window (the journal key is runId-free), and
  // Scopes dedup in the 'run' window.
  const ctx = { journal: opts.journal, runId: opts.runId ?? 'ambient' };
  const out: Record<string, AnyTool> = {};
  for (const [name, tool] of Object.entries(tools) as [string, AnyTool][]) {
    if (typeof tool.execute !== 'function') {
      out[name] = tool;
      continue;
    }
    // Set the tool-level idempotency fields the EXISTING durable-tool.ts resolution reads (mode/window
    // Are computed there from these fields) — this is the mechanism-conformant way, not a ctx side-channel.
    const configured: AnyTool = { ...tool, idempotency: 'args', idempotencyWindow: window };
    if (opts.key) {
      const keyFn = opts.key;
      configured.idempotencyKey = (args: unknown) => keyFn(name, args);
    }
    out[name] = durableTool(configured, ctx, name);
  }
  return out as T;
}

/**
 * Let a cross-run claim that FAILED be attempted again.
 *
 * A side-effecting tool that threw is deliberately not retried on its own: the failure may have
 * happened after the charge went through, so retrying could double it. That refusal is correct. What
 * was missing is a way back. In the `cross-run` window the claim key carries no runId, so one transient
 * network blip on order o-1 wrote `{status:'failed'}` under a GLOBAL key and every future attempt, in
 * any run, forever, was refused. The error suggested `approvals[<toolCallId>] = true` — unreachable
 * here: `withIdempotency` runs outside runDurable and has no approvals channel, and the toolCallId in
 * the message is a new one each time. The only documented escape was
 * `journal.deletePrefix('xrun:')`, which discards every cross-run dedup record in the journal to fix
 * one of them.
 *
 * This releases exactly one, and only when it FAILED. A succeeded claim is refused rather than
 * released: that record is the exactly-once guarantee itself, and a helper that could delete it would
 * be a double-charge waiting for a tired operator.
 *
 * Pass the same `args` (and the same `key` function, if the tools were configured with one) that the
 * original call used — the claim is addressed by argument hash, so anything else names a different
 * record.
 */
export async function releaseFailedClaim(
  journal: Journal,
  opts: { toolName: string; args: unknown; key?: (toolName: string, args: unknown) => string },
): Promise<boolean> {
  if (typeof journal.deletePrefix !== 'function') {
    throw new Error(
      '@gnldev/durable: releaseFailedClaim needs a journal with deletePrefix (InMemoryJournal, SqliteStorage, PostgresStorage all have it)',
    );
  }
  const hash = argsHash(opts.key ? opts.key(opts.toolName, opts.args) : opts.args);
  const claimKey = runKeys.toolCrossRun(opts.toolName, hash);
  const rec = await journal.get<{ status?: string }>(claimKey);
  if (rec === undefined) return false; // nothing claimed — releasing is a no-op, not an error
  if (rec?.status !== 'failed') {
    throw new Error(
      `@gnldev/durable: refusing to release '${opts.toolName}' (${claimKey}) — its claim is '${rec?.status}', not 'failed'. ` +
      'Releasing a succeeded claim would let the side effect run a second time.',
    );
  }
  // No single-key delete on the Journal interface. The hash is fixed-width and the key ends with it,
  // so no other key can have this one as a prefix — the range is this record alone.
  await journal.deletePrefix(claimKey);
  return true;
}
