// createChatRoute: a single-endpoint Hono router speaking the Vercel AI SDK v5 `useChat` wire format —
// the ai-sdk-package counterpart of @gnldev/agui's createAguiRoute (AG-UI/CopilotKit) and @gnldev/server's
// pipeAgentStream (GNL's own SSE schema). Converts `UIMessage[]` -> `ModelMessage[]` via `ai`'s
// `convertToModelMessages` (verified export name against the installed ai@5.0.204 package), streams the
// agent via `gnl.stream`, and returns the SENTINEL-MASKED UI message stream response (ui-stream.ts) —
// never the native, unmasked one.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { createGnl } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';
import { toUIMessageStreamResponse } from './ui-stream.js';

export interface CreateChatRouteOptions {
  /** Resolve the durable `runId` (exactly-once key for THIS request) from the request/body. */
  resolveRunId?: (c: Context, body: any) => string | undefined;
  /** Resolve the conversation `threadId` (memory continuity across requests) from the request/body. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
}

let anonCounter = 0;

/**
 * Produces a single-endpoint Hono router from a createGnl config (or an already-built `gnl` instance)
 * that a `useChat({ api: '.../agents/:name/chat' })` client can talk to:
 *   POST /agents/:name/chat   { id?, messages: UIMessage[], runId?, threadId?, approvals? }  → UI message stream
 * Deliberately kept small — SAME posture as @gnldev/agui's `createAguiRoute`: NO auth/org/budget gates (if
 * needed, wrap this route, or compose @gnldev/server's createRestApi's auth middleware around it — see README).
 *
 * `runId` precedence: `body.runId` > `opts.resolveRunId(...)` > DERIVED `${body.id}:${lastMessage.id}` >
 * a generated id. The derivation is the load-bearing default: `body.id` is useChat's STABLE
 * per-conversation id — using it ALONE as the runId would make every later turn replay turn 1 from the
 * journal (withDurableModel replays `runId:model:0` and the model never runs again). Combining it with
 * the LAST message's id (useChat stamps a fresh id per message) gives one exactly-once run PER TURN,
 * and makes a network retry of the SAME turn land on the SAME runId (deduped replay — free idempotency)
 * while a NEW turn gets a fresh run. `threadId` defaults to `body.id` (the conversation), NOT the
 * per-turn runId — conversation memory must span turns.
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
    const runId =
      body.runId ??
      opts.resolveRunId?.(c, body) ??
      (body.id && lastMsg?.id ? `${body.id}:${lastMsg.id}` : undefined) ??
      `chat-${Date.now()}-${anonCounter++}`;
    // The conversation id (NOT the per-turn runId) anchors memory — see the runId note in the JSDoc.
    const threadId = opts.resolveThreadId?.(c, body) ?? body.threadId ?? body.id ?? runId;
    // v1: `tools` is not passed to convertToModelMessages — a conversation whose CLIENT-side history
    // still carries tool-invocation parts from a prior turn round-trips as best-effort (text/reasoning
    // are unaffected). Fine for the common case (server-side history via toUIMessages + threadId memory
    // is the durable source of truth); documented rather than silently assumed complete.
    const messages = convertToModelMessages(body.messages ?? []);
    let result: any;
    try {
      result = await gnl.stream(name, {
        runId,
        messages,
        threadId,
        approvals: body.approvals,
        context: body.context,
        // P0.2 (AUDIT-R2): thread the REQUEST's AbortSignal through to generation — a client
        // disconnect (tab close, useChat's `stop()`, navigation away) stops token generation instead of
        // silently billing to completion. This does NOT break resumable-SSE replay: an abort simply ends
        // generation early, the journal keeps whatever prefix already completed, and a LATER call with the
        // SAME runId resumes/replays exactly as before (see registry.ts's RunOptions.abortSignal note).
        abortSignal: c.req.raw.signal,
      });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    return toUIMessageStreamResponse(result);
  });
  return app;
}
