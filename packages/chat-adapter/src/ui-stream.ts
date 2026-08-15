// UseChat (AI SDK v5) wire format: a StreamTextResult's `toUIMessageStream()`/`toUIMessageStreamResponse()`
// Already exist on the object streamDurable returns (packages/durable/src/run.ts's
// `guardStreamTerminalPromises` is a Proxy that BINDS methods off the real AI SDK StreamTextResult — it
// Does not replace or hide them). This module wraps those two native entry points with a MANDATORY
// Sentinel-masking transform: durable-tool.ts's three internal sentinels (`__gnl_suspend`,
// `__gnl_limit_exceeded`, `__gnl_blocked` — see packages/server/src/sse.ts's tool-result handling, which
// This is kept in sync with) show up as ordinary tool OUTPUTS in the native UI chunk stream and must
// Never reach the browser verbatim (see sentinel-mask.ts for the shared masking shape).
//
// P0.2 `toUIMessageStreamResponse` here NEVER calls the native
// `result.toUIMessageStreamResponse()` directly — that would skip the masking transform entirely. It
// Always builds the masked chunk stream first, then wraps it with `createUIMessageStreamResponse`.
//
// Chunk type names below (`tool-input-start`, `tool-input-available`, `tool-output-available`,
// `data-${string}`) are verified against the installed `ai@5.0.204` package's `UIMessageChunk`
// Definition (node_modules/.pnpm/ai@5.0.204.../dist/index.d.ts) — NOT guessed / NOT copied from another
// Framework's chunk-stream types (which target a different AI SDK major in places).
import { createUIMessageStreamResponse } from 'ai';
import type { AsyncIterableStream, StreamTextResult, UIMessage, UIMessageChunk, UIMessageStreamOptions } from 'ai';
import { maskSentinelOutput } from './sentinel-mask.js';

/** A `data-gnl-interrupt` chunk's payload — one entry per newly-masked suspend in this transform call. */
export interface GnlInterruptData {
  interrupts: Array<{ toolCallId: string; toolName: string; args: unknown; reason?: string }>;
}

/**
 * Wraps a native `UIMessageChunk` stream with sentinel masking:
 * a `tool-output-available` chunk whose `output` carries `__gnl_suspend` → the chunk's `output` is
 *    Replaced with `{ pending: 'approval', toolName, reason }`, and a `data-gnl-interrupt` chunk
 *    `{ type: 'data-gnl-interrupt', data: { interrupts: [...] } }` is appended right after it (so a
 *    `useChat` client can render an approval UI without inspecting tool internals).
 * `__gnl_limit_exceeded` / `__gnl_blocked` outputs → replaced with `{ blocked: true, code, message }`
 *    (no internal `detail`/raw fields leak).
 * everything else passes through untouched.
 * `toolName` is tracked from `tool-input-start`/`tool-input-available` chunks (`tool-output-available`
 * Itself carries only `toolCallId`, not `toolName` — see the UIMessageChunk union in ai@5's .d.ts) so the
 * Masked suspend payload can still report which tool is awaiting approval.
 */
function maskSentinelChunks(): TransformStream<UIMessageChunk, UIMessageChunk> {
  const toolNames = new Map<string, string>();
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (
        (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available' || chunk.type === 'tool-input-error') &&
        'toolName' in chunk
      ) {
        toolNames.set(chunk.toolCallId, chunk.toolName);
      }
      if (chunk.type === 'tool-output-available') {
        const { display, interrupt } = maskSentinelOutput(chunk.output, toolNames.get(chunk.toolCallId));
        if (display !== chunk.output) {
          controller.enqueue({ ...chunk, output: display });
          if (interrupt) {
            const data: GnlInterruptData = { interrupts: [interrupt] };
            controller.enqueue({ type: 'data-gnl-interrupt', data } as UIMessageChunk);
          }
          return;
        }
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Thin wrapper over `result.toUIMessageStream()` with the sentinel-masking transform ALWAYS applied.
 * `result` is whatever `gnl.stream()`/`streamDurable` returns (a real AI SDK `StreamTextResult` under a
 * Method-binding Proxy — see run.ts's `guardStreamTerminalPromises`).
 */
export function toUIMessageStream<UI_MESSAGE extends UIMessage = UIMessage>(
  result: Pick<StreamTextResult<any, any>, 'toUIMessageStream'>,
  opts?: UIMessageStreamOptions<UI_MESSAGE>,
): AsyncIterableStream<UIMessageChunk> {
  const native = result.toUIMessageStream(opts);
  // PipeThrough on a WHATWG ReadableStream keeps async-iterability (verified: Node's native
  // ReadableStream implements Symbol.asyncIterator; ai's own AsyncIterableStream helper relies on the
  // Same `pipeThrough(new TransformStream())` pattern — see ai/dist/index.mjs's createAsyncIterableStream).
  return native.pipeThrough(maskSentinelChunks()) as AsyncIterableStream<UIMessageChunk>;
}

/**
 * `UIMessageStreamResponseInit` (the native method's other option half) is NOT exported by the `ai`
 * Package (private type) — this mirrors its structural shape (verified against
 * `toUIMessageStreamResponse`'s declared parameter in ai@5's .d.ts) without importing a name that isn't
 * Part of the package's public surface.
 */
export interface ToUIMessageStreamResponseOptions<UI_MESSAGE extends UIMessage = UIMessage>
  extends UIMessageStreamOptions<UI_MESSAGE>,
    ResponseInit {
  consumeSseStream?: (options: { stream: ReadableStream<string> }) => PromiseLike<void> | void;
}

/**
 * Thin wrapper over `createUIMessageStreamResponse` — ALWAYS runs the masking transform (see the module
 * Header note: calling the native `result.toUIMessageStreamResponse()` directly is deliberately never
 * Done here, since that would bypass masking).
 */
export function toUIMessageStreamResponse<UI_MESSAGE extends UIMessage = UIMessage>(
  result: Pick<StreamTextResult<any, any>, 'toUIMessageStream'>,
  opts?: ToUIMessageStreamResponseOptions<UI_MESSAGE>,
): Response {
  const { status, statusText, headers, consumeSseStream, ...streamOpts } = opts ?? {};
  const stream = toUIMessageStream(result, streamOpts as UIMessageStreamOptions<UI_MESSAGE> | undefined);
  return createUIMessageStreamResponse({ status, statusText, headers, consumeSseStream, stream });
}
