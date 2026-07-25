// P2 (AUDIT-R2): "TokenLimiter" — a fuller sibling of `tokenLimit` (safety.ts).
// `tokenLimit` keeps only the newest messages that fit the budget (simple sliding window); `tokenLimiter`
// adds a pluggable `countTokens` (same convention as @gnldev/memory's `approxTokens`: char/4 heuristic by
// default), an explicit oldest-first trim strategy that always protects the system message(s) + the
// LAST user message, and an 'error' strategy (ProcessorTripwire) for callers who'd rather fail loudly
// than silently drop context.
import { ProcessorTripwire, recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorCtx, ProcessorInput } from '@gnldev/durable';

export interface TokenLimiterOptions {
  /** Token budget for the whole input (system + messages). */
  maxInputTokens: number;
  /**
   * Token counter (default: the char/4 heuristic, SAME as @gnldev/memory's `approxTokens`). For a real
   * tokenizer, pass e.g. `gpt-tokenizer`/`tokenx`/`js-tiktoken`: `countTokens: (t) => enc.encode(t).length`.
   */
  countTokens?: (text: string) => number;
  /**
   * 'trim-oldest' (default): drops the oldest non-protected messages until under budget.
   * 'error': throws `ProcessorTripwire` instead of trimming — the run stops.
   */
  strategy?: 'trim-oldest' | 'error';
  /**
   * Never drop messages with `role: 'system'` from the `messages` array (default: true). NOTE:
   * `input.system` (the separate system-prompt field) is NEVER trimmed either way — only entries in
   * `messages` are candidates for removal.
   */
  keepSystem?: boolean;
}

/** Default token counter — char/4 heuristic (not a real tokenizer; same approximation as @gnldev/memory's `approxTokens`). */
function approxTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / 4);
}

function msgText(m: any): string {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
  }
  return '';
}

function lastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

/**
 * tokenLimiter — estimates total input tokens (system + messages); over `maxInputTokens`:
 * - 'trim-oldest' (default): drops the OLDEST non-protected messages (index 0 = oldest, matching the
 *   convention used by `tokenLimit`/`toolSearch`) one at a time until under budget or no candidates
 *   remain. Protected (NEVER dropped): `role: 'system'` messages (if `keepSystem`, default true) and
 *   the LAST `role: 'user'` message (a run must always keep the request it's actually answering).
 *   `input.system` (the separate system-prompt field) is never trimmed — if it alone exceeds the
 *   budget, trimming messages cannot help; this is a best-effort trim, not a hard guarantee of
 *   staying under budget.
 * - 'error': throws `ProcessorTripwire` (run stops) instead of trimming anything.
 * Deterministic (pure function of the input + countTokens) → no journaling needed.
 */
export function tokenLimiter(opts: TokenLimiterOptions): Processor {
  const countTokens = opts.countTokens ?? approxTokens;
  const strategy = opts.strategy ?? 'trim-oldest';
  const keepSystem = opts.keepSystem ?? true;

  return {
    name: 'token-limiter',
    // DELIBERATE synchronous (NOT async): same rationale as promptInjectionDetector/moderationProcessor —
    // the 'error' strategy's tripwire must throw SYNCHRONOUSLY. recordProcessorReport is fire-and-forget.
    processInput(input: ProcessorInput, ctx: ProcessorCtx) {
      const messages = input.messages ?? [];
      const systemTokens = typeof input.system === 'string' ? countTokens(input.system) : 0;
      const msgTokens = messages.map((m) => countTokens(msgText(m)));
      const total = systemTokens + msgTokens.reduce((a, b) => a + b, 0);

      if (total <= opts.maxInputTokens) return input;

      if (strategy === 'error') {
        void recordProcessorReport(ctx, 'token-limiter', 'input', { totalTokens: total, maxInputTokens: opts.maxInputTokens });
        throw new ProcessorTripwire(
          `Input exceeds token limit: ~${total} tokens > ${opts.maxInputTokens} max`,
          'token-limiter',
          { totalTokens: total, maxInputTokens: opts.maxInputTokens },
        );
      }

      // 'trim-oldest': system alone over budget → nothing left to trim (input.system is never touched).
      if (!messages.length) return input;

      const lastUser = lastUserIndex(messages);
      const protectedIdx = new Set<number>();
      if (lastUser >= 0) protectedIdx.add(lastUser);
      if (keepSystem) {
        messages.forEach((m, i) => { if (m?.role === 'system') protectedIdx.add(i); });
      }

      const keep = new Array(messages.length).fill(true);
      let remaining = total;
      let droppedCount = 0;
      for (let i = 0; i < messages.length && remaining > opts.maxInputTokens; i++) {
        if (protectedIdx.has(i)) continue;
        keep[i] = false;
        remaining -= msgTokens[i]!;
        droppedCount++;
      }

      if (droppedCount === 0) return input; // everything remaining was protected — nothing droppable
      const kept = messages.filter((_, i) => keep[i]);
      void recordProcessorReport(ctx, 'token-limiter', 'input', {
        droppedCount, totalTokens: total, remainingTokens: remaining, maxInputTokens: opts.maxInputTokens,
      });
      return { ...input, messages: kept };
    },
  };
}
