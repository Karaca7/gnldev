// ONAY GELEN KUTUSU DA SORUYU SORANIN KİMLİĞİNİ GÖSTERİR.
//
// Motor iç içe askıda ÇOCUĞUN interrupt'larını yüzeye çıkarıyor ve vekil (ebeveyn) id'sine verilen
// cevabı bilinçli olarak yok sayıyor. Gelen kutusu ise interrupt'ı motordan değil journal'daki
// askılı TOOL kaydından kendisi türetiyordu — ve o kayıt ZORUNLU olarak vekilin id'siyle anahtarlı.
// Sonuç: operatör listede hiçbir zaman cevaplanamayacak bir satır görüyor; "Onayla" düğmesi motorun
// yok saydığı kimliği gönderiyor ve hiçbir şey olmuyor. Görünen ama işlemeyen bir kapı, olmayandan
// kötüdür.
//
// Bu dosya satırın KİMLİĞİNİ ve o kimliğin GERÇEKTEN İŞE YARADIĞINI birlikte mühürlüyor: uçtan uca,
// listeden okunan id ile onay gönderildiğinde koşum tamamlanıyor ve yan etki bir kez koşuyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, nestedAgentRunId } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

const PROXY_TCID = 'call-devret';
const CHILD_TCID = 'alt-call-1';
const RUN_ID = 'nsi-1';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const countTools = (prompt: any[]) => (prompt ?? []).filter((m: any) => m?.role === 'tool').length;

function mockModel(doGenerate: (o: any) => Promise<any>): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate, doStream: async () => { throw new Error('no stream'); },
  };
}
const toolCall = (toolName: string, toolCallId: string, args: unknown) => ({
  content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(args) }],
  finishReason: 'tool-calls', usage, warnings: [] as unknown[],
});
const finalText = (text: string) => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] as unknown[] });

/** Ana ajan bir kez alt ajanı çağırır; alt ajan onay isteyen bir aracı çağırır. */
function gnlOf(journal: InMemoryJournal, charges: { n: number }) {
  return createGnl({
    journal,
    agents: {
      ana: {
        model: mockModel(async ({ prompt }: any) =>
          countTools(prompt) === 0 ? toolCall('agent_alt', PROXY_TCID, { task: 'parayı gönder' }) : finalText('ana bitti')),
        agents: ['alt'],
      },
      alt: {
        model: mockModel(async ({ prompt }: any) =>
          countTools(prompt) === 0 ? toolCall('paraGonder', CHILD_TCID, { tutar: 500 }) : finalText('alt bitti')),
        tools: { paraGonder: { sideEffect: true, confirm: true as const, execute: async () => { charges.n++; return { ok: true }; } } },
      },
    },
  } as never);
}

describe('onay gelen kutusu: iç içe askı', () => {
  it('satır ÇOCUĞUN toolCallId\'siyle listelenir — vekil id listede yok', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    await gnlOf(journal, charges).run('ana', { runId: RUN_ID, prompt: 'devret' } as never);

    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/approvals'))).json() as {
      items: Array<{ runId: string; toolCallId: string; toolName: string; reason?: string }>;
    };
    const rows = body.items.filter((i) => i.runId === RUN_ID);
    expect(rows.map((r) => r.toolCallId), 'gelen kutusu cevaplanamayan bir id gösteriyor')
      .toEqual([CHILD_TCID]);
    expect(rows[0]!.toolName).toBe('paraGonder');
    // Bağlam kaybolmasın: operatör bunun bir alt ajandan geldiğini okuyabilmeli.
    expect(String(rows[0]!.reason)).toContain('sub-agent');
    expect(charges.n).toBe(0);
  });

  it('UÇTAN UCA: listeden okunan id ile onay → koşum tamamlanır, yan etki BİR KEZ koşar', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    await gnlOf(journal, charges).run('ana', { runId: RUN_ID, prompt: 'devret' } as never);

    const api = drive(createStudioApi({
      reader: journal,
      resume: async (runId, approvals) =>
        gnlOf(journal, charges).run('ana', { runId, prompt: 'devret', approvals } as never) as never,
    }));
    const inbox = await (await api(new Request('http://s/approvals'))).json() as { items: Array<{ runId: string; toolCallId: string }> };
    const row = inbox.items.find((i) => i.runId === RUN_ID)!;

    const res = await api(new Request(`http://s/runs/${RUN_ID}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { [row.toolCallId]: true } }),
    }));
    expect(res.status).toBe(200);
    const out = await res.json() as { interrupts?: unknown[] };
    expect(out.interrupts ?? [], 'onaydan sonra hâlâ askıda').toEqual([]);
    expect(charges.n).toBe(1);
    const child = nestedAgentRunId(RUN_ID, PROXY_TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:${CHILD_TCID}`))?.status).toBe('succeeded');
  });

  it('sıradan (iç içe olmayan) askının satırı değişmez', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const gnl = createGnl({
      journal,
      agents: {
        pay: {
          model: mockModel(async ({ prompt }: any) =>
            countTools(prompt) === 0 ? toolCall('paraGonder', 'call-1', { tutar: 500 }) : finalText('bitti')),
          tools: { paraGonder: { sideEffect: true, confirm: true as const, execute: async () => { charges.n++; return { ok: true }; } } },
        },
      },
    } as never);
    await gnl.run('pay', { runId: 'nsi-2', prompt: 'öde' } as never);
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/approvals'))).json() as {
      items: Array<{ runId: string; toolCallId: string; toolName: string; args?: unknown; reason?: string }>;
    };
    const rows = body.items.filter((i) => i.runId === 'nsi-2');
    expect(rows.length).toBe(1);
    expect(rows[0]!.toolCallId).toBe('call-1');
    expect(rows[0]!.toolName).toBe('paraGonder');
    expect(rows[0]!.args).toEqual({ tutar: 500 });
    expect(rows[0]!.reason).toBeTruthy();
  });
});
