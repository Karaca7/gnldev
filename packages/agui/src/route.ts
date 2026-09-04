// PipeAguiStream: the AG-UI-output counterpart of @gnldev/server's pipeAgentStream. Streams fullStream (AI SDK
// StreamTextResult) as SSE, but instead of writing GNL's own event/data schema, converts it via toAguiEvents
// And writes AG-UI events. createAguiRoute: a small single-endpoint (POST /agents/:name/run) factory —
// An endpoint that CopilotKit's AG-UI HttpAgent can POST to.
//
// NOTE (deliberate choice — don't break the architecture): the switch that converts fullStream parts to the
// GNL event/data shape is copied from INSIDE pipeAgentStream in packages/server/src/sse.ts (there is no
// Exported hook). sse.ts is a sensitive file carrying the W3 resumable-id contract and locked in by
// Process-kill/exactly-once tests — rather than adding a "sink" parameter there, keeping a small,
// Independent copy here is safer (without touching the existing architecture). The event/data shape of the
// Two copies must be kept in sync with sse.ts; see test/route.test.ts (parallel tests with the same mock patterns).
import type { Context } from 'hono';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { Hono } from 'hono';
import { limitBreachFromSteps, blockedFromSteps, BLOCKED_ERROR_CODES, blockedErrorCode } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';
import { createGnl } from '@gnldev/durable';
import { streamSSE } from 'hono/streaming';
import { interruptsFromSteps } from '@gnldev/server';
import { toAguiEvents, initialAguiConvertState, type GnlSseEvent } from './convert.js';
import { EventType, type AguiEvent, type RunStartedEvent } from './types.js';

export interface PipeAguiStreamOptions {
  /** AG-UI threadId. If not given, runId is used (single-thread default). */
  threadId?: string;
}

/** Stream fullStream as AG-UI SSE events (starts with RUN_STARTED, ends with RUN_FINISHED/RUN_ERROR). */
export function pipeAguiStream(c: Context, runId: string, result: any, opts?: PipeAguiStreamOptions) {
  const threadId = opts?.threadId ?? runId;
  const ctx = { threadId, runId };
  // The header patch, written out rather than imported from @gnldev/server: importing a runtime
  // Helper across packages resolves through that package's BUILT output, and a stale dist turns the
  // Call into `undefined` — measured, this exact swap emptied the stream and every test here failed
  // On `JSON.parse('')`. Six lines of duplication beats a build-order dependency.
  //
  // Why the headers: Hono sets `Cache-Control: no-cache`, which says nothing about re-encoding, so a
  // Compression middleware in the host's chain buffers the stream into one chunk delivered at the
  // End (measured on Express: 13 progressive chunks became 1). `no-transform` stops it;
  // `X-Accel-Buffering: no` is the nginx half — measured behind a real one: load-bearing exactly
  // When the client speaks HTTP/1.1 to a gzipping proxy (without it the stream collapses into one
  // Chunk at the end), and inert otherwise, HTTP/2 included.
  // Kept IN SYNC with packages/server/src/sse.ts and packages/studio/src/sse.ts.
  const res = streamSSE(c, async (stream) => {
    // In AG-UI every SSE frame is a single JSON event; the type is inside the event JSON (the spec has
    // No event/data split of its own) → the SSE `event:` field is NOT USED, only `data:` is written.
    const write = async (event: AguiEvent) => {
      await stream.writeSSE({ data: JSON.stringify(event) });
    };
    let state = initialAguiConvertState;
    const emit = async (gnlEvent: GnlSseEvent) => {
      const out = toAguiEvents(gnlEvent, ctx, state);
      state = out.state;
      for (const e of out.events) await write(e);
    };
    const started: RunStartedEvent = { type: EventType.RUN_STARTED, threadId, runId };
    await write(started);
    try {
      for await (const part of result.fullStream) {
        if (stream.aborted) break;
        switch (part.type) {
          case 'text-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit({ event: 'text-delta', data: { text } });
            break;
          }
          case 'tool-call':
            await emit({ event: 'tool-call', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } });
            break;
          case 'tool-result':
            if (part.output?.__gnl_suspend) break; // suspend sentinel is carried by the interrupt event
            if (part.output?.__gnl_limit_exceeded) break; // INTERNAL API sentinel — does not leak, carried by the error event
            if (part.output?.__gnl_blocked) break; // K1: the block sentinel is also an INTERNAL API — carried by the error event
            await emit({ event: 'tool-result', data: { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } });
            break;
          // P0.1: kept IN SYNC with sse.ts (see the sync note at the top of this file) — reasoning/
          // Tool-input/source/file/step/tool-error events + the raw marker; nothing silently dropped.
          case 'reasoning-start':
            await emit({ event: 'reasoning-start', data: { id: part.id } });
            break;
          case 'reasoning-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit({ event: 'reasoning-delta', data: { id: part.id, text } });
            break;
          }
          case 'reasoning-end':
            await emit({ event: 'reasoning-end', data: { id: part.id } });
            break;
          case 'tool-input-start':
            await emit({ event: 'tool-input-start', data: { toolCallId: part.toolCallId ?? part.id, toolName: part.toolName } });
            break;
          case 'tool-input-delta':
            await emit({ event: 'tool-input-delta', data: { toolCallId: part.toolCallId ?? part.id, delta: part.delta } });
            break;
          case 'tool-input-end':
            await emit({ event: 'tool-input-end', data: { toolCallId: part.toolCallId ?? part.id } });
            break;
          case 'source':
            await emit({ event: 'source', data: { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title } });
            break;
          case 'file':
            await emit({ event: 'file', data: { mediaType: part.file?.mediaType, base64: part.file?.base64 } });
            break;
          case 'start-step':
            await emit({ event: 'step-start', data: {} });
            break;
          case 'finish-step':
            await emit({ event: 'step-finish', data: { finishReason: part.finishReason, usage: part.usage } });
            break;
          case 'tool-error':
            await emit({ event: 'tool-error', data: { toolCallId: part.toolCallId, toolName: part.toolName, error: String((part as any).error?.message ?? (part as any).error) } });
            break;
          case 'error':
            await emit({ event: 'error', data: { error: String((part as any).error?.message ?? (part as any).error) } });
            break;
          case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw':
            break; // deliberately no event — same list and reasons as sse.ts
          default:
            await emit({ event: 'raw', data: { type: part.type } }); // unknown part → type-only marker, never silent
            break;
        }
      }
      const steps = await result.steps;
      const breach = limitBreachFromSteps(steps);
      if (breach) {
        await emit({
          event: 'error',
          data: {
            error: breach.message,
            code: breach.kind === 'loop' ? 'tool_loop_detected' : 'run_limit_exceeded',
            detail: breach.detail,
          },
        });
        return;
      }
      // K1: the block sentinel (side-effect/retry/busy) → same contract as a limit breach: terminal error, no done.
      const blocked = blockedFromSteps(steps);
      if (blocked) {
        await emit({ event: 'error', data: { error: blocked.message, code: BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy', detail: blocked.detail } });
        return;
      }
      const interrupts = interruptsFromSteps(steps);
      // FAZ-2 (chat-adapter parity): the approval ADDRESS travels with the interrupt — a client that
      // Resumes without this runId starts a fresh run and the suspended one leaks forever. Parity is
      // Measured by SCHEMA POSITION, not field name: chat-adapter stamps runId INSIDE each record
      // (ui-stream.ts), so a shared client helper (approvalPayload) must find it there on BOTH
      // Adapters — the envelope copy stays for consumers already reading it.
      if (interrupts.length) await emit({ event: 'interrupt', data: { interrupts: interrupts.map((i) => ({ ...i, runId })), runId } });
      const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      await emit({ event: 'done', data: { runId, finishReason, usage } });
    } catch (e: any) {
      await emit({ event: 'error', data: { error: String(e?.message ?? e) } });
    }
  });
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
}

export interface CreateAguiRouteOptions {
  /** AG-UI threadId resolver (from request + body). If not given, uses body.threadId, else runId. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
}

/**
 * Produces a single-endpoint Hono router from a createGnl config that CopilotKit's AG-UI HttpAgent can talk to:
 * POST /agents/:name/run   {runId, prompt|messages, threadId?, approvals?}  → AG-UI SSE
 * Deliberately kept small: NO auth/org/budget gates (if needed, use @gnldev/server's createRestApi
 * And pass its stream result to pipeAguiStream — see README).
 */
function aguiRouteApp(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): Hono {
  const gnl = createGnl(config);
  const app = new Hono();
  app.post('/agents/:name/run', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (!body.runId) return c.json({ error: 'runId is required (idempotency key)' }, 400);
    const threadId = opts.resolveThreadId?.(c, body) ?? body.threadId ?? body.runId;
    let result: any;
    try {
      result = await gnl.stream(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: body.context,
      });
    } catch (e: any) {
      // A refusal thrown BEFORE the stream exists is still one of ours, and it used to arrive as a bare
      // 400 with the reason flattened into prose. `streamDurable` asserts thread ownership and takes the
      // run lock before it returns anything, so `RunThreadMismatchError`, `RunBusyError`,
      // `SideEffectRetryBlockedError` and `RetryLimitExceededError` all land here — the same errors
      // @gnldev/server answers with a status and a `code`. A client talking to this route had to match
      // on the sentence instead, which is the practice the typed errors exist to end.
      //
      // Errors raised MID-stream are a different contract and are untouched: once frames are flowing
      // they surface as an SSE `error` event (see pipeAguiStream), because a response already committed to
      // 200 cannot become a 409.
      const name = (e as { name?: string })?.name;
      if (name === 'RunThreadMismatchError') {
        return c.json({ error: e.message, code: 'run_thread_mismatch', detail: e.detail }, 409);
      }
      const blocked = blockedErrorCode(e);
      if (blocked) {
        const body = { error: e?.message ?? String(e), code: blocked, detail: e?.detail };
        return blocked === 'retry_limit_exceeded'
          ? c.json(body, 422)
          : c.json({ ...body, resumable: true }, 409);
      }
      if (name === 'RunLimitExceededError' || name === 'ToolLoopDetectedError') {
        const code = name === 'RunLimitExceededError' ? 'run_limit_exceeded' : 'tool_loop_detected';
        return c.json({ error: e.message, code, detail: e.detail, resumable: true }, 422);
      }
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    return pipeAguiStream(c, body.runId, result, { threadId });
  });
  return app;
}

/** The AG-UI route as a fetch handler — mount with `app.mount(path, ...)` on a Hono host. */
export function createAguiRoute(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): FetchHandler {
  return toFetchHandler(aguiRouteApp(config, opts));
}
