// Pumps a streamDurable result (AI SDK StreamTextResult) into SSE — the SAME schema as @gnldev/server,
// So @gnldev/client can connect to both the REST server and the studio playground.
// Schema: text-delta {text} · tool-call {toolCallId,toolName,input} · tool-result {...} · error {error}
//         Reasoning-start/delta/end · tool-input-start/delta/end · source · file · step-start/finish
//         Tool-error (non-terminal) · raw {type} (unknown-part marker) — P0.1, kept IN SYNC with
//         Packages/server/src/sse.ts (see its header for the per-event rationale)
//         Interrupt {interrupts[]} (once the stream ends) · done {runId,finishReason,usage}
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { surfacedInterrupts } from '@gnldev/durable';
import type { Interrupt } from '@gnldev/durable';

/**
 * `streamSSE` plus the two headers a live stream needs to survive the trip to the browser.
 *
 * Hono sets `Cache-Control: no-cache`, which says "don't serve this from cache" and says nothing
 * About re-encoding. So a compression middleware in the host's chain happily takes the stream and
 * Buffers it: measured on a real Express app, `compression()` turned 13 progressive chunks with the
 * First at 750ms into ONE chunk delivered at the end. Status 200, no error, no live screen —
 * The failure is invisible from both sides. `no-transform` is the standard way to say don't, and
 * `compression` honours it (measured: first byte 1520ms → 302ms with the flag on).
 *
 * `X-Accel-Buffering: no` is the nginx-specific half, and measurement narrowed where it matters to
 * One square of a 2x2 — behind a real nginx, same stream dripping five deltas 300ms apart:
 *
 * HTTP/1.1 + gzip, no header  → ONE chunk at 1511ms      (collapsed)
 * HTTP/1.1 + gzip, header     → 306, 606, 911, 1211, 1511
 * HTTP/2   + gzip, no header  → 316, 616, 916, 1217, 1518 (fine without it)
 * HTTP/2   + gzip, header     → 312, 612, 913, 1214, 1514
 *
 * So it is load-bearing exactly when the CLIENT speaks HTTP/1.1 to a proxy that gzips, and inert
 * Everywhere else — including HTTP/2, which is what a browser usually gets over TLS. That leaves
 * Plenty of real traffic in the square that breaks: internal clients on plain HTTP, curl's default,
 * Anything not a modern browser. Worth a header; not worth believing it covers more than it does.
 *
 * Set AFTER `streamSSE` on purpose: it writes `Cache-Control` itself, so anything set on the context
 * Beforehand is overwritten. Patching the returned Response is what actually survives.
 *
 * Kept IN SYNC with packages/server/src/sse.ts.
 */
export function sseResponse(
  c: Context,
  cb: Parameters<typeof streamSSE>[1],
  onError?: Parameters<typeof streamSSE>[2],
): Response {
  const res = streamSSE(c, cb, onError);
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
}

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

/** Kept IN SYNC with packages/server/src/sse.ts — including the reason the raw sentinel is NOT
 *  Pushed: an iç içe askıda o sentinel vekilin id'siyle anahtarlıdır ve motor vekile verilen cevabı
 *  Yok sayar (bkz. durable `surfacedInterrupts`). Dönüşüm motorun kendi fonksiyonundan geçer. */
export function interruptsFromSteps(steps: any[]): Interrupt[] {
  const out: Interrupt[] = [];
  for (const step of steps ?? []) {
    for (const part of step?.content ?? []) {
      if (hasSuspend(part)) out.push(...surfacedInterrupts(part.output.__gnl_suspend));
    }
  }
  return out;
}

export function pipeAgentStream(c: Context, runId: string, result: any) {
  return sseResponse(c, async (stream) => {
    const emit = async (event: string, data: unknown) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
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
            if (part.output?.__gnl_suspend) break;
            await emit('tool-result', { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output });
            break;
          // P0.1: kept IN SYNC with packages/server/src/sse.ts — same cases, same reasons.
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
          case 'tool-error':
            await emit('tool-error', { toolCallId: part.toolCallId, toolName: part.toolName, error: String((part as any).error?.message ?? (part as any).error) });
            break;
          case 'error':
            await emit('error', { error: String((part as any).error?.message ?? (part as any).error) });
            break;
          case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw':
            break; // deliberately no event — same list and reasons as server sse.ts
          default:
            await emit('raw', { type: part.type }); // unknown part → type-only marker, never silent
            break;
        }
      }
      const interrupts = interruptsFromSteps(await result.steps);
      if (interrupts.length) await stream.writeSSE({ event: 'interrupt', data: JSON.stringify({ interrupts }) });
      const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ runId, finishReason, usage }) });
    } catch (e: any) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(e?.message ?? e) }) });
    }
  });
}
