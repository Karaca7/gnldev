// ALT AJANIN SORUSU İNSANA ULAŞIR.
//
// Ölçülen hâl: alt ajan bir insan kapısına çarpıyor, kendi koşumu `suspended` oluyor — ve ebeveyn
// `completed`, `interrupts: []` dönüyor. Yani kapı çalıştı, soru soruldu, İNSANA ULAŞMADI. "Son söz
// insanda" vaadinin sessizce boşa çıktığı hâl bu; üstelik kullanıcı hiçbir şey görmediği için
// ortada bir sorun olduğunu da bilmiyor.
//
// Sebep iki parçalıydı: (1) alt-ajan aracı `interrupts`'ı SIRADAN bir araç çıktısı olarak
// döndürüyordu, oysa motor askıyı `__gnl_suspend` işaretiyle tanıyor; (2) ebeveynin insan cevapları
// alt koşuma HİÇ inmiyordu, yani soru görünse bile cevaplanamazdı.
//
// İKİNCİ TUR (bu dosyanın ikinci yarısı): soru görünür oldu ama YANLIŞ KİMLİKLE görünüyordu —
// ebeveynin çağrı id'siyle. Standart istemci sözleşmesi `approvals[interrupt.toolCallId] = true`
// göndermek; onu yapan istemci sessiz bir no-op döngüsüne giriyordu. Aşağıdaki testler soruyu
// SORANIN kimliğini mühürlüyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, nestedAgentRunId } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult, toolCallResult, countToolResults } from './mock.js';

const TCID = 'call-devret';
const CHILD_TCID = 'alt-call-1';

/** Ana ajan bir kez alt ajanı çağırır; alt ajan onay isteyen bir aracı çağırır. */
function setup(journal: InMemoryJournal, counter?: { n: number }, childTcid = CHILD_TCID) {
  const altModel = createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0
      ? toolCallResult('paraGonder', childTcid, { tutar: 500 })
      : finalTextResult('alt bitti'));
  return createGnl({
    journal,
    agents: {
      ana: {
        model: createMockModel(async ({ prompt }: any) =>
          countToolResults(prompt) === 0 ? toolCallResult('agent_alt', TCID, { task: 'parayı gönder' }) : finalTextResult('ana bitti')),
        agents: ['alt'],
      },
      alt: {
        model: altModel,
        tools: {
          paraGonder: {
            sideEffect: true,
            confirm: true as const,
            execute: async () => { if (counter) counter.n++; return { ok: true }; },
          },
        },
      },
    },
  } as never);
}

describe('alt ajanın askısı görünür', () => {
  it('çocuk askıya girince EBEVEYN de askıya girer', async () => {
    const journal = new InMemoryJournal();
    const r = await setup(journal).run('ana', { runId: 'ns-1', prompt: 'devret' } as never);
    expect(r.interrupts.length, 'ebeveyn askıya girmedi — soru insana hiç ulaşmadı').toBeGreaterThan(0);
    // Çocuğun koşumu da gerçekten askıda (ikisi tutarlı olmalı, biri diğerini gizlememeli).
    const child = nestedAgentRunId('ns-1', TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:${CHILD_TCID}`))?.status).toBe('suspended');
  });

  it('soru SORANIN kimliğiyle yüzeye çıkar — ebeveynin vekil id\'siyle değil', async () => {
    // Cevap veren kişi neyi onayladığını görebilmeli, ve gördüğü kimlikle cevap verebilmeli.
    // Yüzeye ebeveynin id'si çıkarsa standart sözleşme (`approvals[interrupt.toolCallId]`) bir
    // vekile cevap vermiş olur — vekil kaydı birden çok çocuk sorusunu temsil edebildiği için o
    // cevap belirsizdir. Soru çocuğundur; kimlik de çocuğun olmalı.
    const journal = new InMemoryJournal();
    const r = await setup(journal).run('ana', { runId: 'ns-2', prompt: 'devret' } as never);
    const it0 = r.interrupts[0] as any;
    expect(it0?.toolCallId, 'yüzeydeki kimlik cevaplanabilir değil').toBe(CHILD_TCID);
    expect(it0?.toolName).toBe('paraGonder');
    // Bağlam kaybolmasın: insan bunun bir alt ajandan geldiğini okuyabilmeli.
    expect(String(it0?.reason)).toContain('sub-agent');
    expect(String(it0?.reason)).toContain('confirmation');
    // Vekil kimliği yüzeyde HİÇ görünmez.
    expect(r.interrupts.map((i: any) => i.toolCallId)).not.toContain(TCID);
  });

  it('ONAY çocuğa iner ve iş tamamlanır — yüzeydeki kimlikle', async () => {
    // Asıl kapanan halka: soru görünse bile cevap inmiyorsa askı sonsuza kadar kalır. Onay
    // haritası toolCallId ile anahtarlandığı ve çocuğun çağrı kimlikleri farklı olduğu için TEK
    // harita ikisini de taşıyor — ayrı bir eşleme kurmaya gerek yok. Burada onay, insanın GÖRDÜĞÜ
    // kimlikle veriliyor: standart sözleşmenin kendisi.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const r1 = await setup(journal, counter).run('ana', { runId: 'ns-3', prompt: 'devret' } as never);
    const asked = (r1.interrupts[0] as any).toolCallId;
    const r2 = await setup(journal, counter).run('ana', { runId: 'ns-3', prompt: 'devret', approvals: { [asked]: true } } as never);
    expect(r2.interrupts.length, 'onaydan sonra hâlâ askıda').toBe(0);
    const child = nestedAgentRunId('ns-3', TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:${CHILD_TCID}`))?.status).toBe('succeeded');
    expect(counter.n).toBe(1);
  });

  it('EBEVEYNİN vekil kimliğine verilen ONAY yok sayılır — sessiz no-op döngüsü yok', async () => {
    // Ölçülen tuzak: `approvals[ebeveynId] = true` askı kolunu geçiyordu, çocuk `{ebeveynId:true}`
    // ile yeniden koşuyor, çocuğun confirm'ü kendi id'sini bulamıyor, yine askıya giriyordu — her
    // turda sahte bir insan-onayı izi yazarak. Vekile verilen cevap artık HİÇBİR ŞEY yapmıyor.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await setup(journal, counter).run('ana', { runId: 'ns-5', prompt: 'devret' } as never);
    const r2 = await setup(journal, counter).run('ana', { runId: 'ns-5', prompt: 'devret', approvals: { [TCID]: true } } as never);
    expect(r2.interrupts.length, 'vekil onayı askıyı çözmüş — soru hâlâ cevaplanmamışken').toBeGreaterThan(0);
    expect(r2.interrupts[0]!.toolCallId).toBe(CHILD_TCID);
    expect(counter.n, 'vekil onayı yan etkiyi çalıştırdı').toBe(0);
    const child = nestedAgentRunId('ns-5', TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:${CHILD_TCID}`))?.status).toBe('suspended');
    // Sahte iz yazılmadı: vekile verilen cevap bir "bilerek tekrar" kararı değildir.
    expect(await journal.listKeys(`ns-5:proc:override-`)).toEqual([]);
  });

  it('EBEVEYNİN vekil kimliğine verilen RET yok sayılır — çocuk yetim kalmaz', async () => {
    // Daha kötü hâli: `approvals[ebeveynId] = false` ebeveyne 'denied' yazıyor, çocuk koşumu
    // sonsuza dek askıda yetim kalıyordu — kimse ona bir daha bakmıyor.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await setup(journal, counter).run('ana', { runId: 'ns-6', prompt: 'devret' } as never);
    const r2 = await setup(journal, counter).run('ana', { runId: 'ns-6', prompt: 'devret', approvals: { [TCID]: false } } as never);
    expect(r2.interrupts.length, 'vekil reddi soruyu yuttu').toBeGreaterThan(0);
    expect(r2.interrupts[0]!.toolCallId).toBe(CHILD_TCID);
    expect((await journal.get<{ status?: string }>(`ns-6:tool:${TCID}`))?.status)
      .toBe('suspended'); // 'denied' DEĞİL — vekile verilen ret ebeveyni kapatmaz
    expect(counter.n).toBe(0);
  });

  it('RET yolu uçtan uca: çocuk reddedilir, yan etki koşmaz, ebeveyn tamamlanır', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const r1 = await setup(journal, counter).run('ana', { runId: 'ns-7', prompt: 'devret' } as never);
    const asked = (r1.interrupts[0] as any).toolCallId;
    const r2 = await setup(journal, counter).run('ana', { runId: 'ns-7', prompt: 'devret', approvals: { [asked]: false } } as never);
    expect(counter.n, 'reddedilen iş yine de koştu').toBe(0);
    const child = nestedAgentRunId('ns-7', TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:${CHILD_TCID}`))?.status).toBe('denied');
    // Ret de bir cevaptır: ebeveyn serbest kalır ve çocuğun nihai sözünü alır.
    expect(r2.interrupts.length, 'ret sonrası ebeveyn hâlâ askıda — koşum hiç bitmiyor').toBe(0);
    expect((await journal.get<{ status?: string }>(`ns-7:tool:${TCID}`))?.status).toBe('succeeded');
  });

  it('ebeveynin onay haritası çocuğa OLDUĞU GİBİ inmez — aynı adlı id sızmaz', async () => {
    // Ardışık id üreten sağlayıcılarda ('call_0', 'call_1'…) ebeveynin KENDİ bir çağrısına verilmiş
    // "evet", çocuğun bambaşka bir insan-kapılı çağrısını açabiliyordu: iki ayrı koşumun id uzayı
    // aynı. Çocuk henüz hiçbir şey sormamışken ebeveynin haritasından hiçbir şey inmemeli.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const r = await setup(journal, counter, 'call_0').run(
      'ana', { runId: 'ns-8', prompt: 'devret', approvals: { call_0: true } } as never,
    );
    expect(counter.n, 'ebeveynin alakasız onayı çocuğun kapısını açtı').toBe(0);
    expect(r.interrupts.length, 'çocuk soru sormadan onaylandı').toBeGreaterThan(0);
    const child = nestedAgentRunId('ns-8', TCID);
    expect((await journal.get<{ status?: string }>(`${child}:tool:call_0`))?.status).toBe('suspended');
  });

  it('askı YOKKEN davranış değişmez — sentinel uydurulmaz', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: {
        ana: {
          model: createMockModel(async ({ prompt }: any) =>
            countToolResults(prompt) === 0 ? toolCallResult('agent_alt', 'c2', { task: 'x' }) : finalTextResult('ana bitti')),
          agents: ['alt'],
        },
        alt: { model: createMockModel(async () => finalTextResult('alt bitti')) },
      },
    } as never);
    const r = await gnl.run('ana', { runId: 'ns-4', prompt: 'devret' } as never);
    expect(r.interrupts).toEqual([]);
    expect(r.text).toBe('ana bitti');
  });
});
