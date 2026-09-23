// Writes an agent stream as SSE. WHAT is sent — the event schema, the hidden sentinels, the terminal
// `error` vs `done` — is @gnldev/durable's `agentStreamEvents` (durable/src/agent-stream.ts), shared
// with the @gnldev/studio playground so @gnldev/client can connect to either endpoint. This file owns
// only HOW it goes over the wire: the headers below and the resumable ids.
//
// RESUMABLE SSE: a deterministic, increasing `id:` starting from 0 is attached to every written event
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
import { agentStreamEvents, interruptsFromSteps } from '@gnldev/durable';
import { EDGE_ERROR_CODES } from './edge-errors.js';

export { interruptsFromSteps };

/**
 * `streamSSE` plus the two headers a live stream needs to survive the trip to the browser.
 *
 * Hono sets `Cache-Control: no-cache`, which says "don't serve this from cache" and says nothing
 * about re-encoding. So a compression middleware in the host's chain happily takes the stream and
 * buffers it: measured on a real Express app, `compression()` turned 13 progressive chunks with the
 * first at 750ms into ONE chunk delivered at the end. Status 200, no error, no live screen — the
 * failure is invisible from both sides. `no-transform` is the standard way to say don't, and
 * `compression` honours it (measured: first byte 1520ms -> 302ms with the flag on).
 *
 * `X-Accel-Buffering: no` is the nginx-specific half, and measurement narrowed where it matters to
 * one square of a 2x2 — behind a real nginx, same stream dripping five deltas 300ms apart:
 *
 * HTTP/1.1 + gzip, no header  → ONE chunk at 1511ms      (collapsed)
 * HTTP/1.1 + gzip, header     → 306, 606, 911, 1211, 1511
 * HTTP/2   + gzip, no header  → 316, 616, 916, 1217, 1518 (fine without it)
 * HTTP/2   + gzip, header     → 312, 612, 913, 1214, 1514
 *
 * So it is load-bearing exactly when the CLIENT speaks HTTP/1.1 to a proxy that gzips, and inert
 * everywhere else — including HTTP/2, which is what a browser usually gets over TLS. That leaves
 * plenty of real traffic in the square that breaks: internal clients on plain HTTP, curl's default,
 * anything not a modern browser. Worth a header; not worth believing it covers more than it does.
 *
 * Set AFTER `streamSSE` on purpose: it writes `Cache-Control` itself, so anything set on the context
 * beforehand is overwritten. Patching the returned Response is what actually survives.
 *
 * Kept IN SYNC with packages/studio/src/sse.ts.
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

/** pipeAgentStream options (opt-in — if not given, behavior is identical to before except for the id field). */
export interface PipeAgentStreamOptions {
  /** The last event id the client saw; events with id <= lastEventId are produced but NOT written. */
  lastEventId?: number;
}

/** Writes @gnldev/durable's agent stream events as SSE with resumable ids. Returns a Hono Response. */
export function pipeAgentStream(c: Context, runId: string, result: any, opts?: PipeAgentStreamOptions) {
  const lastEventId = opts?.lastEventId;
  return sseResponse(c, async (stream) => {
    let nextId = 0; // deterministic: the same runId replays the same events, so the same ids
    for await (const { event, data } of agentStreamEvents(result, runId, EDGE_ERROR_CODES)) {
      if (stream.aborted) break;
      const id = nextId++;
      if (lastEventId != null && id <= lastEventId) continue; // the client already saw it
      await stream.writeSSE({ event, data: JSON.stringify(data), id: String(id) });
    }
  });
}
