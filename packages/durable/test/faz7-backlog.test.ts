// FAZ-7 (backlog kapanışı) — pinlenenler:
// 1) stream lock HEARTBEAT: ttl'i aşan canlı stream'in kilidi devralınamaz (eski belgeli sınır
//    kapandı); stream bitince kilit yine serbest.
// 2) `lookup` (read-before-write): exists:true → gövde HİÇ koşmaz, bulunan çıktı journallanır ve
//    replay olur; exists:false → normal; throw → loud warn + fail-open; taze-olmayan kayıt lookup'a
//    hiç gitmez (crash penceresi recover'ındır).
// 3) auditOnReject 'require': ledger yazımı ret'in ÖN KOŞULU — yazım patlarsa ret yerine audit
//    hatası yayılır; 'best-effort' (default) eski davranış.
// 4) preset 'critical' network yolu: alt-ajanın bildirimsiz side-effect aracı strict-critical'a takılır.
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunInputMismatchError } from '../src/errors.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, createMockStreamAgent, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { tool } from 'ai';
import { z } from 'zod';

const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(6), prompt: 'x', ...extra,
});
const textModel = () => createMockModel(async () => finalTextResult('done'));

describe('FAZ-7 stream lock heartbeat', () => {
  it('ttl-aşan CANLI stream devralınamaz (renew çalışıyor); bitişte kilit serbest', async () => {
    const journal = new InMemoryJournal();
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        // Araç ttl'den (40ms) uzun sürer → heartbeat'siz dünyada kilit bu sırada düşerdi.
        execute: async ({ amount }) => { await new Promise((r) => setTimeout(r, 600)); return { charged: amount }; },
      }),
    };
    const r = await streamDurable({
      runId: 'hb1', journal, model: createMockStreamAgent(), tools,
      prompt: 'charge', stopWhen: stepCountIs(6), lock: { owner: 'A', ttlMs: 200 },
    } as any);
    const textP = r.text; // stream'i sür
    await new Promise((res) => setTimeout(res, 350)); // ttl (200ms) geçti, araç hâlâ koşuyor
    const thief = await acquireRunLock(journal, 'hb1', 'thief', 60_000);
    expect(thief).toBeNull(); // ESKİ dünyada burası takeover'dı — heartbeat kilidi canlı tuttu
    await textP; // bitir
    await new Promise((res) => setTimeout(res, 100)); // onFinish release'i otursun
    const after = await acquireRunLock(journal, 'hb1', 'later', 60_000);
    expect(after).not.toBeNull(); // bitince serbest — sızıntı yok
    await after!.release();
  });
});

describe('FAZ-7 stream lock heartbeat — cap dalı (denetçi K15/K23)', () => {
  it('maxHoldMs aşılınca beat durur (loud warn), TTL devralabilir', async () => {
    const journal = new InMemoryJournal();
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => { await new Promise((r) => setTimeout(r, 700)); return { charged: amount }; },
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await streamDurable({
        runId: 'hbcap', journal, model: createMockStreamAgent(), tools,
        prompt: 'charge', stopWhen: stepCountIs(6),
        lock: { owner: 'A', ttlMs: 120, maxHoldMs: 150 }, // cap enjekte edildi (K23)
      } as any);
      const textP = r.text;
      await new Promise((res) => setTimeout(res, 450)); // cap (150) + ttl (120) fazlasıyla geçti
      const thief = await acquireRunLock(journal, 'hbcap', 'thief', 60_000);
      expect(thief).not.toBeNull(); // beat durdu → TTL devraldı — abandonment sınırı GERÇEK
      expect(warn.mock.calls.some((c) => String(c[0]).includes('renewal cap'))).toBe(true); // sessiz değil
      await thief!.release();
      await textP.catch(() => {});
    } finally { warn.mockRestore(); }
  });
});

describe('FAZ-7 lookup (read-before-write)', () => {
  const model = (callId: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('charge', callId, args) : finalTextResult('done'));

  it('exists:true → gövde hiç koşmaz, bulunan çıktı journallanır ve replay olur; idempotencyKey iletilir', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    let seenKey: string | undefined;
    const tools = {
      charge: {
        sideEffect: true,
        lookup: async (_i: unknown, { idempotencyKey }: any) => { seenKey = idempotencyKey; return { exists: true as const, output: { charged: 50, via: 'lookup' } }; },
        execute: async () => { counter.n++; return { charged: 50, via: 'execute' }; },
      },
    };
    const r1 = await runDurable(base(journal, 'lk1', { model: model('c1', { amount: 50 }), tools }) as any);
    expect(counter.n).toBe(0); // dış sistem "zaten var" dedi — etki asla ateşlenmedi
    expect(JSON.stringify(r1.steps)).toContain('"via":"lookup"');
    expect(seenKey).toContain('lk1'); // downstream anahtar sözleşmesi iletildi
    // journallandı → replay, lookup bile tekrar çağrılmaz (fast-path):
    seenKey = undefined;
    await runDurable(base(journal, 'lk1', { model: model('c1', { amount: 50 }), tools }) as any);
    expect(seenKey).toBeUndefined();
    expect(counter.n).toBe(0);
  });

  it('exists:false → normal koşar; throw → loud warn + fail-open (bugünkü davranış)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const mk = (lookup: any) => ({ charge: { sideEffect: true, lookup, execute: async () => { counter.n++; return { ok: 1 }; } } });
    await runDurable(base(journal, 'lk2', { model: model('c1', { amount: 1 }), tools: mk(async () => ({ exists: false })) }) as any);
    expect(counter.n).toBe(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'lk3', { model: model('c1', { amount: 2 }), tools: mk(async () => { throw new Error('registry down'); }) }) as any);
      expect(counter.n).toBe(2); // iş bloklanmadı
      expect(warn.mock.calls.some((c) => String(c[0]).includes('lookup() failed'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('taze olmayan kayıt (failed) lookup\'a gitmez — crash penceresi recover merdiveninindir', async () => {
    const journal = new InMemoryJournal();
    let lookups = 0;
    let explode = true;
    const tools = {
      charge: {
        sideEffect: true,
        lookup: async () => { lookups++; return { exists: false as const }; },
        execute: async () => { if (explode) throw new Error('boom'); return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'lk4', { model: model('c1', { amount: 3 }), tools }) as any).catch(() => {});
    expect(lookups).toBe(1); // taze çağrıda soruldu
    explode = false;
    await runDurable(base(journal, 'lk4', { model: model('c1', { amount: 3 }), tools }) as any).catch(() => {});
    expect(lookups).toBe(1); // failed kayıt → merdiven; lookup bir daha SORULMADI
  });
});

describe('FAZ-7 lookup × suspended→onay (denetçi K6)', () => {
  it('askıdan onayla dönen çağrıda lookup SORULUR — bekleme sırasında oluşan ikiz yakalanır', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const external = { created: false }; // dış sistem
    const tools = {
      charge: {
        sideEffect: true,
        confirm: true, // askıya düşür
        lookup: async () => external.created ? { exists: true as const, output: { via: 'lookup' } } : { exists: false as const },
        execute: async () => { counter.n++; return { via: 'execute' }; },
      },
    };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'c1', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, 'ls1', { model, tools }) as any); // confirm → suspended
    expect(counter.n).toBe(0);
    external.created = true; // beklerken out-of-band ikiz oluştu
    const r = await runDurable(base(journal, 'ls1', { model, tools, approvals: { 'c1': true } }) as any);
    expect(counter.n).toBe(0); // onaya rağmen gövde ATEŞLENMEDİ — read-before-write askı yolunda da çalıştı
    expect(JSON.stringify(r.steps)).toContain('"via":"lookup"');
  });
});

describe("FAZ-7 auditOnReject: 'require'", () => {
  it('ledger yazımı patlarsa ret YERİNE audit hatası yayılır; best-effort eski davranış', async () => {
    const mkJournal = (failLedger: boolean) => {
      const inner = new InMemoryJournal();
      const j: any = new Proxy(inner, {
        get: (t, p) => {
          if (p === 'put' && failLedger) {
            return async (k: string, v: unknown) => {
              if (k.startsWith('idem:conflict:')) throw new Error('audit store down');
              return inner.put(k, v);
            };
          }
          const val = (t as any)[p];
          return val instanceof Function ? val.bind(t) : val;
        },
      });
      return j;
    };
    // require: refusal'ın ön koşulu — audit yazılamıyorsa 409 yerine audit hatası
    const j1 = mkJournal(true);
    await runDurable(base(j1, 'ar1', { model: textModel(), prompt: 'A', strictInput: true, conflictLedger: true, auditOnReject: 'require' }) as any);
    await expect(
      runDurable(base(j1, 'ar1', { model: textModel(), prompt: 'B', strictInput: true, conflictLedger: true, auditOnReject: 'require' }) as any),
    ).rejects.toThrow('audit store down');
    // best-effort (default): ret aynen yayılır, ledger hatası warn'a düşer
    const j2 = mkJournal(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(j2, 'ar2', { model: textModel(), prompt: 'A', strictInput: true, conflictLedger: true }) as any);
      await expect(
        runDurable(base(j2, 'ar2', { model: textModel(), prompt: 'B', strictInput: true, conflictLedger: true }) as any),
      ).rejects.toBeInstanceOf(RunInputMismatchError);
    } finally { warn.mockRestore(); }
  });
});

describe("FAZ-7 require × RunBusy sitesi (denetçi küçük)", () => {
  it('kilit reddi de kayıtsız kalamaz: ledger patlarsa RunBusy yerine audit hatası', async () => {
    const inner = new InMemoryJournal();
    const journal: any = new Proxy(inner, {
      get: (t, p) => {
        if (p === 'put') return async (k: string, v: unknown) => {
          if (k.startsWith('idem:conflict:')) throw new Error('audit store down');
          return inner.put(k, v);
        };
        const val = (t as any)[p];
        return val instanceof Function ? val.bind(t) : val;
      },
    });
    const held = await acquireRunLock(journal, 'rb1', 'other', 60_000);
    expect(held).not.toBeNull();
    await expect(
      runDurable(base(journal, 'rb1', {
        model: textModel(), conflictLedger: true, auditOnReject: 'require',
        lock: { owner: 'me', ttlMs: 60_000 },
      }) as any),
    ).rejects.toThrow('audit store down'); // RunBusyError değil — önce kayıt, sonra ret
  });
});

describe("FAZ-7 preset 'critical' network yolu", () => {
  it('alt-ajanın bildirimsiz side-effect aracı strict-critical kalıtımına takılır', async () => {
    const route = JSON.stringify({ action: 'route', agent: 'payer', task: 'pay it' });
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      preset: 'critical',
      agents: {
        payer: {
          model: createMockModel(async () => finalTextResult('paid')),
          tools: { mystery: { sideEffect: true, execute: async () => ({ ok: 1 }) } }, // recover/idempotencyKey YOK
        } as any,
      },
      networks: { n: { router: createMockModel(async () => finalTextResult(route)), agents: ['payer'] } as any },
    });
    await expect(gnl.runNetwork('n', { runId: 'nw1', task: 'pay' })).rejects.toThrow(/strict-critical/);
  });

  it("kalıtılan sideEffectDuplicates 'suspend' alt-ajanda çalışır; explicit opts.limits KAZANIR", async () => {
    const routeMsg = JSON.stringify({ action: 'route', agent: 'payer', task: 'pay twice' });
    const finalMsg = JSON.stringify({ action: 'final', answer: 'done' });
    const mkGnl = () => {
      const counter = { n: 0 };
      let routerCall = 0;
      const gnl = createGnl({
        journal: new InMemoryJournal(),
        preset: 'critical',
        agents: {
          payer: {
            // Alt-ajan AYNI argümanlarla iki kez çağırır → run-scope dup marker devreye girer.
            model: createMockModel(async ({ prompt }: any) => {
              const done = countToolResults(prompt);
              if (done < 2) return toolCallResult('send', `c${done + 1}`, { to: 'x' });
              return finalTextResult('paid');
            }),
            tools: { send: { sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => { counter.n++; return { ok: 1 }; } } },
            maxSteps: 6,
          } as any,
        },
        networks: { n: { router: createMockModel(async () => finalTextResult(routerCall++ === 0 ? routeMsg : finalMsg)), agents: ['payer'] } as any },
      });
      return { gnl, counter };
    };
    const a = mkGnl();
    await a.gnl.runNetwork('n', { runId: 'nw2', task: 'pay' });
    expect(a.counter.n).toBe(1); // kalıtılan 'suspend': özdeş ikinci çağrı ateşlenmedi (askıya düştü)
    const b = mkGnl();
    await b.gnl.runNetwork('n', { runId: 'nw3', task: 'pay', limits: { sideEffectDuplicates: 'off' } });
    expect(b.counter.n).toBe(2); // explicit opts.limits kazandı — kalıtım ezildi
  });
});
