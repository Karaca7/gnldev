// FAZ-2 — the approval round-trip, fixed at the CLIENT edge. The failure this closes (heyet kararı
// 1.8): a suspended tool emits a `data-gnl-interrupt`; the user clicks "approve"; a naive client
// Re-POSTs its messages and the route derives a FRESH runId from the new last-message id — the
// Approval lands on a brand-new run, the suspended run stays suspended forever (retention keeps
// Suspended runs deliberately → unbounded accumulation), and the tool never fires. The fix is
// Addressing: an approval must travel with the SUSPENDED run's id (`interrupt.runId`, stamped by
// Ui-stream.ts) and the SAME conversation identity (`body.id`/threadId — a different thread 409s on
// The frozen-input guard).
//
// Two surfaces, by integration style:
//  `approvalPayload(interrupt)`  — pure: the body fields to merge into YOUR request (useChat's
//    `sendMessage(..., { body })`, a custom fetch, a proxy). No I/O, no deps.
//  `approve(endpoint, {...})`    — convenience fetch for headless/manual flows: re-POSTs the SAME
//    Messages + the payload and returns the raw streaming Response (the caller renders/drains it).
//
// Approval is a BUTTON, not prose: the route reads decisions ONLY from `body.approvals`
// (chat-route.ts) — a user typing "yes, do it" into the chat input does NOT approve anything, it
// Starts a fresh turn. Likewise "regenerate" on a completed turn re-POSTs the same runId and gets the
// Journal REPLAY (safe default); genuinely re-running a side effect goes through this approval
// Ladder, never through a silent re-execution.

/** The minimum an approval needs from a `data-gnl-interrupt` entry (see GnlInterruptData). */
export interface ApprovableInterrupt {
  toolCallId: string;
  /** The suspended run's id — REQUIRED to route the approval (older servers that don't stamp it
   *  Can't be addressed reliably; see `approvalPayload`'s throw). */
  runId?: string;
}

/**
 * The body fields that turn a chat POST into an approval of `interrupt`. Merge into the SAME request
 * Shape you normally send (same conversation `id`, same `messages`) — runId precedence in the route
 * Guarantees these fields win over derivation.
 */
export function approvalPayload(
  interrupt: ApprovableInterrupt,
  approved = true,
): { runId: string; approvals: Record<string, boolean> } {
  if (!interrupt.runId) {
    throw new Error(
      '@gnldev/chat-adapter: approvalPayload needs interrupt.runId — this server did not stamp runId onto the interrupt (upgrade the route/ui-stream), and approving by a DERIVED id would target a fresh run instead of the suspended one.',
    );
  }
  return { runId: interrupt.runId, approvals: { [interrupt.toolCallId]: approved } };
}

export interface ApproveOptions {
  interrupt: ApprovableInterrupt;
  /** The SAME UIMessage history the original turn sent — the journal's frozen input wins on replay,
   *  But the route still converts these (and the thread guard needs the same conversation). */
  messages: unknown[];
  /** UseChat's stable conversation id (`body.id`) — REQUIRED when the original turn had one: threadId
   *  Defaults to it, and a mismatched thread is refused with 409 run_thread_mismatch. */
  chatId?: string;
  threadId?: string;
  approved?: boolean;
  headers?: Record<string, string>;
  /** Override for non-global-fetch environments/tests. */
  fetchImpl?: typeof fetch;
}

/** Re-POSTs the approval to the chat endpoint and returns the raw streaming Response. */
export async function approve(endpoint: string, opts: ApproveOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  return doFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify({
      ...(opts.chatId !== undefined ? { id: opts.chatId } : {}),
      ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
      messages: opts.messages,
      ...approvalPayload(opts.interrupt, opts.approved ?? true),
    }),
  });
}
