// The agent stream wire schema, owned in ONE place and free of any HTTP framework: a StreamTextResult
// in, `{ event, data }` out. @gnldev/server and @gnldev/studio each wrap it in a few lines of SSE
// writing. They used to carry two copies of this mapping kept "in sync" by comment, and the copies
// drifted — the REST stream hid the internal limit/blocked sentinels and ended with a typed `error`;
// the playground leaked the sentinel and ended with `done`.
//
// Schema (event → data): text-delta {text} · tool-call {toolCallId,toolName,input} · tool-result {…}
// reasoning-start/delta/end · tool-input-start/delta/end · source · file · step-start · step-finish
// tool-error (non-terminal) · raw {type} (unknown part, payload withheld) · error {error,code?,detail?}
// (terminal) · interrupt {interrupts[]} · done {runId,finishReason,usage}.
//
// Every known part has a case. The first version knew four part types and had no default, so every
// reasoning-*/source/file/step-*/tool-input-* part was SILENTLY DROPPED (a reasoning model's whole
// thinking trace vanished with no error). A few parts are deliberately not events ('start'/'finish'
// → covered by done; 'text-start'/'text-end' → text framing is delta-only; 'abort'/'raw' →
// transport-internal), and anything else becomes `raw {type}`: type only, payload withheld, so an
// unknown part can neither vanish nor leak an internal payload.
import { limitBreachFromSteps, blockedFromSteps, surfacedInterrupts } from './run.js';
import { BLOCKED_ERROR_CODES } from './errors.js';
import type { Interrupt } from './guard.js';

export interface AgentStreamEvent { event: string; data: unknown }

/** The wire codes for the two limit endings — the SURFACE owns them (each enumerates its own codes). */
export interface AgentStreamCodes { runLimitExceeded: string; toolLoopDetected: string }

/** Suspended tool calls in a finished step list, surfaced the way runDurable surfaces them. */
export function interruptsFromSteps(steps: any[]): Interrupt[] {
  const out: Interrupt[] = [];
  for (const step of steps ?? []) {
    for (const part of step?.content ?? []) {
      if (part?.type === 'tool-result' && part.output?.__gnl_suspend) out.push(...surfacedInterrupts(part.output.__gnl_suspend));
    }
  }
  return out;
}

const errText = (e: any) => String(e?.message ?? e);

export async function* agentStreamEvents(result: any, runId: string, codes: AgentStreamCodes): AsyncGenerator<AgentStreamEvent> {
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': { const text = part.text ?? part.delta ?? ''; if (text) yield { event: 'text-delta', data: { text } }; break; }
        case 'tool-call': yield { event: 'tool-call', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } }; break;
        case 'tool-result':
          // The three sentinels are internal API: suspend is carried by `interrupt`, limit/blocked by the terminal `error`.
          if (part.output?.__gnl_suspend || part.output?.__gnl_limit_exceeded || part.output?.__gnl_blocked) break;
          yield { event: 'tool-result', data: { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } }; break;
        case 'reasoning-start': yield { event: 'reasoning-start', data: { id: part.id } }; break;
        case 'reasoning-delta': { const text = part.text ?? part.delta ?? ''; if (text) yield { event: 'reasoning-delta', data: { id: part.id, text } }; break; }
        case 'reasoning-end': yield { event: 'reasoning-end', data: { id: part.id } }; break;
        case 'tool-input-start': yield { event: 'tool-input-start', data: { toolCallId: part.toolCallId ?? part.id, toolName: part.toolName } }; break;
        case 'tool-input-delta': yield { event: 'tool-input-delta', data: { toolCallId: part.toolCallId ?? part.id, delta: part.delta } }; break;
        case 'tool-input-end': yield { event: 'tool-input-end', data: { toolCallId: part.toolCallId ?? part.id } }; break;
        case 'source': yield { event: 'source', data: { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title } }; break;
        case 'file': yield { event: 'file', data: { mediaType: part.file?.mediaType, base64: part.file?.base64 } }; break;
        case 'start-step': yield { event: 'step-start', data: {} }; break;
        case 'finish-step': yield { event: 'step-finish', data: { finishReason: part.finishReason, usage: part.usage } }; break;
        case 'tool-error': yield { event: 'tool-error', data: { toolCallId: part.toolCallId, toolName: part.toolName, error: errText(part.error) } }; break;
        case 'error': yield { event: 'error', data: { error: errText(part.error) } }; break;
        // Deliberately no event: covered by done / delta-only framing / transport-internal.
        case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw': break;
        default: yield { event: 'raw', data: { type: part.type } }; // never silent, never the payload
      }
    }
    const steps = await result.steps;
    const breach = limitBreachFromSteps(steps);
    if (breach) {
      yield { event: 'error', data: { error: breach.message, code: breach.kind === 'loop' ? codes.toolLoopDetected : codes.runLimitExceeded, detail: breach.detail } };
      return;
    }
    const blocked = blockedFromSteps(steps);
    if (blocked) {
      yield { event: 'error', data: { error: blocked.message, code: BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy', detail: blocked.detail } };
      return;
    }
    const interrupts = interruptsFromSteps(steps);
    if (interrupts.length) yield { event: 'interrupt', data: { interrupts } };
    const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
    const usage = await Promise.resolve(result.usage).catch(() => undefined);
    yield { event: 'done', data: { runId, finishReason, usage } };
  } catch (e) {
    yield { event: 'error', data: { error: errText(e) } };
  }
}
