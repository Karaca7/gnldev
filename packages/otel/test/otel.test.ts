// Phase 10 — @gnldev/otel: journal → OTEL trace. root+child span, attribute=cost, parent nesting,
// idempotent traceId/spanId, crash-proof (partial journal), timing (duration wired).
import { describe, it, expect } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryJournal, runDurable, getRunCost } from '@gnldev/durable';
import { exportRun, traceIdFor } from '../src/index.js';

// Avoid importing 'ai' (not a dep in the otel package): don't pass stopWhen → default stepCountIs(12).
function mkModel(): any {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'gpt-test',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return { content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'pay', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [], response: { modelId: 'gpt-test' } };
      }
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [], response: { modelId: 'gpt-test' } };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

async function seededRun(): Promise<InMemoryJournal> {
  const journal = new InMemoryJournal();
  await runDurable({ runId: 'r', journal, model: mkModel(), tools: { pay: { execute: async () => ({ paid: true }) } }, prompt: 'x' });
  return journal; // entries: model:0 (tool-call), tool:call-c, model:1 (final)
}

describe('Phase 10 exportRun', () => {
  it('1 root + N child spans; children share traceId + parent = root; gen_ai attributes present', async () => {
    const journal = await seededRun();
    const exporter = new InMemorySpanExporter();
    const { traceId, spans } = await exportRun(journal, 'r', { exporter, serviceName: 'svc' });

    const fin = exporter.getFinishedSpans();
    expect(spans).toBe(4); // root + 3 entry
    expect(fin.length).toBe(4);

    const root = fin.find((s) => s.name === 'agent.run')!;
    expect(root).toBeDefined();
    expect(root.attributes['gnl.run_id']).toBe('r');
    expect(root.spanContext().traceId).toBe(traceId);

    // all children share the same trace + parent = root span id
    const children = fin.filter((s) => s.name !== 'agent.run');
    expect(children.length).toBe(3);
    for (const c of children) {
      expect(c.spanContext().traceId).toBe(traceId);
      // OTel 2.x replaced ReadableSpan.parentSpanId with parentSpanContext; the claim is unchanged
      // (every child's parent IS the root span), only the field the SDK exposes it through.
      expect(c.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }

    const llm = fin.find((s) => s.name === 'llm.generate')!;
    expect(llm.attributes['gen_ai.response.model']).toBe('gpt-test');
    expect(fin.some((s) => s.name === 'tool.execute')).toBe(true);
  });

  it('root attributes match getRunCost 1:1', async () => {
    const journal = await seededRun();
    const exporter = new InMemorySpanExporter();
    await exportRun(journal, 'r', { exporter });
    const cost = await getRunCost(journal, 'r');
    const root = exporter.getFinishedSpans().find((s) => s.name === 'agent.run')!;
    expect(root.attributes['gen_ai.usage.total_tokens']).toBe(cost.totalTokens);
    expect(root.attributes['gnl.model_calls']).toBe(cost.modelCalls);
    expect(root.attributes['gnl.tool_calls']).toBe(cost.toolCalls);
    expect(root.attributes['gnl.status']).toBe('completed');
  });

  it('idempotent: exporting the same run twice → SAME traceId + SAME span id set', async () => {
    const journal = await seededRun();
    const ea = new InMemorySpanExporter();
    const eb = new InMemorySpanExporter();
    const a = await exportRun(journal, 'r', { exporter: ea });
    const b = await exportRun(journal, 'r', { exporter: eb });
    expect(a.traceId).toBe(b.traceId);
    expect(a.traceId).toBe(traceIdFor('r'));
    const ids = (e: InMemorySpanExporter) => e.getFinishedSpans().map((s) => s.spanContext().spanId).sort();
    expect(ids(ea)).toEqual(ids(eb)); // span ids are deterministic too
  });

  it('crash-proof: partial journal (no final model) → still a valid trace', async () => {
    const j = new InMemoryJournal();
    await j.put('p:model:0', { content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'pay', input: '{}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, response: { modelId: 'm' } });
    await j.put('p:tool:c', { status: 'succeeded', output: { ok: true } });
    const exporter = new InMemorySpanExporter();
    const { spans } = await exportRun(j, 'p', { exporter });
    expect(spans).toBe(3); // root + 2 (completed prefix)
    expect(exporter.getFinishedSpans().length).toBe(3);
  });

  it('timing wired: root span duration > 0 for entries with a ts difference', async () => {
    const j = new InMemoryJournal();
    await j.put('t:model:0', { content: [], finishReason: 'stop', usage: {} });
    await new Promise((r) => setTimeout(r, 5));
    await j.put('t:model:1', { content: [], finishReason: 'stop', usage: {} });
    const exporter = new InMemorySpanExporter();
    await exportRun(j, 't', { exporter });
    const root = exporter.getFinishedSpans().find((s) => s.name === 'agent.run')!;
    const durNs = root.duration[0] * 1e9 + root.duration[1];
    expect(durNs).toBeGreaterThan(0);
  });
});
