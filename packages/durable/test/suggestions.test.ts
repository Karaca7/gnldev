// HERMES v1 — onay-kapılı öneri/öğrenme katmanı. Pinlenenler:
// 1) config çelişkileri THROW (iki şalter zorunlu, generate→model, embed↔embedModelId, v1'de yalnız
//    'on-approval', eşik aralıkları, listKeys yokluğu)
// 2) öğrenme geçişi: tamamlanan run → pending sugg (mekanizma cümlesi ZORUNLU, found:false → yok);
//    runId başına AT-MOST-ONCE (memo); resourceId yoksa öğrenme yok
// 3) birleşme: aynı ders ikinci run'da YENİ kayıt açmaz, kanıt ekler; farklı kullanıcı ayrı kayıt
// 4) kanıt çeşitliliği: aynı kullanıcı+thread+gün tekrarı 1 etkin kanıt + sameSourceWarning
// 5) onay kapısı: approve → lesson doğar; reject → doğmaz; karar FIRST-WINS
// 6) enjeksiyon: onaylı ders sonraki run'ın system'ına girer; provenance `<runId>:cfg:lessons`
//    DONAR (boş dahil) — onay sonrası aynı runId retry'ı yine ders GÖRMEZ; apply:false → hiç girmez
// 7) etki-altında damga: dersi enjekte edilmiş run, O dersin önerisine kanıt yazarsa tainted →
//    etkin sayaca girmez
// 8) terfi: promotion bloğu YOKSA org kod yolu hiç çalışmaz; varsa N farklı kullanıcı onayında
//    org-scope PENDING sugg doğar (kendiliğinden uygulanmaz), onaylanınca org dersi herkese enjekte
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import {
  validateSuggestionsConfig, evidenceQualityOf, suggKey, personalLessonKey, orgLessonKey,
  lessonProvenanceKey,
} from '../src/suggestions.js';
import type { SuggestionsConfig, SuggestionRecord } from '../src/suggestions.js';
import { createMockModel, finalTextResult } from './mock.js';

/** Ajan modeli: düz final metin; system'ı görebilmek için çağrı opsiyonlarını yakalar. */
function agentModel(captured?: any[]) {
  return createMockModel(async (opts: any) => {
    captured?.push(opts);
    return finalTextResult('done');
  });
}

/** Öğrenme modeli: sabit ders JSON'u döner; çağrı sayacı at-most-once'ı pinler. */
function learnModel(payload: { found: boolean; rule?: string; mechanism?: string }, counter?: { n: number }) {
  return createMockModel(async () => {
    if (counter) counter.n += 1;
    return finalTextResult(JSON.stringify({ rule: '', mechanism: '', ...payload }));
  });
}

const LESSON = { found: true, rule: 'Always confirm the target environment before deploys.', mechanism: 'Deploy mistakes come from environment ambiguity.' };

function gnlWith(journal: InMemoryJournal, suggestions: SuggestionsConfig, captured?: any[]) {
  return createGnl({ journal, agents: { a: { model: agentModel(captured) } }, suggestions });
}

describe('HERMES config kapıları', () => {
  const j = new InMemoryJournal();
  it('şalterler boolean değilse THROW', () => {
    expect(() => validateSuggestionsConfig({ generate: true } as any, j)).toThrow(/two-switch|switches/);
  });
  it('generate:true + model yok → THROW', () => {
    expect(() => validateSuggestionsConfig({ generate: true, apply: false } as any, j)).toThrow(/model/);
  });
  it('embed var embedModelId yok → THROW (damga kuralı)', () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, embed: async () => [[1]] } as any, j)).toThrow(/embedModelId/);
  });
  it("v1'de strategy yalnız 'on-approval' — 'batch' THROW", () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'batch' } } as any, j)).toThrow(/on-approval/);
  });
  it('eşik aralıkları: minUsers 0 ve ratio 1.5 THROW', () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'on-approval', threshold: { minUsers: 0 } } } as any, j)).toThrow(/minUsers/);
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'on-approval', threshold: { ratio: 1.5 } } } as any, j)).toThrow(/ratio/);
  });
  it('listKeys olmayan journal + generate → THROW', () => {
    const bare = { get: async () => undefined, put: async () => {} } as any;
    expect(() => validateSuggestionsConfig({ generate: true, apply: false, model: 'x/y' } as any, bare)).toThrow(/listKeys/);
  });
});

describe('HERMES öğrenme geçişi', () => {
  it('tamamlanan run pending öneri doğurur; aynı runId ikinci çağrıda model TEKRAR ÇAĞRILMAZ', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON, counter) });
    await gnl.run('a', { runId: 'r1', prompt: 'deploy this', resourceId: 'u1', threadId: 't1' });
    const pend = await gnl.suggestions!.list({ status: 'pending' });
    expect(pend).toHaveLength(1);
    expect(pend[0]!.rule).toBe(LESSON.rule);
    expect(pend[0]!.scope).toBe('personal');
    expect(pend[0]!.resourceId).toBe('u1');
    expect(counter.n).toBe(1);
    await gnl.run('a', { runId: 'r1', prompt: 'deploy this', resourceId: 'u1', threadId: 't1' });
    expect(counter.n).toBe(1); // at-most-once memo
    expect(await gnl.suggestions!.list({ status: 'pending' })).toHaveLength(1);
  });

  it('found:false ve mekanizmasız ders ÖNERİ DOĞURMAZ; resourceId yoksa öğrenme yok', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel({ found: false }) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    expect(await gnl.suggestions!.list()).toHaveLength(0);

    const j2 = new InMemoryJournal();
    const g2 = gnlWith(j2, { generate: true, apply: true, model: learnModel({ found: true, rule: 'rule only' }) });
    await g2.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    expect(await g2.suggestions!.list()).toHaveLength(0); // mechanism zorunlu

    const j3 = new InMemoryJournal();
    const g3 = gnlWith(j3, { generate: true, apply: true, model: learnModel(LESSON) });
    await g3.run('a', { runId: 'r1', prompt: 'x' }); // resourceId yok
    expect(await g3.suggestions!.list()).toHaveLength(0);
  });

  it('aynı ders ikinci run\'da BİRLEŞİR (tek kayıt, iki kanıt); farklı kullanıcıda AYRI kayıt', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1', threadId: 't2' });
    const mine = await gnl.suggestions!.list({ resourceId: 'u1' });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.evidence).toHaveLength(2);
    await gnl.run('a', { runId: 'r3', prompt: 'z', resourceId: 'u2', threadId: 't3' });
    expect(await gnl.suggestions!.list()).toHaveLength(2); // kişisel katman: kullanıcı başına ayrı doğum
  });
});

describe('HERMES kanıt disiplinleri', () => {
  it('çeşitlilik: aynı kullanıcı+thread+gün tekrarı 1 etkin kanıt + sameSourceWarning', () => {
    const at = Date.now();
    const q = evidenceQualityOf([
      { runId: 'r1', resourceId: 'u1', threadId: 't1', at },
      { runId: 'r2', resourceId: 'u1', threadId: 't1', at: at + 1000 },
      { runId: 'r3', resourceId: 'u1', threadId: 't1', at: at + 2000 },
    ]);
    expect(q.total).toBe(3);
    expect(q.effective).toBe(1);
    expect(q.sameSourceWarning).toBe(true);
    const q2 = evidenceQualityOf([
      { runId: 'r1', resourceId: 'u1', threadId: 't1', at },
      { runId: 'r2', resourceId: 'u2', threadId: 't2', at },
    ]);
    expect(q2.effective).toBe(2);
    expect(q2.sameSourceWarning).toBe(false);
  });

  it('etki-altında damga: dersi enjekte edilmiş run, o dersin önerisine TAINTED kanıt yazar', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    const [sugg] = await gnl.suggestions!.list({ status: 'pending' });
    await gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op' });
    // r2: ders enjekte edilir, öğrenme geçişi AYNI dersi tekrar önerir → merge + tainted
    await gnl.run('a', { runId: 'r2', prompt: 'x again', resourceId: 'u1', threadId: 't1' });
    const rec = await journal.get<SuggestionRecord>(suggKey(sugg!.id));
    expect(rec!.evidence).toHaveLength(2);
    expect(rec!.evidence[1]!.tainted).toBe(true);
    const q = evidenceQualityOf(rec!.evidence);
    expect(q.tainted).toBe(1);
    expect(q.effective).toBe(1); // gölge kanıt etkin sayaca giremez
  });
});

describe('HERMES onay kapısı + enjeksiyon', () => {
  it('approve → lesson doğar ve SONRAKİ run\'ın system\'ına girer; provenance donar; reject → doğmaz', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    const [sugg] = await gnl.suggestions!.list();
    const d = await gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op' });
    expect(d).toEqual({ status: 'approved', alreadyDecided: false });
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined();

    captured.length = 0;
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1', threadId: 't1' });
    expect(JSON.stringify(captured)).toContain(LESSON.rule);
    const prov = await journal.get<{ ids: string[] }>(lessonProvenanceKey('r2'));
    expect(prov!.ids).toEqual([personalLessonKey('u1', sugg!.id)]);

    // reject yolu: ikinci kullanıcının önerisi reddedilir → ders yok
    await gnl.run('a', { runId: 'r3', prompt: 'z', resourceId: 'u2', threadId: 't2' });
    const [s2] = await gnl.suggestions!.list({ status: 'pending' });
    await gnl.suggestions!.decide(s2!.id, { approve: false });
    expect(await journal.get(personalLessonKey('u2', s2!.id))).toBeUndefined();
  });

  it('karar FIRST-WINS: ikinci karar alreadyDecided ve İLK hükmü döner', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: false });
    const second = await gnl.suggestions!.decide(sugg!.id, { approve: true });
    expect(second).toEqual({ status: 'rejected', alreadyDecided: true });
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeUndefined();
  });

  it('DONMUŞ enjeksiyon: runId retry\'ı, arada onaylanan dersi GÖRMEZ (boş küme de donar)', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' }); // ders yokken koştu → boş donma
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: true });
    captured.length = 0;
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' }); // aynı runId retry
    expect(JSON.stringify(captured)).not.toContain(LESSON.rule); // donmuş boş küme kazanır
  });

  it('apply:false → onaylı ders ASLA enjekte edilmez ama kayıt YAŞAR', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: true });
    captured.length = 0;
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1' });
    expect(JSON.stringify(captured)).not.toContain(LESSON.rule);
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined(); // şalter dersi silmez
  });
});

describe('HERMES terfi (promotion)', () => {
  async function approveFor(gnl: ReturnType<typeof createGnl>, user: string, runId: string) {
    await gnl.run('a', { runId, prompt: 'x', resourceId: user, threadId: `t-${user}` });
    const pend = await gnl.suggestions!.list({ status: 'pending', resourceId: user });
    await gnl.suggestions!.decide(pend[0]!.id, { approve: true });
  }

  it('promotion bloğu YOKKEN 3 kullanıcı onayı org önerisi DOĞURMAZ', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) });
    for (const [i, u] of ['u1', 'u2', 'u3'].entries()) await approveFor(gnl, u, `r${i}`);
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(0);
  });

  it("'on-approval': N farklı kullanıcı onayında org-scope PENDING doğar; onaylanınca HERKESE enjekte", async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, {
      generate: true, apply: true, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 3, ratio: 0.2 } },
    }, captured);
    await approveFor(gnl, 'u1', 'r1');
    await approveFor(gnl, 'u2', 'r2');
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(0); // eşik altı
    await approveFor(gnl, 'u3', 'r3');
    const orgs = await gnl.suggestions!.list({ scope: 'org' });
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.status).toBe('pending'); // terfi kendiliğinden UYGULANMAZ
    expect(orgs[0]!.quality.distinctUsers).toBe(3);

    await gnl.suggestions!.decide(orgs[0]!.id, { approve: true, by: 'admin' });
    expect(await journal.get(orgLessonKey(orgs[0]!.id))).toBeDefined();
    captured.length = 0;
    await gnl.run('a', { runId: 'r-new', prompt: 'q', resourceId: 'u9', threadId: 't9' }); // dersi hiç onaylamamış kullanıcı
    expect(JSON.stringify(captured)).toContain(LESSON.rule); // org dersi herkese
  });

  it('org-yankı damgası: org dersi enjekteli YENİ kullanıcının aynı-kural önerisi TAINTED doğar', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, {
      generate: true, apply: true, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 3 } },
    });
    for (const [i, u] of ['u1', 'u2', 'u3'].entries()) await approveFor(gnl, u, `r${i}`);
    const [org] = await gnl.suggestions!.list({ scope: 'org' });
    await gnl.suggestions!.decide(org!.id, { approve: true });
    // u9: kişisel kaydı yok, org dersi enjekte; öğrenme geçişi aynı kuralı yankılar
    await gnl.run('a', { runId: 'r-echo', prompt: 'q', resourceId: 'u9', threadId: 't9' });
    const [echo] = await gnl.suggestions!.list({ resourceId: 'u9' });
    expect(echo).toBeDefined();
    expect(echo!.evidence[0]!.tainted).toBe(true); // gölge, scope sınırından kaçamaz
    expect(echo!.quality.effective).toBe(0);
  });

  it('tekrar onaylar AYNI org önerisini ikinci kez doğurmaz (deterministik id + claim)', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, {
      generate: true, apply: false, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 2 } },
    });
    for (const [i, u] of ['u1', 'u2', 'u3', 'u4'].entries()) await approveFor(gnl, u, `r${i}`);
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(1);
  });
});

describe('HERMES onarım + eşzamanlılık (denetçi bulguları)', () => {
  it('decide onarımı: lesson yazımı geçici düşerse SONRAKİ decide etkileri idempotent tamamlar', async () => {
    class FlakyJournal extends InMemoryJournal {
      failPutOf: string | undefined;
      override async put(key: string, value: unknown): Promise<void> {
        if (this.failPutOf && key === this.failPutOf) {
          this.failPutOf = undefined;
          throw new Error('transient journal hiccup');
        }
        return super.put(key, value);
      }
    }
    const journal = new FlakyJournal();
    const gnl = gnlWith(journal as InMemoryJournal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    journal.failPutOf = personalLessonKey('u1', sugg!.id);
    await expect(gnl.suggestions!.decide(sugg!.id, { approve: true })).rejects.toThrow(/transient/);
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeUndefined(); // yarım kaldı
    const second = await gnl.suggestions!.decide(sugg!.id, { approve: true });
    expect(second.alreadyDecided).toBe(true);
    expect(second.status).toBe('approved');
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined(); // onarım dersi doğurdu
  });

  it('GERÇEK eşzamanlı karar yarışı: tek hüküm, ders varlığı hükümle tutarlı', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    const [a, b] = await Promise.all([
      gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op-a' }),
      gnl.suggestions!.decide(sugg!.id, { approve: false, by: 'op-b' }),
    ]);
    expect(a.status).toBe(b.status); // iki operatör aynı hükmü görür
    expect([a.alreadyDecided, b.alreadyDecided].filter((x) => !x)).toHaveLength(1); // tek kazanan
    const rec = await journal.get<SuggestionRecord>(suggKey(sugg!.id));
    expect(rec!.status).toBe(a.status);
    const lesson = await journal.get(personalLessonKey('u1', sugg!.id));
    if (a.status === 'approved') expect(lesson).toBeDefined();
    else expect(lesson).toBeUndefined();
  });

  it('embed benzerliği: FARKLI metinli aynı-anlam ders vektör yolundan BİRLEŞİR', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const payloads = [
      { found: true, rule: 'Confirm the deploy target first.', mechanism: 'Ambiguity causes mistakes.' },
      { found: true, rule: 'Before deploying, verify which environment you target.', mechanism: 'Ambiguity causes mistakes.' },
    ];
    const seqModel = createMockModel(async () => finalTextResult(JSON.stringify(payloads[Math.min(counter.n++, 1)])));
    const gnl = gnlWith(journal, {
      generate: true, apply: false, model: seqModel,
      embed: async (texts: string[]) => texts.map(() => [1, 0]), // sabit vektör → kosinüs 1.0
      embedModelId: 'test-embed',
    });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1' });
    const mine = await gnl.suggestions!.list({ resourceId: 'u1' });
    expect(mine).toHaveLength(1); // exact eşleşmez, vektör birleştirir
    expect(mine[0]!.evidence).toHaveLength(2);
  });

  it("listKeys'siz journal'da apply:true da THROW (sessiz-inert şalter yasak)", () => {
    const bare = { get: async () => undefined, put: async () => {} } as any;
    expect(() => createGnl({ journal: bare, agents: { a: { model: agentModel() } }, suggestions: { generate: false, apply: true } }))
      .toThrow(/listKeys/);
  });
});
