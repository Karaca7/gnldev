// P0.2 the three INTERNAL sentinels durable-tool.ts returns as a tool's `output`
// (see packages/durable/src/durable-tool.ts + packages/server/src/sse.ts's tool-result handling, which
// This masking is kept IN SYNC with) must NEVER reach a browser useChat client verbatim — they carry
// Internal fields (`detail`, raw guard reasons) that are an INTERNAL API, not a wire contract. This one
// Helper is shared by ui-stream.ts (LIVE stream masking) and messages.ts (HISTORY reconstruction) so the
// Masked shape can't drift between the two call sites.
import { surfacedInterrupts } from '@gnldev/durable';
import type { Interrupt } from '@gnldev/durable';

export interface MaskedToolOutput {
  /** What the client should see in place of the raw tool output — either the untouched original value,
   *  Or a masked `{ pending: 'approval', ... }` / `{ blocked: true, ... }` replacement. */
  display: unknown;
  /**
   * Present only when `display` masked a `__gnl_suspend` sentinel — the question(s) a human can
   * actually answer, for the caller to surface via a `data-gnl-interrupt` chunk (ui-stream.ts) or
   * equivalent.
   *
   * A LIST, and the singular it replaces was not a style choice — it was structurally short. When a
   * delegated sub-agent hits a human gate, the PARENT's record suspends too, and that sentinel is
   * necessarily keyed by the parent's toolCallId: a proxy id with no question behind it. The engine
   * answers this in one place (`surfacedInterrupts`) by surfacing the CHILD's interrupts instead —
   * and a child run can be sitting on more than one. Handing back the first and dropping the rest
   * would leave a client that approved everything it was shown still suspended.
   *
   * Ordinary suspends are unaffected: one interrupt in, a one-element array out, same fields.
   */
  interrupts?: Interrupt[];
  /**
   * @deprecated Use `interrupts`. Kept because this field shipped, and filled with `interrupts[0]`
   * so existing readers keep working — but it CANNOT represent a nested suspend carrying more than
   * one child question, which is the reason `interrupts` exists. Reading it is reading the first
   * question and silently ignoring the others.
   */
  interrupt?: Interrupt;
}

/**
 * Masks a tool-result `output` value if (and only if) it carries one of the three sentinels; passes
 * Everything else through UNCHANGED. `toolNameHint` backfills `toolName` for a suspend sentinel that
 * (in older journal records) might not carry its own `toolName` field.
 */
export function maskSentinelOutput(output: unknown, toolNameHint?: string): MaskedToolOutput {
  const o = output as Record<string, unknown> | null | undefined;
  if (o && typeof o === 'object') {
    if (o.__gnl_suspend) {
      const s = o.__gnl_suspend as Interrupt;
      // `display` still describes THIS chunk — its toolCallId is the suspended tool's, so the name and
      // reason shown next to it are that tool's, proxy or not. Only the answerable ids are unwrapped,
      // and by the engine's own function rather than a fourth private copy of the rule.
      const interrupts = surfacedInterrupts(s);
      return {
        display: { pending: 'approval', toolName: s.toolName ?? toolNameHint, reason: s.reason },
        interrupts,
        ...(interrupts[0] ? { interrupt: interrupts[0] } : {}), // deprecated single — see MaskedToolOutput
      };
    }
    if (o.__gnl_limit_exceeded) {
      const s = o.__gnl_limit_exceeded as { kind: string; message: string };
      return { display: { blocked: true, code: s.kind, message: s.message } };
    }
    if (o.__gnl_blocked) {
      const s = o.__gnl_blocked as { code: string; message: string };
      return { display: { blocked: true, code: s.code, message: s.message } };
    }
  }
  return { display: output };
}
