// Pumps the streamDurable result (AI SDK StreamTextResult) into SSE.
// Schema (event → JSON data):
//   text-delta {text} · tool-call {toolCallId,toolName,input} · tool-result {toolCallId,toolName,output}
//   reasoning-start {id} · reasoning-delta {id,text} · reasoning-end {id}         (P0.1: thinking models)
//   tool-input-start {toolCallId,toolName} · tool-input-delta {toolCallId,delta} · tool-input-end {toolCallId}
//   source {sourceType,id,url,title} · file {mediaType,base64} · step-start {} · step-finish {finishReason,usage}
//   tool-error {toolCallId,toolName,error} (NON-terminal — the loop may continue; distinct from `error`)
//   raw {type} (unrecognized part marker — see the default case) · error {error} (terminal)
//   interrupt {interrupts[]} (derived when the stream ends) · done {runId,finishReason,usage}
// The same schema is also used in the @gnldev/studio playground → @gnldev/client can connect to either endpoint.
//
// P0.1 (AUDIT-R2): the old switch knew only 4 part types and had NO default — every
// reasoning-*/source/file/step-*/tool-input-* part from the AI SDK fullStream was SILENTLY DROPPED
// (a reasoning model's entire thinking trace vanished with no error). Now every known part has a case,
// a few are DELIBERATELY not events ('start'/'finish' → covered by done; 'text-start'/'text-end' → the
// schema's text framing is delta-only; 'abort'/'raw' → transport-internal), and anything else emits a
// `raw {type}` marker (type only, payload withheld — future/unknown parts can never silently vanish
// again, and can never leak internal payloads either).
//
// GOREV W3 — RESUMABLE SSE: a deterministic, increasing `id:` starting from 0 is attached to every written event
// (the SSE `id:` field — see https://html.spec.whatwg.org/multipage/server-sent-events.html). Calling the
// stream AGAIN with the same runId is deterministic journal replay (withDurableModel/durableTools
// read from the journal, model/tool do NOT actually re-run) → fullStream produces the same sequence of
// parts, so the emitted event sequence (and its ids) is also IDENTICAL from start to finish. That's why
// id numbering needs no EXTRA state — it's just a "which event number is this" counter.
//
// Client disconnect-recovery: the browser's EventSource automatically sends the last `id:` it saw via
// the `Last-Event-ID` header when reconnecting (spec behavior). If `lastEventId` is given to
// `pipeAgentStream`, events with id <= lastEventId are still PRODUCED (fullStream still runs from the
// start — replay is cheap, no model/tool call) but are NOT WRITTEN TO THE CLIENT; only those with id >
// lastEventId are sent. This is opt-in behavior: if lastEventId isn't given (existing callers), all
// events are written — behavior stays identical apart from the addition of id (existing sse.test.ts
// assertions look at the event/data fields, they don't care about id).
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { limitBreachFromSteps, blockedFromSteps, BLOCKED_ERROR_CODES } from '@gnldev/durable';
import type { Interrupt } from '@gnldev/durable';

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

/** Extracts suspended tool calls (Interrupt) from a completed step list (same logic as runDurable). */
export function interruptsFromSteps(steps: any[]): Interrupt[] {
  const out: Interrupt[] = [];
  for (const step of steps ?? []) {
    for (const part of step?.content ?? []) {
      if (hasSuspend(part)) out.push(part.output.__gnl_suspend);
    }
  }
  return out;
}

/** pipeAgentStream options (opt-in — if not given, behavior is identical to before except for the id field). */
export interface PipeAgentStreamOptions {
  /**
   * The last event id the client saw (resolved from the Last-Event-ID header or body.lastEventId).
   * If given, events with id <= lastEventId are NOT WRITTEN (production still runs from the start — replay is cheap).
   */
  lastEventId?: number;
}

/** Stream fullStream as SSE, then send interrupt + done events. Returns a Hono Response. */
export function pipeAgentStream(c: Context, runId: string, result: any, opts?: PipeAgentStreamOptions) {
  const lastEventId = opts?.lastEventId;
  return streamSSE(c, async (stream) => {
    // Deterministic counter starting from 0: on replay with the same runId, fullStream produces the
    // same sequence → the same events are emitted in the same order → the same ids come out (see the note at the top of the file).
    let nextId = 0;
    const emit = async (event: string, data: unknown) => {
      const id = nextId++;
      if (lastEventId != null && id <= lastEventId) return; // client already saw it — production is cheap, skip
      await stream.writeSSE({ event, data: JSON.stringify(data), id: String(id) });
    };
    try {
      for await (const part of result.fullStream) {
        if (stream.aborted) break;
        switch (part.type) {
          case 'text-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit('text-delta', { text });
            break;
          }
          case 'tool-call':
            await emit('tool-call', { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            break;
          case 'tool-result':
            if (part.output?.__gnl_suspend) break; // the suspend sentinel is carried by the interrupt event
            if (part.output?.__gnl_limit_exceeded) break; // Decision #2: the limit sentinel is an INTERNAL API — it doesn't leak, it's carried by the error event
            if (part.output?.__gnl_blocked) break; // K1: the blocked sentinel is also an INTERNAL API — it's carried by the error event
            await emit('tool-result', { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output });
            break;
          // P0.1: reasoning (thinking) trace — id groups the deltas of one reasoning block.
          case 'reasoning-start':
            await emit('reasoning-start', { id: part.id });
            break;
          case 'reasoning-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit('reasoning-delta', { id: part.id, text });
            break;
          }
          case 'reasoning-end':
            await emit('reasoning-end', { id: part.id });
            break;
          // P0.1: incremental tool-argument streaming (live args UI) — the complete `tool-call` event still follows.
          case 'tool-input-start':
            await emit('tool-input-start', { toolCallId: part.toolCallId ?? part.id, toolName: part.toolName });
            break;
          case 'tool-input-delta':
            await emit('tool-input-delta', { toolCallId: part.toolCallId ?? part.id, delta: part.delta });
            break;
          case 'tool-input-end':
            await emit('tool-input-end', { toolCallId: part.toolCallId ?? part.id });
            break;
          case 'source':
            await emit('source', { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title });
            break;
          case 'file':
            await emit('file', { mediaType: part.file?.mediaType, base64: part.file?.base64 });
            break;
          case 'start-step':
            await emit('step-start', {});
            break;
          case 'finish-step':
            await emit('step-finish', { finishReason: part.finishReason, usage: part.usage });
            break;
          // P0.1: a tool that THREW — NON-terminal (the model sees the error and may continue), so it is
          // NOT the terminal `error` event; a distinct event keeps the "error = terminal" contract intact.
          case 'tool-error':
            await emit('tool-error', { toolCallId: part.toolCallId, toolName: part.toolName, error: String((part as any).error?.message ?? (part as any).error) });
            break;
          case 'error':
            await emit('error', { error: String((part as any).error?.message ?? (part as any).error) });
            break;
          // Deliberately no event: 'start'/'finish' (covered by done), 'text-start'/'text-end' (text
          // framing is delta-only in this schema), 'abort' (the client aborted — it isn't listening),
          // 'raw' (provider-internal passthrough, opt-in AI SDK debug surface).
          case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw':
            break;
          default:
            // Unknown/future part type: emit a type-only marker — never silently dropped, never leaks payload.
            await emit('raw', { type: part.type });
            break;
        }
      }
      const steps = await result.steps;
      // Decision #2: a run-limit violation (maxToolCalls/loop sentinel) → a terminal `error` event,
      // NO `done` (consistent with the existing catch-path error contract: error = terminal).
      const breach = limitBreachFromSteps(steps);
      if (breach) {
        await emit('error', {
          error: breach.message,
          code: breach.kind === 'loop' ? 'tool_loop_detected' : 'run_limit_exceeded',
          detail: breach.detail,
        });
        return;
      }
      // K1: the blocked sentinel (side-effect/retry/busy) → same contract as a limit violation: terminal error, no done.
      const blocked = blockedFromSteps(steps);
      if (blocked) {
        await emit('error', { error: blocked.message, code: BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy', detail: blocked.detail });
        return;
      }
      const interrupts = interruptsFromSteps(steps);
      if (interrupts.length) await emit('interrupt', { interrupts });
      const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      await emit('done', { runId, finishReason, usage });
    } catch (e: any) {
      await emit('error', { error: String(e?.message ?? e) });
    }
  });
}
