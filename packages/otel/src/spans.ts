// Journal entry → OTEL span mapping + DETERMINISTIC id generation (re-export idempotent).
import { createHash } from 'node:crypto';
import type { IdGenerator } from '@opentelemetry/sdk-trace-base';
import type { JournalEntry } from '@gnldev/durable';
import { flattenUsage, finishReasonText } from '@gnldev/durable';

/** The step's token counts, flat, whichever AI SDK shape the record was written in. */
const usageOf = (v: any) => flattenUsage(v?.usage);

/** runId → fixed 32-hex trace id (the same run always yields the same trace). */
export function traceIdFor(runId: string): string {
  return createHash('sha256').update(`gnl-trace:${runId}`).digest('hex').slice(0, 32);
}

/** (runId, seq) → fixed 16-hex span id. */
export function spanIdFor(runId: string, seq: number | 'root'): string {
  return createHash('sha256').update(`gnl-span:${runId}:${seq}`).digest('hex').slice(0, 16);
}

/**
 * An IdGenerator that hands out precomputed ids in sequence. The trace and span queues are SEPARATE →
 * Gives the correct id regardless of the SDK's generateTraceId/generateSpanId call order. If a queue
 * Runs out, falls back deterministically (hash). This way the same run → same trace_id/span_id → idempotent export.
 */
export class QueueIdGenerator implements IdGenerator {
  private ti = 0;
  private si = 0;
  constructor(
    private readonly runId: string,
    private readonly traceIds: string[],
    private readonly spanIds: string[],
  ) {}
  generateTraceId(): string {
    return this.traceIds[this.ti++] ?? traceIdFor(`${this.runId}#t${this.ti}`);
  }
  generateSpanId(): string {
    return this.spanIds[this.si++] ?? spanIdFor(`${this.runId}#s`, this.si);
  }
}

export interface MappedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  isError: boolean;
  isSuspended: boolean;
}

/** Drop undefined/null attributes (OTEL setAttributes doesn't like them). */
function clean(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Converts a journal entry into an OTEL span name + gen_ai semantic attributes. */
export function mapEntry(e: JournalEntry): MappedSpan {
  const v: any = e.value;
  if (e.kind === 'model') {
    return {
      name: 'llm.generate',
      attributes: clean({
        'gen_ai.operation.name': 'generate',
        'gen_ai.response.model': v?.response?.modelId,
        // Through the shared readers: OTel attributes must be scalars, and an AI SDK 7 record's
        // usage is nested while its finishReason is an object — emitted raw they arrive as
        // "[object Object]" or NaN, which every backend either drops or charts as garbage.
        'gen_ai.response.finish_reason': finishReasonText(v?.finishReason),
        'gen_ai.usage.input_tokens': usageOf(v).inputTokens,
        'gen_ai.usage.output_tokens': usageOf(v).outputTokens,
        'gen_ai.usage.total_tokens': usageOf(v).totalTokens,
      }),
      isError: false,
      isSuspended: false,
    };
  }
  const status = v?.status;
  return {
    name: 'tool.execute',
    attributes: clean({ 'gnl.tool.status': status }),
    isError: status === 'failed',
    isSuspended: status === 'suspended',
  };
}
