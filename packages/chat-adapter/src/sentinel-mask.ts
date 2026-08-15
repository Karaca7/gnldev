// P0.2 the three INTERNAL sentinels durable-tool.ts returns as a tool's `output`
// (see packages/durable/src/durable-tool.ts + packages/server/src/sse.ts's tool-result handling, which
// This masking is kept IN SYNC with) must NEVER reach a browser useChat client verbatim — they carry
// Internal fields (`detail`, raw guard reasons) that are an INTERNAL API, not a wire contract. This one
// Helper is shared by ui-stream.ts (LIVE stream masking) and messages.ts (HISTORY reconstruction) so the
// Masked shape can't drift between the two call sites.
import type { Interrupt } from '@gnldev/durable';

export interface MaskedToolOutput {
  /** What the client should see in place of the raw tool output — either the untouched original value,
   *  Or a masked `{ pending: 'approval', ... }` / `{ blocked: true, ... }` replacement. */
  display: unknown;
  /** Present only when `display` masked a `__gnl_suspend` sentinel — the raw Interrupt, for the caller
   *  To surface via a `data-gnl-interrupt` chunk (ui-stream.ts) or equivalent. */
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
      return {
        display: { pending: 'approval', toolName: s.toolName ?? toolNameHint, reason: s.reason },
        interrupt: s,
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
