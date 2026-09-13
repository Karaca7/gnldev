// GELEN KUTUSU SAHİBİNİ SÖYLER — kapının OKUMA tarafı.
//
// Eylem tarafı bitmişti: son kullanıcının damgasını taşıyan bir koşumu admin resume edemiyor
// (motorun sahiplik kilidi → 409 run_actor_mismatch). Ama gelen kutusu bunu HİÇ göstermiyordu:
// `GET /approvals` satırı {runId, toolCallId, toolName, args, reason, suspendedAt} taşıyordu ve
// sahiplik bilgisi yoktu. Ölçülen sonuç: operatör kullanıcı işini deneme-yanılmayla keşfediyor —
// Onayla'ya basıyor, 409 alıyor, bir sonraki satırda aynısını tekrar deniyor. Reddin kendisi doğru;
// önceden okunamaz olması yanlış.
//
// Karar: görünürlük adminde kalır, karar sahibinde. Satır listede DURUR, ama kimin olduğunu söyler.
//
// KİLİT İKİ İSİM İSTER, ve bu testler o inceliği ayrı ayrı mühürlüyor: `frozen.actor && opts.actor`
// şartı yüzünden `resourceId` dolu ama `actor` boş bir koşumda kilit HİÇ ateşlemez. Yani "sahipli"
// olmak tek başına reddi getirmez — `ownerActor` getirir. UI'ın düğmeyi hangi alana bakarak
// kapatacağı buradan çıkıyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, stampFormat } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

type Row = { runId: string; toolCallId: string; toolName: string; owner?: string; ownerActor?: string };

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

/** Onay isteyen tek araçlı bir ajan — gerçek bir askı (ve gerçek bir `:input`) bırakır. */
function gnlOf(journal: InMemoryJournal) {
  return createGnl({
    journal,
    agents: {
      pay: {
        model: mockModel(async ({ prompt }: any) =>
          countTools(prompt) === 0 ? toolCall('paraGonder', 'call-1', { tutar: 500 }) : finalText('bitti')),
        tools: { paraGonder: { sideEffect: true, confirm: true as const, execute: async () => ({ ok: true }) } },
      },
    },
  } as never);
}

async function inbox(journal: InMemoryJournal): Promise<Row[]> {
  const api = drive(createStudioApi({ reader: journal }));
  const body = await (await api(new Request('http://s/approvals'))).json() as { items: Row[] };
  return body.items;
}

describe('GET /approvals: satır sahibini taşır', () => {
  it('damgalı koşum owner + ownerActor döndürür', async () => {
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('pay', { runId: 'ao-1', prompt: 'öde', resourceId: 'u-ayse', actor: 'ayse' } as never);

    const row = (await inbox(journal)).find((i) => i.runId === 'ao-1');
    expect(row, 'askı gelen kutusunda hiç görünmedi').toBeDefined();
    expect(row!.owner).toBe('u-ayse');
    expect(row!.ownerActor).toBe('ayse');
  });

  it('sahipsiz koşumda alanlar HİÇ yok (boş string/null değil)', async () => {
    // `undefined` alan basmak da bir cevaptır ve yanlış cevaptır: JSON'da alan kaybolur ama tip
    // "sahip alanı hesaplandı" der. Deponun `...(x ? {x} : {})` deseni tam da bunun için var.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('pay', { runId: 'ao-2', prompt: 'öde' } as never);

    const row = (await inbox(journal)).find((i) => i.runId === 'ao-2')!;
    expect(row).toBeDefined();
    expect('owner' in row, 'sahipsiz satır sahiplik alanı taşıyor').toBe(false);
    expect('ownerActor' in row).toBe(false);
  });

  it('SAHİPLİ AMA DAMGASIZ: owner var, ownerActor yok — kilit ateşlemez, satır açık kalır', async () => {
    // Kilit `frozen.actor && opts.actor` ister. `resourceId` tek başına reddi getirmez; bu satırda
    // resume 409 DEĞİL, 200 döner. UI'ın düğmeyi kapatma şartı bu yüzden `ownerActor`'dır —
    // `owner`'a bakan bir arayüz, motorun kabul edeceği bir işi kullanıcıya yasaklardı.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('pay', { runId: 'ao-3', prompt: 'öde', resourceId: 'u-ayse' } as never);

    const row = (await inbox(journal)).find((i) => i.runId === 'ao-3')!;
    expect(row.owner).toBe('u-ayse');
    expect('ownerActor' in row, 'damgasız koşuma sahip aktörü uyduruldu').toBe(false);
  });

  it('MODELSİZ satır da (batch/kimlik kaydı yolu) sahibini taşır', async () => {
    // Bu satır `pending`den değil, askılı tool kaydının sentinel\'inden türüyor (batch mini-runner).
    // İki ayrı push noktası var; sahiplik yalnız birine eklenirse gelen kutusunun yarısı sessizce
    // sahipsiz görünür — ve sessizce sahipsiz görünen bir kullanıcı işi tam da kapatılan delik.
    const journal = new InMemoryJournal();
    const runId = 'batch:aylik-9:F-1';
    const sentinel = { __gnl_suspend: { toolCallId: 'item:F-1', toolName: 'payInvoice', args: { ref: 'F-1' }, reason: 'Duplicate side effect' } };
    await journal.put(`${runId}:tool:item:F-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 'payInvoice' }));
    // Kimlik-amaçlı `:input` (claimIdentityInput'un yazdığı şekil): frozen bir istek değil, sadece
    // kimin olduğu. Okuma tarafı için ayrımın önemi yok — alanlar aynı yerde durur.
    await journal.put(`${runId}:input`, stampFormat({ at: Date.now(), resourceId: 'u-ayse', actor: 'ayse', batch: 'aylik-9' }));

    const row = (await inbox(journal)).find((i) => i.runId === runId)!;
    expect(row).toBeDefined();
    expect(row.owner).toBe('u-ayse');
    expect(row.ownerActor).toBe('ayse');
  });
});
