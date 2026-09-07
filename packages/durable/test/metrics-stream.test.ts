// Regression: streamed runs wrote a WRONG materialized metrics row — durationMs 0, startTs = the
// finalize instant, modelSteps 1 — while the journal's own ts span showed the real duration (live
// repro: a 26.9s multi-step run recorded as 0ms/1-step). The thread ledger and Observability read
// this row, so streamed runs lied about duration/steps. These tests pin the CORRECT row on both
// reader shapes the call sites actually pass (a bare InMemoryJournal and the toJournal bridge).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { streamDurable } from '../src/run.js';
import { toJournal } from '../src/storage.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { metricsRunKey } from '../src/metrics.js';
import type { MetricsRunRow } from '../src/metrics.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const mk = (a: any[]) => new ReadableStream({ start(c) { for (const p of a) c.enqueue(p); c.close(); } });

/** Two-step streaming agent: tool-call step, then the final text step — with a real delay so the
    duration is measurable (>0) instead of accidentally-zero. */
function slowStreamAgent(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      await new Promise((r) => setTimeout(r, 60));
      if (done === 0) {
        return { stream: mk([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'ara', input: '{"q":"x"}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]) };
      }
      return { stream: mk([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'cevap' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]) };
    },
  };
}
const tools = { ara: tool({ description: 'd', inputSchema: z.object({ q: z.string() }), execute: async () => ({ ok: 1 }) }) };

async function waitRow(journal: any, runId: string): Promise<MetricsRunRow> {
  const t0 = Date.now();
  for (;;) {
    const row = await journal.get(metricsRunKey(runId));
    if (row) return row as MetricsRunRow;
    if (Date.now() - t0 > 2000) throw new Error('metrics row never appeared');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('streamed-run metrics row (regression: 0ms / 1-step lie)', () => {
  it('InMemoryJournal reader: duration spans the run, steps/tools counted', async () => {
    const journal = new InMemoryJournal();
    const r = await streamDurable({ runId: 'ms1', journal, model: slowStreamAgent(), tools, prompt: 'question', agentName: 'demo', stopWhen: stepCountIs(4) });
    await r.text;
    const row = await waitRow(journal, 'ms1');
    expect(row.modelSteps).toBe(2);
    expect(row.toolCalls).toBe(1);
    expect(row.durationMs).toBeGreaterThan(30); // two ~60ms model calls — never 0
    expect(row.totalTokens).toBe(30); // both steps' usage, not just the last one's
  });

  it('toJournal(storage.runs) bridge (the studio host wiring): same correct row', async () => {
    const storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    const r = await streamDurable({ runId: 'ms2', journal, model: slowStreamAgent(), tools, prompt: 'question', agentName: 'demo', stopWhen: stepCountIs(4) });
    await r.text;
    const row = await waitRow(journal, 'ms2');
    expect(row.modelSteps).toBe(2);
    expect(row.toolCalls).toBe(1);
    expect(row.durationMs).toBeGreaterThan(30);
    expect(row.totalTokens).toBe(30);
  });

  it('SqliteStorage bridge (the LIVE wiring that produced the 0ms row): same correct row', async () => {
    const { SqliteStorage } = await import('../src/sqlite-storage.js');
    const storage = new SqliteStorage(':memory:');
    const journal = toJournal(storage.runs);
    const r = await streamDurable({ runId: 'ms3', journal, model: slowStreamAgent(), tools, prompt: 'question', agentName: 'demo', stopWhen: stepCountIs(4) });
    await r.text;
    const row = await waitRow(journal, 'ms3');
    expect(row.modelSteps).toBe(2);
    expect(row.toolCalls).toBe(1);
    expect(row.durationMs).toBeGreaterThan(30);
    expect(row.totalTokens).toBe(30);
  });

  it('SINGLE-step stream (the exact live shape): duration spans input→finish, never 0', async () => {
    // A one-step streamed answer has exactly ONE visible journal row (`model:0`), written when the
    // stream ENDS — the ts-span heuristic read 0ms here (live: a 27s stream recorded as 0ms). The
    // fix anchors startTs to the ':input' stamp instead.
    const journal = new InMemoryJournal();
    const model: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { throw new Error('no gen'); },
      doStream: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { stream: mk([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'cevap' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]) };
      },
    };
    const r = await streamDurable({ runId: 'ms-single', journal, model, prompt: 'question', agentName: 'demo' });
    await r.text;
    const row = await waitRow(journal, 'ms-single');
    expect(row.modelSteps).toBe(1);
    expect(row.durationMs).toBeGreaterThan(50); // ~80ms model latency — the old heuristic said 0
  });

  it('registry gnl.stream over SqliteStorage (full live stack minus HTTP): same correct row', async () => {
    const { SqliteStorage } = await import('../src/sqlite-storage.js');
    const { createGnl } = await import('../src/registry.js');
    const storage = new SqliteStorage(':memory:');
    const gnl = createGnl({ storage, agents: { demo: { model: slowStreamAgent(), tools, maxSteps: 4 } } } as any);
    const r: any = await gnl.stream!('demo', { runId: 'ms4', prompt: 'question' });
    await r.text;
    const journal = toJournal(storage.runs);
    const row = await waitRow(journal, 'ms4');
    expect(row.modelSteps).toBe(2);
    expect(row.toolCalls).toBe(1);
    expect(row.durationMs).toBeGreaterThan(30);
    expect(row.totalTokens).toBe(30);
  });
});
