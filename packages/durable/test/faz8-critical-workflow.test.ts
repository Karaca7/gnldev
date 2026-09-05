// FAZ-8 — critical preset'in WORKFLOW kapsaması. Pinlenenler: runId zorunlu; sideEffect adım
// recover'sız reddedilir; tombstone reject; input fingerprint (bir runId = bir girdi, resume aynı
// girdiyle serbest); eşzamanlı ikiz RunBusyError; kilit bitişte serbest; non-critical davranış aynen.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { RunBusyError, RunSweptError, RunInputMismatchError } from '../src/errors.js';
import { readIdemLedger } from '../src/idem-ledger.js';

const wfDef = (steps: any[] = []) => ({
  async run(input: unknown) { return { got: input }; },
  build: () => steps,
});

const mk = (preset?: 'critical', wf: any = wfDef()) =>
  createGnl({ journal: new InMemoryJournal(), preset, workflows: { w: wf as any } });

describe('FAZ-8 critical × runWorkflow', () => {
  it('runId zorunlu; non-critical eski davranış (warn + üretilmiş id)', async () => {
    await expect(mk('critical').runWorkflow('w', { a: 1 })).rejects.toThrow(/requires an explicit runId/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await mk(undefined).runWorkflow('w', { a: 1 });
      expect(r.runId).toMatch(/^wf-w-/); // non-critical: loud fallback aynen
    } finally { warn.mockRestore(); }
  });

  it("sideEffect adım recover'sız reddedilir; recover'lıysa geçer", async () => {
    const bad = wfDef([{ id: 'charge', run: async () => 1, durability: { sideEffect: true } }]);
    await expect(mk('critical', bad).runWorkflow('w', {}, { runId: 'cw1' })).rejects.toThrow(/sideEffect without recover/);
    const good = wfDef([{ id: 'charge', run: async () => 1, durability: { sideEffect: true, recover: async () => ({ done: false }) } }]);
    await expect(mk('critical', good).runWorkflow('w', {}, { runId: 'cw2' })).resolves.toBeTruthy();
  });

  it('input fingerprint: aynı runId + farklı girdi → 409 sınıfı; AYNI girdiyle resume serbest; ledger kaydı düşer', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: wfDef() as any } });
    await gnl.runWorkflow('w', { q: 'A' }, { runId: 'fp1' });
    await expect(gnl.runWorkflow('w', { q: 'B' }, { runId: 'fp1' })).rejects.toBeInstanceOf(RunInputMismatchError);
    await expect(gnl.runWorkflow('w', { q: 'A' }, { runId: 'fp1' })).resolves.toBeTruthy(); // replay/resume meşru
    const ledger = await readIdemLedger(journal, { runId: 'fp1' });
    expect(ledger.some((r) => r.code === 'run_input_mismatch')).toBe(true);
  });

  it('tombstone reject: süpürülmüş id yeniden koşturulamaz', async () => {
    const journal = new InMemoryJournal();
    await journal.put('tb1:swept', { at: 1 });
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: wfDef() as any } });
    await expect(gnl.runWorkflow('w', {}, { runId: 'tb1' })).rejects.toBeInstanceOf(RunSweptError);
  });

  it('eşzamanlı ikiz: kaybeden RunBusyError; bitişte kilit serbest (ardışık resume çalışır)', async () => {
    const journal = new InMemoryJournal();
    const slow = {
      async run(input: unknown) { await new Promise((r) => setTimeout(r, 60)); return { got: input }; },
      build: () => [],
    };
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: slow as any } });
    const [a, b] = await Promise.allSettled([
      gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' }),
      gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const loser = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(RunBusyError);
    await expect(gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' })).resolves.toBeTruthy(); // kilit sızmadı
  });
});

// FAZ-8 denetçi bulguları — resume escape'leri (BLOKER), kombinatör runtime ağı, K4 claim dönüşü.
import { workflow, step } from '@gnldev/workflow';

describe('FAZ-8 denetçi düzeltmeleri', () => {
  it('BLOKER: askıdaki critical workflow, GERÇEK resume yüzeyi gibi (input GÖNDERMEDEN) onaylanabilir', async () => {
    const suspending = {
      async run() { return 1; },
      build: () => [],
      async runResumable(_input: unknown, _ctx: unknown, o?: { resume?: Record<string, unknown> }) {
        if (o?.resume?.ok === undefined) return { status: 'suspended' as const, stepId: 's1', waitId: 'ok' };
        return { status: 'completed' as const, output: { approved: o.resume.ok } };
      },
    };
    const gnl = createGnl({ journal: new InMemoryJournal(), preset: 'critical', workflows: { w: suspending as any } });
    const first = await gnl.runWorkflow('w', { q: 'A' }, { runId: 'rs1' });
    expect(first.suspended).toBe(true);
    // Studio inbox / server resume rotası input taşımaz — eski kod burada RunInputMismatchError atardı:
    const resumed = await gnl.runWorkflow('w', undefined, { runId: 'rs1', resume: { ok: true } });
    expect(resumed.output).toEqual({ approved: true });
    // opts.resume TAŞIYAN çağrı da (input'lu bile olsa) resume niyetidir:
    await expect(gnl.runWorkflow('w', { q: 'FARKLI' }, { runId: 'rs1', resume: { ok: true } })).resolves.toBeTruthy();
    // Ama resume niyeti OLMAYAN farklı-girdili çağrı hâlâ 409 sınıfı:
    await expect(gnl.runWorkflow('w', { q: 'FARKLI' }, { runId: 'rs1' })).rejects.toBeInstanceOf(RunInputMismatchError);
  });

  it('kombinatör runtime ağı: parallel içindeki recover\'sız sideEffect adım build-kapısını geçse de RUNTIME\'da reddedilir', async () => {
    const wf = workflow<number>().parallel(
      [step('charge', async () => ({ ok: 1 }), { sideEffect: true })], // recover YOK — build() bunu göremez
      'par',
    );
    const gnl = createGnl({ journal: new InMemoryJournal(), preset: 'critical', workflows: { w: wf as any } });
    await expect(gnl.runWorkflow('w', 1, { runId: 'cn1' })).rejects.toThrow(/strictSideEffects.*charge/s);
    // Non-critical aynı workflow serbest (opt-in sözleşmesi):
    const free = createGnl({ journal: new InMemoryJournal(), workflows: { w: wf as any } });
    await expect(free.runWorkflow('w', 1, { runId: 'cn2' })).resolves.toBeTruthy();
  });

  it('K4: fingerprint claim yarışını kaybeden FARKLI girdi, kazananın hash\'ine karşı 409 alır', async () => {
    const inner = new InMemoryJournal();
    let firstGet = true;
    const journal: any = new Proxy(inner, {
      get: (t, p) => {
        if (p === 'get') return async (k: string) => {
          if (k.endsWith(':wf:_input') && firstGet) { firstGet = false; return undefined; } // yarış penceresi
          return inner.get(k);
        };
        const val = (t as any)[p];
        return val instanceof Function ? val.bind(t) : val;
      },
    });
    // Kazanan (girdi X) claim'i çoktan yazmış:
    const { argsHash } = await import('../src/hash.js');
    await inner.put('k4:wf:_input', { hash: argsHash({ q: 'X' }), at: 1 });
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: { async run(i: unknown) { return i; }, build: () => [] } as any } });
    // Kaybeden (girdi Y): get undefined görür → claim false → yeniden okur → kazananla uyuşmaz → 409
    await expect(gnl.runWorkflow('w', { q: 'Y' }, { runId: 'k4' })).rejects.toBeInstanceOf(RunInputMismatchError);
  });
});
