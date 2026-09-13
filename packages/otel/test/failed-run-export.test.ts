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
  // The root is the span with no parent. OTel 2.x moved that from parentSpanId to
  // parentSpanContext; both are read so this helper works whichever major is installed.
  return spans.find((s: any) => !s.parentSpanId && !s.parentSpanContext) ?? spans[0];
}

/**
 * Same span, but waits for the write-ahead marker to carry the expected status instead of sleeping a
 * fixed span first.
 *
 * The two abandoned-run tests below start a run they never await, so what they are waiting for is an
 * EVENT — the marker landing — and the `sleep(30)` this replaces encoded it as a duration. Returns
 * the last span it saw at the deadline so a real failure still reports the actual status.
 *
 * The margin was measured on the sibling case in durable/test/running-status.test.ts rather than
 * assumed: the fixed-sleep form did not flake, even with the sleep cut to 1ms under load ~40. So this
 * removes an assumption; it does not close a reproduced failure.
 */
async function waitForRootStatus(journal: any, runId: string, want: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let root: any;
  do {
    root = await rootSpanOf(journal, runId).catch(() => undefined);
    if (root?.attributes['gnl.status'] === want) return root;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  return root;
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

    const root = await waitForRootStatus(journal, 'stuck', 'running');
    // OTel's OK means "ended fine"; this run has not ended. Exporting it as OK was the dashboard
    // showing green precisely while the process was dead.
    expect(root.status.code).not.toBe(SpanStatusCode.OK);
    expect(root.attributes['gnl.status']).toBe('running');
  });

  it('reports a canceled run as UNSET/canceled — not ERROR, and never OK', async () => {
    const { cancelAgentRun } = await import('@gnldev/durable');
    const journal = new InMemoryStorage().runs;
    const never = { ...base, doGenerate: () => new Promise(() => {}) } as any;
    void runDurable({ runId: 'stopped', journal, model: never, prompt: 'x' } as any).catch(() => {});
    // Wait for the marker BEFORE cancelling: the cancel has to land on a run that is already
    // running, or it writes its verdict against nothing and the test measures the wrong sequence.
    await waitForRootStatus(journal, 'stopped', 'running');
    await cancelAgentRun(journal, 'stopped', { reason: 'operator' });

    const root = await rootSpanOf(journal, 'stopped');
    // OK would say the run ended fine, which it did not. ERROR would page an on-call because an
    // operator pressed cancel — the false alarm that trains people to ignore the signal. OTel reserves
    // ERROR for UNEXPECTED endings; this one was ordered. The fact travels on the attribute instead.
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
    expect(root.attributes['gnl.status'], 'this exported as OK/completed').toBe('canceled');
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

// The reason a failed run carries is not always the host's own text. A provider that refuses a
// request commonly echoes the offending input back inside the message, so the run's verdict can hold
// user data — and it reaches this exporter through a path no processor is consulted about:
// `piiRedactor` hooks processInput/processOutput/processToolResult, while the verdict is written by
// `recordRunOutcome` in @gnldev/durable. Measured with the redactor installed, the address still
// arrived raw in the span, and from there in whatever collector `endpoint` names.
describe('redacting the one free-text value a span carries', () => {
  const PII = 'victim.customer@realbank.example';
  const refusing = {
    ...base,
    doGenerate: async () => { throw new Error(`Invalid request: message contained disallowed content: "${PII}"`); },
  } as any;
  const maskEmails = (t: string) => t.replace(/[\w.+-]+@[\w.-]+/g, '[REDACTED_EMAIL]');

  const rootWith = async (runId: string, opts: any) => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId, journal, model: refusing, prompt: 'x' } as any).catch(() => {});
    const { exporter } = await exportRun(journal, runId, opts);
    const spans = (exporter as any).getFinishedSpans();
    return spans.find((s: any) => !s.parentSpanId && !s.parentSpanContext) ?? spans[0];
  };

  it('without `redact`, the message travels as-is — the documented default', async () => {
    const root = await rootWith('raw', {});
    // Pinned deliberately: the message is the main debugging value a trace carries and this package
    // cannot know whether `endpoint` is the host's own collector, so the choice is the caller's.
    expect(String(root.attributes['gnl.error'])).toContain(PII);
  });

  it('with `redact`, it reaches NEITHER the attribute nor the status message', async () => {
    const root = await rootWith('masked', { redact: maskEmails });
    // Both sites, because a mask on one of them is not a mask.
    expect(String(root.attributes['gnl.error'] ?? '')).not.toContain(PII);
    expect(String(root.status.message ?? ''), 'the status message leaks it just as far').not.toContain(PII);
    // Still actionable — only the address was removed, not the reason.
    expect(String(root.attributes['gnl.error'])).toContain('disallowed content');
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('a redactor that throws drops the message rather than falling back to the raw text', async () => {
    const root = await rootWith('boom', { redact: () => { throw new Error('bad regex'); } });
    // Fail CLOSED. Falling back to the raw text would send exactly the value the redactor was
    // installed to keep out, at the moment it is least likely to be noticed.
    expect(String(root.attributes['gnl.error'] ?? '')).not.toContain(PII);
    expect(String(root.status.message ?? '')).not.toContain(PII);
    // The run is still reported as failed — losing the reason must not lose the verdict.
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['gnl.status']).toBe('failed');
  });

  it('a redactor that returns a non-string is treated the same way', async () => {
    const root = await rootWith('wrong-type', { redact: (() => undefined) as any });
    expect(String(root.attributes['gnl.error'] ?? '')).not.toContain(PII);
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
  });
});
