// GOREV W5 — zero-dependency OTLP/HTTP JSON exporter: toOtlpJson (PURE, no network) shape validation +
// exportRunToOtlp (fetch mocked). Does not touch the OTel SDK — index.test (otel.test.ts) covers exportRun.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal, runDurable, toTraceSpans } from '@gnl/durable';
import { toOtlpJson, exportRunToOtlp, otlpTraceId, otlpSpanId } from '../src/otlp.js';

// Avoid importing 'ai' (not a dep in the otel package) — minimal mock model, same as in otel.test.ts.
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

async function seededRun(runId = 'r'): Promise<InMemoryJournal> {
  const journal = new InMemoryJournal();
  await runDurable({ runId, journal, model: mkModel(), tools: { pay: { execute: async () => ({ paid: true }) } }, prompt: 'x' });
  return journal; // entries: model:0 (tool-call), tool:call-c, model:1 (final)
}

describe('toOtlpJson (PURE, no network)', () => {
  it('deterministic traceId/spanId: same runId → same id on every call', async () => {
    const journal = await seededRun('det-1');
    const spans = await toTraceSpans(journal, 'det-1');
    const a = toOtlpJson(spans, { runId: 'det-1' });
    const b = toOtlpJson(spans, { runId: 'det-1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId).toBe(otlpTraceId('det-1'));
  });

  it('1 root agent.run span + N child spans; child parentSpanId = root spanId; all share the same traceId', async () => {
    const journal = await seededRun('r2');
    const spans = await toTraceSpans(journal, 'r2');
    const payload = toOtlpJson(spans, { runId: 'r2', serviceName: 'svc' });
    const otlpSpans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

    expect(otlpSpans.length).toBe(spans.length + 1);
    const root = otlpSpans.find((s) => s.name === 'agent.run')!;
    expect(root).toBeDefined();
    expect(root.parentSpanId).toBeUndefined();
    expect(root.spanId).toBe(otlpSpanId('r2', 'root'));

    const children = otlpSpans.filter((s) => s.name !== 'agent.run');
    expect(children.length).toBe(spans.length);
    for (const c of children) {
      expect(c.traceId).toBe(root.traceId);
      expect(c.parentSpanId).toBe(root.spanId);
    }

    // resource attribute: service.name
    const svcAttr = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === 'service.name');
    expect(svcAttr?.value).toEqual({ stringValue: 'svc' });
  });

  it('nano times: startTimeUnixNano/endTimeUnixNano are strings, ms*1e6 and end >= start', async () => {
    const journal = await seededRun('r3');
    const spans = await toTraceSpans(journal, 'r3');
    const payload = toOtlpJson(spans, { runId: 'r3', now: 1_000 });
    for (const s of payload.resourceSpans[0]!.scopeSpans[0]!.spans) {
      expect(typeof s.startTimeUnixNano).toBe('string');
      expect(typeof s.endTimeUnixNano).toBe('string');
      expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
      // If ts is absent altogether (the mock model doesn't use real time but journal.put sets created_at), nano = ms * 1e6 divides evenly.
      expect(BigInt(s.startTimeUnixNano) % 1_000_000n).toBe(0n);
    }
  });

  it('if ts is absent altogether, opts.now fallback is used (deterministic test)', () => {
    const spans = [
      { name: 'llm.generate', kind: 'model' as const, runId: 'x', seq: 0, attributes: { 'gen_ai.usage.input_tokens': 1 } },
    ];
    const payload = toOtlpJson(spans, { runId: 'x', now: 42 });
    const child = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'llm.generate')!;
    expect(child.startTimeUnixNano).toBe((42n * 1_000_000n).toString());
  });

  it('attribute mapping: gnl.run.id, gnl.kind, gen_ai.usage.*, gen_ai.request.model (from response.model)', async () => {
    const journal = await seededRun('r4');
    const spans = await toTraceSpans(journal, 'r4');
    const payload = toOtlpJson(spans, { runId: 'r4' });
    const llm = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'llm.generate')!;
    const attrs = Object.fromEntries(llm.attributes.map((a) => [a.key, a.value]));
    expect(attrs['gnl.run.id']).toEqual({ stringValue: 'r4' });
    expect(attrs['gnl.kind']).toEqual({ stringValue: 'model' });
    expect(attrs['gen_ai.usage.input_tokens']).toEqual({ intValue: '10' });
    expect(attrs['gen_ai.usage.output_tokens']).toEqual({ intValue: '5' });
    expect(attrs['gen_ai.request.model']).toEqual({ stringValue: 'gpt-test' });

    const toolSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'tool.execute')!;
    const toolAttrs = Object.fromEntries(toolSpan.attributes.map((a) => [a.key, a.value]));
    expect(toolAttrs['gnl.kind']).toEqual({ stringValue: 'tool' });
    expect(toolAttrs['gnl.tool.status']).toEqual({ stringValue: 'succeeded' });
  });
});

describe('exportRunToOtlp (fetch mocked — no network)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST body = toOtlpJson output; endpoint + headers are passed through; result returns ok/status/traceId/spans', async () => {
    const journal = await seededRun('f1');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'f1', {
      endpoint: 'http://localhost:4318/v1/traces',
      headers: { authorization: 'Bearer tok' },
      serviceName: 'svc',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4318/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' });

    const spans = await toTraceSpans(journal, 'f1');
    const expected = toOtlpJson(spans, { runId: 'f1', serviceName: 'svc' });
    // Since now is not injected, real ts is used; the trace/span id + attribute part of the body must be deterministic.
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.spanId)).toEqual(
      expected.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.spanId),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.traceId).toBe(otlpTraceId('f1'));
    expect(result.spans).toBe(spans.length + 1);
  });

  it('fetch fails (4xx/5xx) → exportRunToOtlp does not throw, returns ok:false + status', async () => {
    const journal = await seededRun('f2');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    const result = await exportRunToOtlp(journal, 'f2', { endpoint: 'http://localhost:4318/v1/traces' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

// P2 (AUDIT-R2): opt-in retry/backoff. `backoffMs: 0` in most cases below to keep the suite
// fast — the exponential DEFAULT (500*2^n) is covered separately via a spy on the computed delays.
describe('exportRunToOtlp — retry (opt-in, zero-dep hand-rolled loop)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no retry config → exactly one fetch call (backward compat, unchanged default behavior)', async () => {
    const journal = await seededRun('rt-none');
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-none', { endpoint: 'http://x/v1/traces' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it('5xx then success → retried and succeeds', async () => {
    const journal = await seededRun('rt-5xx');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-5xx', {
      endpoint: 'http://x/v1/traces',
      retry: { attempts: 3, backoffMs: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('4xx (400) is NOT retried — single attempt, returns ok:false immediately', async () => {
    const journal = await seededRun('rt-400');
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-400', {
      endpoint: 'http://x/v1/traces',
      retry: { attempts: 3, backoffMs: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('attempts exhausted (persistent 5xx) → returns ok:false + last status, same shape as the no-retry path', async () => {
    const journal = await seededRun('rt-exhaust');
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-exhaust', {
      endpoint: 'http://x/v1/traces',
      retry: { attempts: 3, backoffMs: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('a persistent network error (fetch throws) → attempts exhausted → the error propagates (same as the no-retry path never catching it)', async () => {
    const journal = await seededRun('rt-neterr');
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      exportRunToOtlp(journal, 'rt-neterr', { endpoint: 'http://x/v1/traces', retry: { attempts: 3, backoffMs: 0 } }),
    ).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a network error that succeeds on the 2nd try → retried and succeeds', async () => {
    const journal = await seededRun('rt-neterr-ok');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-neterr-ok', {
      endpoint: 'http://x/v1/traces',
      retry: { attempts: 3, backoffMs: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('custom retryOn — caller can opt a 400 INTO retries', async () => {
    const journal = await seededRun('rt-custom');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return new Response(null, { status: calls < 2 ? 400 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportRunToOtlp(journal, 'rt-custom', {
      endpoint: 'http://x/v1/traces',
      retry: { attempts: 3, backoffMs: 0, retryOn: (r) => r === 400 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('Retry-After header (seconds) is honored on 429 — overrides backoffMs, capped at 30s', async () => {
    const journal = await seededRun('rt-retryafter');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
      const promise = exportRunToOtlp(journal, 'rt-retryafter', {
        endpoint: 'http://x/v1/traces',
        // backoffMs deliberately huge — if Retry-After weren't honored, this would blow the test timeout.
        retry: { attempts: 3, backoffMs: () => 999_999 },
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The scheduled delay came from Retry-After (1s = 1000ms), not backoffMs (999999ms).
      const delays = sleepSpy.mock.calls.map((c) => c[1] as number);
      expect(delays.some((d) => d === 1000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Retry-After is capped at 30s even if the header requests more', async () => {
    const journal = await seededRun('rt-retryafter-cap');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Header asks for a full hour — without the cap this test would need a real 3600s wait.
      if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const promise = exportRunToOtlp(journal, 'rt-retryafter-cap', {
        endpoint: 'http://x/v1/traces',
        retry: { attempts: 3 },
      });
      // If the cap didn't apply, the scheduled delay would be ~3600s and this would NOT be enough to
      // resolve the promise (fake timers never auto-advance past what we tell them to).
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('default backoffMs is exponential 500*2^n when no custom backoff/Retry-After is given', async () => {
    const journal = await seededRun('rt-default-backoff');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return new Response(null, { status: calls < 3 ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
      const promise = exportRunToOtlp(journal, 'rt-default-backoff', { endpoint: 'http://x/v1/traces', retry: { attempts: 3 } });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;
      const delays = sleepSpy.mock.calls.map((c) => c[1] as number);
      expect(delays).toEqual([500, 1000]); // 500*2^0, 500*2^1 — two retries before the 3rd (successful) attempt
    } finally {
      vi.useRealTimers();
    }
  });
});
