// CreateChatRoute: a single-endpoint Hono router speaking the Vercel AI SDK v5 `useChat` wire format —
// The ai-sdk-package counterpart of @gnldev/agui's createAguiRoute (AG-UI/CopilotKit) and @gnldev/server's
// PipeAgentStream (GNL's own SSE schema). Converts `UIMessage[]` -> `ModelMessage[]` via `ai`'s
// `convertToModelMessages` (export verified against the installed ai@7 package — tsc compiles this
// Import against its .d.ts), streams the
// Agent via `gnl.stream`, and returns the SENTINEL-MASKED UI message stream response (ui-stream.ts) —
// Never the native, unmasked one.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { createGnl, RunThreadMismatchError, blockedErrorCode, callerConflictCode, upstreamFailure } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';
import { toUIMessageStreamResponse } from './ui-stream.js';

export interface CreateChatRouteOptions {
  /** Resolve the durable `runId` (exactly-once key for THIS request) from the request/body. */
  resolveRunId?: (c: Context, body: any) => string | undefined;
  /** Resolve the conversation `threadId` (memory continuity across requests) from the request/body. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
  /**
   * FAZ-2 — per-run concurrency lock, ON by default (`{ ttlMs: 300_000 }`). Two CONCURRENT requests
   * With the same runId (double-click, two tabs, a retry racing the original) used to BOTH execute;
   * Now the loser gets the typed `409 run_busy` (+ Retry-After) and the winner's journal replay
   * Answers the retry. `lock: false` restores the old behavior. TTL note: a streamed lock does NOT
   * Self-renew (no heartbeat — engine limitation, see StreamDurableArgs.lock), so ttlMs must exceed
   * The WORST-CASE turn duration — a multi-tool agent turn routinely outlives 60s, hence the generous
   * 5-minute default rather than the run() default.
   */
  lock?: { ttlMs?: number } | false;
}

const DEFAULT_LOCK_TTL_MS = 300_000;

let anonCounter = 0;

/**
 * Typed error rendering — the SAME taxonomy as @gnldev/server's route catch (index.ts's
 * threadMismatchResponse / blockedErrorResponse / upstreamErrorResponse), rendered locally because the
 * dependency direction is chat-adapter → durable, never chat-adapter → server. Before this, the catch
 * collapsed EVERYTHING to a flat 400 `{error}` — so a concurrent duplicate of the same runId
 * (RunBusyError, "your run is already in flight — retry later and you'll get the replay") reached the
 * client as "your request was malformed", which tells a retrying client to stop retrying at the exact
 * moment retrying is the right move.
 */
function typedErrorResponse(c: Context, e: unknown): Response | undefined {
  if (e instanceof RunThreadMismatchError || (e as { name?: string })?.name === 'RunThreadMismatchError') {
    const err = e as RunThreadMismatchError;
    // 409 without `resumable`: same runId + this thread never succeeds — see server's rationale.
    return c.json({ error: err.message, code: 'run_thread_mismatch', detail: err.detail }, 409);
  }
  // FAZ-4 caller-conflict family — same 409-without-resumable posture as thread mismatch above.
  // K9: the map is durable's single CALLER_CONFLICT_CODES export (thread mismatch is answered by the
  // Dedicated branch above; its entry here is harmless duplication by design).
  const conflictCode = callerConflictCode(e);
  if (conflictCode && conflictCode !== 'run_thread_mismatch') {
    const err = e as { message?: string; detail?: unknown };
    return c.json({ error: err.message, code: conflictCode, detail: err.detail }, 409);
  }
  const code = blockedErrorCode(e);
  if (code) {
    const err = e as { message?: string; detail?: unknown } | null | undefined;
    const body = { error: err?.message ?? String(e), code, detail: err?.detail };
    if (code === 'retry_limit_exceeded') return c.json(body, 422);
    const res = c.json({ ...body, resumable: true }, 409);
    // Run_busy: another worker holds this runId RIGHT NOW — a short client backoff then the same
    // RunId lands on the journal replay. 5s is a hint, not a lease measurement (the route has no
    // Visibility into the holder's lock TTL).
    if (code === 'run_busy') res.headers.set('Retry-After', '5');
    return res;
  }
  const up = upstreamFailure(e);
  if (up) {
    const err = e as { message?: string } | null | undefined;
    const body = {
      error: err?.message ?? String(e),
      code: up.code,
      ...(up.upstreamStatus !== undefined ? { upstreamStatus: up.upstreamStatus } : {}),
      ...(up.retryAfter !== undefined ? { retryAfter: up.retryAfter } : {}),
    };
    const res = c.json(body, up.status);
    if (up.retryAfter !== undefined) res.headers.set('Retry-After', String(up.retryAfter));
    return res;
  }
  return undefined;
}

/**
 * Produces a single-endpoint Hono router from a createGnl config (or an already-built `gnl` instance)
 * That a `useChat({ api: '.../agents/:name/chat' })` client can talk to:
 * POST /agents/:name/chat   { id?, messages: UIMessage[], runId?, threadId?, approvals? }  → UI message stream
 * Deliberately kept small — SAME posture as @gnldev/agui's `createAguiRoute`: NO auth/org/budget gates (if
 * Needed, wrap this route, or compose @gnldev/server's createRestApi's auth middleware around it — see README).
 *
 * `runId` precedence: `body.runId` > `opts.resolveRunId(...)` > DERIVED `${body.id}:${lastMessage.id}` >
 * A generated id. The derivation is the load-bearing default: `body.id` is useChat's STABLE
 * Per-conversation id — using it ALONE as the runId would make every later turn replay turn 1 from the
 * Journal (withDurableModel replays `runId:model:0` and the model never runs again). Combining it with
 * The LAST message's id (useChat stamps a fresh id per message) gives one exactly-once run PER TURN,
 * And makes a network retry of the SAME turn land on the SAME runId (deduped replay — free idempotency)
 * While a NEW turn gets a fresh run. `threadId` defaults to `body.id` (the conversation), NOT the
 * Per-turn runId — conversation memory must span turns.
 *
 * SCOPE of that idempotency (FAZ-2): serial retries dedupe via journal replay, and CONCURRENT
 * Duplicates are now serialized by the default per-run lock (`CreateChatRouteOptions.lock`) — the
 * Loser gets the typed 409 `run_busy` + Retry-After instead of a second execution. The effective
 * RunId is echoed on every response as `X-Gnl-Run-Id` and stamped onto interrupt chunks.
 */
export function createChatRoute(
  config: CreateGnlConfig | { gnl: ReturnType<typeof createGnl> },
  opts: CreateChatRouteOptions = {},
): Hono {
  const gnl = 'gnl' in config ? config.gnl : createGnl(config);
  const app = new Hono();
  app.post('/agents/:name/chat', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      messages?: UIMessage[];
      runId?: string;
      threadId?: string;
      approvals?: Record<string, boolean>;
      context?: Record<string, unknown>;
    };
    const lastMsg = body.messages?.[body.messages.length - 1];
    // FAZ-2: `Idempotency-Key` header as an OPTIONAL alias — deliberately AFTER body.runId and
    // ResolveRunId (heyet kararı 1.5): the header is often stamped by a gateway/proxy, while
    // Body.runId is an explicit application decision; header-first would let an intermediary silently
    // Change behavior.
    let runId =
      body.runId ??
      opts.resolveRunId?.(c, body) ??
      c.req.header('Idempotency-Key') ??
      (body.id && lastMsg?.id ? `${body.id}:${lastMsg.id}` : undefined);
    if (!runId) {
      // Anon fallback: a fresh id per request = ZERO dedup — a network retry of this exact request
      // Runs the turn again. Deliberately NOT content-hashed (two intentional identical requests must
      // Stay two runs); the fix is the contract, not magic: the response's X-Gnl-Run-Id header hands
      // The client the key to retry with.
      runId = `chat-${Date.now()}-${anonCounter++}`;
      console.warn(
        `[gnl chat-route] no runId derivable (body.runId / resolveRunId / body.id+message.id all absent) — generated '${runId}'. Retries of this request will NOT dedupe; send body.runId (echoed back as X-Gnl-Run-Id) to get exactly-once.`,
      );
    }
    // The conversation id (NOT the per-turn runId) anchors memory — see the runId note in the JSDoc.
    const threadId = opts.resolveThreadId?.(c, body) ?? body.threadId ?? body.id ?? runId;
    // V1: `tools` is not passed to convertToModelMessages — a conversation whose CLIENT-side history
    // Still carries tool-invocation parts from a prior turn round-trips as best-effort (text/reasoning
    // Are unaffected). Fine for the common case (server-side history via toUIMessages + threadId memory
    // Is the durable source of truth); documented rather than silently assumed complete.
    // AWAITED: `convertToModelMessages` is async in AI SDK 7 (it was synchronous in v5). Passing the
    // un-awaited Promise straight through as `messages` sent a Promise into the run — the journal
    // then tried to structuredClone it and every chat request failed with
    // "#<Promise> could not be cloned", i.e. a flat 400 on the whole route.
    // INSIDE the try below: conversion throws on CLIENT-controlled input (a malformed `messages`
    // Shape, an unsupported part type) — outside the try that surfaced as Hono's bare 500 with no
    // Typed body and NO X-Gnl-Run-Id, breaking the every-response header contract on exactly the
    // Malformed-request path. In the catch it falls through typedErrorResponse (no match) to the
    // Generic 400, which is what a malformed request is.
    // FAZ-2 default lock: acquired by streamDurable BEFORE any setup work, released on stream
    // Finish/error — the loser throws RunBusyError synchronously into the catch below (409 run_busy).
    const lock =
      opts.lock === false
        ? undefined
        : { owner: `chat-${crypto.randomUUID()}`, ttlMs: opts.lock?.ttlMs ?? DEFAULT_LOCK_TTL_MS };
    let result: any;
    try {
      const messages = await convertToModelMessages(body.messages ?? []);
      result = await gnl.stream(name, {
        runId,
        messages,
        threadId,
        approvals: body.approvals,
        context: body.context,
        ...(lock ? { lock } : {}),
        // P0.2 thread the REQUEST's AbortSignal through to generation — a client
        // Disconnect (tab close, useChat's `stop()`, navigation away) stops token generation instead of
        // Silently billing to completion. This does NOT break resumable-SSE replay: an abort simply ends
        // Generation early, the journal keeps whatever prefix already completed, and a LATER call with the
        // SAME runId resumes/replays exactly as before (see registry.ts's RunOptions.abortSignal note).
        abortSignal: c.req.raw.signal,
      });
    } catch (e: any) {
      const res = typedErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
      res.headers.set('X-Gnl-Run-Id', runId);
      return res;
    }
    // Every response (success AND error) echoes the effective runId — the client-side retry key is a
    // Contract, not something the caller has to re-derive from useChat internals. The SAME runId is
    // Stamped onto `data-gnl-interrupt` chunks (FAZ-2) so an approval addresses THIS run.
    const res = toUIMessageStreamResponse(result, { runId });
    res.headers.set('X-Gnl-Run-Id', runId);
    return res;
  });
  return app;
}
