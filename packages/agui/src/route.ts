// pipeAguiStream: the AG-UI-output counterpart of @gnldev/server's pipeAgentStream. Streams fullStream (AI SDK
// StreamTextResult) as SSE, but instead of writing GNL's own event/data schema, converts it via toAguiEvents
// and writes AG-UI events. createAguiRoute: a small single-endpoint (POST /agents/:name/run) factory —
// an endpoint that CopilotKit's AG-UI HttpAgent can POST to.
//
// NOTE (deliberate choice — don't break the architecture): the switch that converts fullStream parts to the
// GNL event/data shape is copied from INSIDE pipeAgentStream in packages/server/src/sse.ts (there is no
// exported hook). sse.ts is a sensitive file carrying the W3 resumable-id contract and locked in by
// process-kill/exactly-once tests — rather than adding a "sink" parameter there, keeping a small,
// independent copy here is safer (without touching the existing architecture). The event/data shape of the
// two copies must be kept in sync with sse.ts; see test/route.test.ts (parallel tests with the same mock patterns).
import type { Context } from 'hono';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { Hono } from 'hono';
import { limitBreachFromSteps, blockedFromSteps, BLOCKED_ERROR_CODES } from '@gnldev/durable';
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
  // helper across packages resolves through that package's BUILT output, and a stale dist turns the
  // call into `undefined` — measured, this exact swap emptied the stream and every test here failed
  // on `JSON.parse('')`. Six lines of duplication beats a build-order dependency.
  //
  // Why the headers: Hono sets `Cache-Control: no-cache`, which says nothing about re-encoding, so a
  // compression middleware in the host's chain buffers the stream into one chunk delivered at the
  // end (measured on Express: 13 progressive chunks became 1). `no-transform` stops it;
  // `X-Accel-Buffering: no` is the nginx half — measured behind a real one: inert when the proxy
  // does not gzip, and the difference between a live screen and a frozen one when it does.
  // Kept IN SYNC with packages/server/src/sse.ts and packages/studio/src/sse.ts.
  const res = streamSSE(c, async (stream) => {
    // In AG-UI every SSE frame is a single JSON event; the type is inside the event JSON (the spec has
    // no event/data split of its own) → the SSE `event:` field is NOT USED, only `data:` is written.
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
          // tool-input/source/file/step/tool-error events + the raw marker; nothing silently dropped.
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
      if (interrupts.length) await emit({ event: 'interrupt', data: { interrupts } });
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
 *   POST /agents/:name/run   {runId, prompt|messages, threadId?, approvals?}  → AG-UI SSE
 * Deliberately kept small: NO auth/org/budget gates (if needed, use @gnldev/server's createRestApi
 * and pass its stream result to pipeAguiStream — see README).
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
