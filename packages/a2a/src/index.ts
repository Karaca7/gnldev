// @gnldev/a2a — remote agent-to-agent. createAgentTool is in-process; this one calls a REMOTE agent (a @gnldev/server
// REST endpoint) as an AI SDK tool. **Exactly-once across the network:** runId is deterministic
// (`a2a:<idempotencyKey ?? toolCallId>`) → the remote runDurable replays the same runId (a second POST has no
// side effect). When wrapped in durableTool inside a parent runDurable, the parent also journals it → on parent
// resume, the remote call is SKIPPED.
import { tool } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import { createHmac } from 'node:crypto';

export interface A2AToolOptions {
  /** Remote @gnldev/server base URL (e.g. 'https://host'). */
  endpoint: string;
  /** Remote agent name (REST: POST /agents/<name>/run). */
  agentName: string;
  description?: string;
  /** Inject fetch for test/custom transport (e.g. hono app.request). Otherwise global fetch. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Remote call timeout (ms). Default 30_000. On timeout a StepTimeoutError-shaped error is
   *  thrown — the wrapping durableTool writes a 'failed' record, the model sees the real error. */
  timeoutMs?: number;
  /**
   * TASK (audit: A2A unsigned) — opt-in HMAC-SHA256 signing. When provided, the request body is
   * sent with a hex signature in the `x-gnl-signature` header: signature = HMAC(secret, timestamp + '.' + body),
   * `x-gnl-timestamp` (epoch-ms) is also included to be part of the replay window. Verified on the
   * remote `@gnldev/server` side via `createRestApi({ a2aSecret })`. If not provided, behavior is
   * UNCHANGED (unsigned request, current behavior).
   */
  secret?: string;
  /**
   * 1.4 — optional budget/quota hook: called BEFORE the remote call (before fetch). On overage
   * it throws (typically `@gnldev/durable`'s `assertBudget` — the caller side's/LOCAL quota; a2a
   * does not know/enforce the remote endpoint's own quota, it only gates the call made FROM this process).
   * The thrown error propagates upward as-is (same pattern as K3 — durableTool writes 'failed',
   * the model sees the real error). IF NOT PROVIDED (default), behavior is UNCHANGED — NO quota check.
   * Kept simple: a2a does NOT embed the quota itself, the host injects it. Example:
   *   budgetGuard: () => assertBudget(journal, { orgId, fallback })
   */
  budgetGuard?: (ctx: { agentName: string; task: string; runId: string }) => Promise<unknown> | unknown;
}

/**
 * K3/timeout — an ALIGNED but INDEPENDENT local definition matching `@gnldev/durable`'s `StepTimeoutError`
 * contract (name='StepTimeoutError', detail:{label,timeoutMs}): in @gnldev/a2a's package.json,
 * @gnldev/durable is only a devDependency (for tests) — NOT a runtime dependency/peerDependency
 * (see peerDependencies: only 'ai'/'zod'). Hence, instead of importing it, this class with the same
 * name/shape is defined here: when wrapped (with durableTool) inside runDurable, the H9 recovery
 * ladder recognizes it the same way via `err.name === 'StepTimeoutError'`, but the a2a package has
 * no runtime dependency on durable.
 */
export class StepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly detail: { label: string; timeoutMs: number },
  ) {
    super(message);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Exposes a remote agent as a tool. The router/parent agent calls it with `task`; the tool POSTs to the
 * remote `/agents/:name/run` (with deterministic runId) and returns the result. Durable when used within
 * `@gnldev/durable`'s `runDurable`.
 */
/** What the remote agent answered, as this tool reports it. */
export interface A2AResult {
  text: string;
  interrupts: unknown;
  /** The deterministic runId the remote replayed under — the exactly-once handle across the network. */
  runId: string;
  remoteAgent: string;
}

// Declared, not inferred (TS2742): inference would name a pnpm-internal provider-utils path in the
// emitted .d.ts. `Tool` comes from `ai`, which this package already requires as a peer.
export function createA2ATool(opts: A2AToolOptions): Tool<{ task: string }, A2AResult> & { idempotent: boolean } {
  const doFetch = opts.fetchImpl ?? fetch;
  // H7: the remote side replays the same deterministic runId (exactly-once across the network) →
  // a repeat POST has no side effect → idempotent. The runId is derived from
  // `options.idempotencyKey` (parent-run-scoped, globally unique — see durableTool) when available,
  // falling back to the raw `toolCallId` otherwise, which is only unique WITHIN a single run: if this
  // tool is called from a bare AI SDK loop (no durableTool/idempotencyKey) AND two different runs
  // happen to reuse the same toolCallId, their remote runIds would collide and the second call would
  // incorrectly replay the first call's journaled result.
  return Object.assign(tool({
    description: opts.description ?? `Delegate a task to remote '${opts.agentName}' agent (A2A)`,
    inputSchema: z.object({ task: z.string().describe('task/question to give to the remote agent') }),
    execute: async ({ task }, options: any) => {
      // runId collision fix: raw `toolCallId` is only unique WITHIN its own run — two DIFFERENT
      // parent runs can produce the SAME toolCallId (some providers use short ids like 'call_1'),
      // which would make the remote side replay the FIRST run's journaled result for the SECOND
      // call (wrong result leaking across runs). @gnldev/durable's durableTool injects
      // `options.idempotencyKey` (`${parentRunId}:${toolCallId}` in 'call' mode,
      // `${parentRunId}:${toolName}:${hash}` in 'args' mode) — parent-run-scoped and globally
      // unique — so prefer it when present (always the case when reached via runDurable).
      // Fallback to raw toolCallId ONLY when the tool is used directly in a bare AI SDK loop
      // (no durableTool wrapper, no idempotencyKey) — in that case the collision risk above still
      // applies and is the caller's responsibility to avoid (e.g. by ensuring toolCallId uniqueness).
      const runId = `a2a:${options?.idempotencyKey ?? options?.toolCallId}`; // deterministic → remote idempotent
      // 1.4: budget/quota hook (optional) — checked BEFORE the remote fetch is called; on overage
      // the thrown error passes upward as-is (K3: no silent failure).
      if (opts.budgetGuard) await opts.budgetGuard({ agentName: opts.agentName, task, runId });
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const bodyStr = JSON.stringify({ runId, prompt: task });
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
      if (opts.secret) {
        // signature = HMAC(secret, timestamp + '.' + body) → the server side (a2aSecret) verifies with the SAME formula.
        const timestamp = String(Date.now());
        headers['x-gnl-timestamp'] = timestamp;
        headers['x-gnl-signature'] = createHmac('sha256', opts.secret).update(`${timestamp}.${bodyStr}`).digest('hex');
      }
      let res: Response;
      try {
        res = await doFetch(`${opts.endpoint}/agents/${opts.agentName}/run`, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) {
        // K3: no silent failure — convert the timeout into an error aligned with @gnldev/durable's
        // StepTimeoutError contract (name='StepTimeoutError'), rethrow the rest as-is.
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
          throw new StepTimeoutError(
            `A2A call timed out (${timeoutMs}ms): remote '${opts.agentName}' agent did not respond`,
            { label: `a2a:${opts.agentName}`, timeoutMs },
          );
        throw e;
      }
      if (!res.ok) {
        // K3: non-2xx response → throw an error (durableTool writes 'failed', the model sees the real error).
        const bodyText = await res.text().catch(() => '');
        let detail = bodyText;
        try { detail = String(JSON.parse(bodyText)?.error ?? bodyText); } catch { /* if not JSON, keep as text */ }
        throw new Error(`Remote agent '${opts.agentName}' returned an error (HTTP ${res.status}): ${detail.slice(0, 200)}`);
      }
      const json: any = await res.json().catch(() => null);
      // Shape check: 'text' must be a string; in an interrupted run text may be empty but 'interrupts' comes populated.
      if (!json || (typeof json.text !== 'string' && !(Array.isArray(json.interrupts) && json.interrupts.length > 0)))
        throw new Error(`Remote agent '${opts.agentName}' response does not match expected shape (no 'text' field)`);
      return { text: json.text, interrupts: json.interrupts, runId, remoteAgent: opts.agentName };
    },
  }), { idempotent: true });
}
