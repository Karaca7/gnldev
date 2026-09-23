// Writes an agent stream as SSE for the playground. The events come from @gnldev/durable's
// `agentStreamEvents` — the same source @gnldev/server writes from — so the two surfaces cannot drift.
// This copy used to be a second implementation "kept IN SYNC" by comment; it leaked the internal
// `__gnl_limit_exceeded` sentinel and ended a limit breach with `done` after the server had stopped.
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { agentStreamEvents, interruptsFromSteps } from '@gnldev/durable';
import { STUDIO_ERROR_CODES } from './error-codes.js';

export { interruptsFromSteps };

/**
 * `streamSSE` plus the two headers a live stream needs to survive the trip to the browser.
 *
 * Hono sets `Cache-Control: no-cache`, which says "don't serve this from cache" and says nothing
 * about re-encoding. So a compression middleware in the host's chain happily takes the stream and
 * buffers it: measured on a real Express app, `compression()` turned 13 progressive chunks with the
 * first at 750ms into ONE chunk delivered at the end. Status 200, no error, no live screen —
 * the failure is invisible from both sides. `no-transform` is the standard way to say don't, and
 * `compression` honours it (measured: first byte 1520ms → 302ms with the flag on).
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

/** Writes @gnldev/durable's agent stream events as SSE — the same schema and endings as @gnldev/server. */
export function pipeAgentStream(c: Context, runId: string, result: any) {
  return sseResponse(c, async (stream) => {
    for await (const { event, data } of agentStreamEvents(result, runId, STUDIO_ERROR_CODES)) {
      if (stream.aborted) break;
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    }
  });
}
