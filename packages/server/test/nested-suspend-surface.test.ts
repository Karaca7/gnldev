// SORUYU SORANIN KİMLİĞİ SSE'DE DE GÖRÜNÜR.
//
// Motor iç içe askıda ÇOCUĞUN interrupt'larını yüzeye çıkarıyor (durable `surfacedInterrupts`) ve
// vekil (ebeveyn) id'sine verilen cevabı BİLİNÇLİ olarak yok sayıyor. Ama chat/SSE — asıl
// son-kullanıcı kanalı — interrupt'ı motordan değil kendi başına türetiyordu: `interruptsFromSteps`
// step part'larından ham `__gnl_suspend` sentinel'ini çekiyor, ve o sentinel ZORUNLU olarak vekilin
// id'siyle anahtarlı. Yani ekranda onaylayan insan, motorun yok saydığı kimliği gönderiyordu:
// sessiz no-op. Kapı çalışıyor, soru görünüyor, cevap hiçbir yere varmıyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const PROXY_TCID = 'call-devret';
const CHILD_TCID = 'alt-call-1';

const mkStream = (arr: unknown[]) =>
  new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

/** Ebeveyn: STREAM eder (SSE yolu). Bir kez alt ajanı çağırır, sonra biter. */
function parentMock(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      return done === 0
        ? { stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: PROXY_TCID, toolName: 'agent_alt', input: JSON.stringify({ task: 'parayı gönder' }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]) }
        : { stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ana bitti' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]) };
    },
  };
}

/** Çocuk: alt-ajan aracı içinde generateText ile koşar → doGenerate. */
function childMock(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doStream: async () => { throw new Error('no stream'); },
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      return done === 0
        ? { content: [{ type: 'tool-call', toolCallId: CHILD_TCID, toolName: 'paraGonder', input: JSON.stringify({ tutar: 500 }) }],
            finishReason: 'tool-calls', usage, warnings: [] }
        : { content: [{ type: 'text', text: 'alt bitti' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
}

function mkApi(charges: { n: number }) {
  return createRestApi({
    journal: new InMemoryJournal(),
    agents: {
      ana: { model: parentMock(), agents: ['alt'], maxSteps: 6 },
      alt: {
        model: childMock(),
        maxSteps: 6,
        tools: {
          paraGonder: { sideEffect: true, confirm: true as const, execute: async () => { charges.n++; return { ok: true }; } },
        },
      },
    },
  } as never);
}

async function readSSE(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event:\s*(.+)$/m.exec(block)?.[1];
    const data = /^data:\s*(.+)$/m.exec(block)?.[1];
    if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

describe('SSE: iç içe askıda çocuğun kimliği yüzeye çıkar', () => {
  it('interrupt event ÇOCUĞUN toolCallId\'sini taşır — vekil id yüzeyde hiç görünmez', async () => {
    const charges = { n: 0 };
    const res = await call(mkApi(charges), '/agents/ana/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'nss-1', prompt: 'devret' }),
    });
    const events = await readSSE(res);
    const interrupt = events.find((e) => e.event === 'interrupt');
    expect(interrupt, 'askı hiç yüzeye çıkmadı').toBeDefined();
    const ids = (interrupt!.data.interrupts as Array<{ toolCallId?: string }>).map((i) => i.toolCallId);
    expect(ids, 'ekranda vekil id gösteriliyor — onay sessiz no-op\'a düşer').toEqual([CHILD_TCID]);
    expect(ids).not.toContain(PROXY_TCID);
    expect(charges.n).toBe(0);
  });

  it('sıradan (iç içe olmayan) askının şekil sözleşmesi değişmez', async () => {
    const charges = { n: 0 };
    const api = createRestApi({
      journal: new InMemoryJournal(),
      agents: {
        pay: {
          model: {
            specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
            doGenerate: async () => { throw new Error('no gen'); },
            doStream: async ({ prompt }: any) => {
              const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
              return done === 0
                ? { stream: mkStream([
                    { type: 'stream-start', warnings: [] },
                    { type: 'tool-call', toolCallId: 'call-1', toolName: 'paraGonder', input: JSON.stringify({ tutar: 500 }) },
                    { type: 'finish', finishReason: 'tool-calls', usage },
                  ]) }
                : { stream: mkStream([
                    { type: 'stream-start', warnings: [] },
                    { type: 'text-start', id: '1' },
                    { type: 'text-delta', id: '1', delta: 'bitti' },
                    { type: 'text-end', id: '1' },
                    { type: 'finish', finishReason: 'stop', usage },
                  ]) };
            },
          } as never,
          maxSteps: 6,
          tools: { paraGonder: { sideEffect: true, confirm: true as const, execute: async () => { charges.n++; return { ok: true }; } } },
        },
      },
    } as never);
    const events = await readSSE(await call(api, '/agents/pay/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'nss-2', prompt: 'öde' }),
    }));
    const interrupts = events.find((e) => e.event === 'interrupt')!.data.interrupts as Array<Record<string, unknown>>;
    expect(interrupts.length).toBe(1);
    expect(interrupts[0]!.toolCallId).toBe('call-1');
    expect(interrupts[0]!.toolName).toBe('paraGonder');
    expect(interrupts[0]!.args).toEqual({ tutar: 500 });
    expect(charges.n).toBe(0);
  });
});
