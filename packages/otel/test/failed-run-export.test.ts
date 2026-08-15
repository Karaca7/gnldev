// The most misleading thing this exporter could send, it sent by default.
//
// exportRun derived the root span's status from the run's ENTRIES: error if any of them was an error,
// OK otherwise. A run that died before it wrote any entry — an upstream 401, a cost ceiling at step 0 —
// therefore arrived in the tracing backend as OK, with $0 of cost and one lonely root span. The dashboard
// showed a healthy system precisely when nothing was working.
//
// The run's recorded outcome now decides, and the reason travels with it so the span says WHY.
import { describe, it, expect } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { exportRun } from '../src/index.js';
import { InMemoryStorage, runDurable, runKeys } from '@gnldev/durable';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const good = { ...base, doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) } as any;
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); } } as any;

async function rootSpanOf(journal: any, runId: string) {
  const { exporter } = await exportRun(journal, runId);
  const spans = (exporter as any).getFinishedSpans();
  return spans.find((s: any) => !s.parentSpanId) ?? spans[0];
}

describe('exporting a run that failed', () => {
  it('reports ERROR, not OK', async () => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId: 'died', journal, model: dead, prompt: 'x' } as any).catch(() => {});

    const root = await rootSpanOf(journal, 'died');
    expect(root.status.code, 'this arrived in the backend as OK').toBe(SpanStatusCode.ERROR);
    expect(root.attributes['gnl.status']).toBe('failed');
    // The reason, so the trace is actionable without going back to the journal.
    expect(String(root.attributes['gnl.error'] ?? '')).toContain('401');
  });

  it('still reports OK for a run that finished', async () => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId: 'lived', journal, model: good, prompt: 'x' } as any);

    const root = await rootSpanOf(journal, 'lived');
    expect(root.status.code).toBe(SpanStatusCode.OK);
    expect(root.attributes['gnl.status']).toBe('completed');
  });

  it('reports a run that never ended as UNSET/running — never OK', async () => {
    const journal = new InMemoryStorage().runs;
    // Abandoned mid-work: the write-ahead landed, no terminal ever did (the SIGKILL case).
    const never = { ...base, doGenerate: () => new Promise(() => {}) } as any;
    void runDurable({ runId: 'stuck', journal, model: never, prompt: 'x' } as any).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const root = await rootSpanOf(journal, 'stuck');
    // OTel's OK means "ended fine"; this run has not ended. Exporting it as OK was the dashboard
    // showing green precisely while the process was dead.
    expect(root.status.code).not.toBe(SpanStatusCode.OK);
    expect(root.attributes['gnl.status']).toBe('running');
  });

  it('falls back to the old derivation for a run written before outcomes existed', async () => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId: 'legacy', journal, model: good, prompt: 'x' } as any);
    // Simulate a journal from before this record existed.
    await journal.deletePrefix(`${runKeys.outcome('legacy')}`);

    const root = await rootSpanOf(journal, 'legacy');
    expect(root.status.code, 'an old run must export exactly as it did before').toBe(SpanStatusCode.OK);
    expect(root.attributes['gnl.status']).toBe('completed');
  });
});
