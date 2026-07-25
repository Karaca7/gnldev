// #3 live observability: emits live spans + cost while model/tool calls ACTUALLY run;
// on REPLAY (journal cache hit), emits nothing → stays journal-external + preserves determinism.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { liveObservability } from '../src/live.js';

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

// First step is a chargeCard tool-call, then final text. modelId 'gpt-4o' → cost > 0.
function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'openai.chat',
    modelId: 'gpt-4o',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5 }) }],
          finishReason: 'tool-calls',
          usage,
          response: { modelId: 'gpt-4o' },
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, response: { modelId: 'gpt-4o' }, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

function makeTools(counter: { n: number }) {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        counter.n++;
        return { ok: true };
      },
    }),
  };
}

const spanNames = (exp: InMemorySpanExporter) => exp.getFinishedSpans().map((s) => s.name);

describe('@gnldev/otel/live', () => {
  it('emits live span + cost; the same runId on replay does NOT emit (journal-external)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };

    const live = liveObservability({ exporter: new InMemorySpanExporter() });
    await runDurable(live.instrument({ runId: 'o1', journal, model: mkModel(), tools: makeTools(counter), prompt: 'go' } as any));
    await live.flush();

    const names = spanNames(live.exporter as InMemorySpanExporter);
    expect(names).toContain('agent.run');
    expect(names.filter((n) => n === 'llm.generate')).toHaveLength(2); // tool-call step + final
    expect(names).toContain('tool.execute');

    const cost = live.cost();
    expect(cost.modelCalls).toBe(2);
    expect(cost.toolCalls).toBe(1);
    expect(cost.totalTokens).toBe(300); // 2 × 150
    expect(cost.costUsd).toBeGreaterThan(0); // gpt-4o was priced
    expect(counter.n).toBe(1);

    // REPLAY: same runId + journal, NEW live instance → model/tool return from the journal, no REAL execution.
    const live2 = liveObservability({ exporter: new InMemorySpanExporter() });
    await runDurable(live2.instrument({ runId: 'o1', journal, model: mkModel(), tools: makeTools(counter), prompt: 'go' } as any));
    await live2.flush();

    expect((live2.exporter as InMemorySpanExporter).getFinishedSpans()).toHaveLength(0); // no live span at all
    expect(live2.cost().modelCalls).toBe(0);
    expect(counter.n).toBe(1); // tool did not run again (exactly-once preserved)
  });

  it('onCost callback fires on every model call (budget alarm)', async () => {
    const journal = new InMemoryJournal();
    const costs: number[] = [];
    const live = liveObservability({ exporter: new InMemorySpanExporter(), onCost: (c) => costs.push(c.costUsd) });
    await runDurable(live.instrument({ runId: 'c1', journal, model: mkModel(), tools: makeTools({ n: 0 }), prompt: 'go' } as any));
    await live.flush();
    expect(costs).toHaveLength(2); // 2 model calls
    expect(costs[1]!).toBeGreaterThan(costs[0]!); // increases cumulatively
  });

  it('sampleRate 0 → instrument no-op (no live span), but run works normally', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const live = liveObservability({ exporter: new InMemorySpanExporter(), sampleRate: 0 });
    const r = await runDurable(live.instrument({ runId: 's1', journal, model: mkModel(), tools: makeTools(counter), prompt: 'go' } as any));
    await live.flush();
    expect((live.exporter as InMemorySpanExporter).getFinishedSpans()).toHaveLength(0);
    expect(r.text).toContain('done'); // run still completed
    expect(counter.n).toBe(1);
  });

  // FINDING (roots leak, before/after): previously, an argument-less flush() would close ALL open roots
  // and clear the Map entirely — in a multi-run (concurrent) scenario, flushing one run would also
  // prematurely close OTHER runs' roots; so in practice no one could call per-run flush(), and if cleanup
  // wasn't done when a run finished, the `roots` Map would grow unbounded. Now flush(runId) cleans up ONLY that run.
  it('flush(runId) closes+removes only that run\'s root; does not touch other concurrent runs (leak fix)', async () => {
    const live = liveObservability({ exporter: new InMemorySpanExporter() });
    const journal1 = new InMemoryJournal();
    const journal2 = new InMemoryJournal();

    // Process two runs "concurrently" on the same live instance (flush never called in between).
    await runDurable(live.instrument({ runId: 'run-a', journal: journal1, model: mkModel(), tools: makeTools({ n: 0 }), prompt: 'go' } as any));
    await runDurable(live.instrument({ runId: 'run-b', journal: journal2, model: mkModel(), tools: makeTools({ n: 0 }), prompt: 'go' } as any));

    expect(live.pendingRuns()).toBe(2); // both runs' roots are still in the Map — before the fix, this always kept growing

    await live.flush('run-a');
    expect(live.pendingRuns()).toBe(1); // only run-a was cleaned up
    const namesAfterA = spanNames(live.exporter as InMemorySpanExporter);
    expect(namesAfterA.filter((n) => n === 'agent.run')).toHaveLength(1); // only run-a's root was exported

    await live.flush('run-b');
    expect(live.pendingRuns()).toBe(0); // both clean now
    const namesAfterB = spanNames(live.exporter as InMemorySpanExporter);
    expect(namesAfterB.filter((n) => n === 'agent.run')).toHaveLength(2);
  });

  // Guardrail: even if the caller never calls per-run flush() (a real leak scenario), if maxPendingRuns
  // is given, the Map stays bounded — no matter how many N runs are processed, the size never exceeds the cap.
  it('maxPendingRuns guardrail: even if flush is never called, roots Map size stays bounded (N runs)', async () => {
    const CAP = 3;
    const N = 20;
    const live = liveObservability({ exporter: new InMemorySpanExporter(), maxPendingRuns: CAP });

    for (let i = 0; i < N; i++) {
      const journal = new InMemoryJournal();
      await runDurable(
        live.instrument({ runId: `leak-${i}`, journal, model: mkModel(), tools: makeTools({ n: 0 }), prompt: 'go' } as any),
      );
      expect(live.pendingRuns()).toBeLessThanOrEqual(CAP); // the cap is never exceeded at any step
    }

    expect(live.pendingRuns()).toBeLessThanOrEqual(CAP); // still bounded even after N=20 runs (NO leak)
    await live.flush();
    expect(live.pendingRuns()).toBe(0);
  });

  it('if maxPendingRuns is not given (default) the guardrail is off — old behavior unchanged, Map can grow', async () => {
    const N = 5;
    const live = liveObservability({ exporter: new InMemorySpanExporter() });
    for (let i = 0; i < N; i++) {
      const journal = new InMemoryJournal();
      await runDurable(
        live.instrument({ runId: `grow-${i}`, journal, model: mkModel(), tools: makeTools({ n: 0 }), prompt: 'go' } as any),
      );
    }
    expect(live.pendingRuns()).toBe(N); // no guardrail → all still in the Map (existing behavior preserved)
    await live.flush();
    expect(live.pendingRuns()).toBe(0);
  });
});
