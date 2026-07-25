// Pumps a streamDurable result (AI SDK StreamTextResult) into SSE — the SAME schema as @gnldev/server,
// so @gnldev/client can connect to both the REST server and the studio playground.
// Schema: text-delta {text} · tool-call {toolCallId,toolName,input} · tool-result {...} · error {error}
//         reasoning-start/delta/end · tool-input-start/delta/end · source · file · step-start/finish
//         tool-error (non-terminal) · raw {type} (unknown-part marker) — P0.1, kept IN SYNC with
//         packages/server/src/sse.ts (see its header for the per-event rationale)
//         interrupt {interrupts[]} (once the stream ends) · done {runId,finishReason,usage}
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { Interrupt } from '@gnldev/durable';

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

export function interruptsFromSteps(steps: any[]): Interrupt[] {
  const out: Interrupt[] = [];
  for (const step of steps ?? []) {
    for (const part of step?.content ?? []) {
      if (hasSuspend(part)) out.push(part.output.__gnl_suspend);
    }
  }
  return out;
}

export function pipeAgentStream(c: Context, runId: string, result: any) {
  return streamSSE(c, async (stream) => {
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
