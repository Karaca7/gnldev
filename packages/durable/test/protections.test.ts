// The startup protection matrix, and the declaration it exists to stop being silent about.
//
// The banner this replaces is the reason it lives in @gnldev/durable: `gnl dev` used to print
// "(auth: protected)" from its own hand-kept reading of the config, and said it about a project
// still carrying the token this package once shipped. A second list of protections maintained next
// to — rather than derived from — the config that decides them drifts the same way, with more rows
// to be wrong about. So the rows are computed once here and every surface prints THESE.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal, createGnl, describeProtections, formatProtections } from '../src/index.js';
import type { ProtectionRow } from '../src/index.js';

const journal = () => new InMemoryJournal();
const row = (rows: ProtectionRow[], id: ProtectionRow['id']) => rows.find((r) => r.id === id)!;

afterEach(() => vi.restoreAllMocks());

describe('describeProtections — what the config actually turned on', () => {
  it('no preset → the dedup row says the declarations are inert, and names the fix', () => {
    const rows = describeProtections({ journal: journal() });
    const dedup = row(rows, 'dedup');
    expect(dedup.mark).toBe('off');
    expect(dedup.value).toBe('none — declarations inert');
    expect(dedup.from).toBe('default');
    expect(dedup.note).toContain("preset: 'assistant'");
  });

  it("preset: 'assistant' → on, and `from` says the author wrote it", () => {
    const rows = describeProtections({ journal: journal(), preset: 'assistant' });
    expect(row(rows, 'dedup')).toMatchObject({ mark: 'on', value: 'assistant', from: 'explicit' });
    // The light profiles deliberately do NOT bring critical's hardness package — the matrix must not
    // imply they do (policy-matrix.ts: "Workflow/lock/strictInput kapıları bu ikisine GELMEZ").
    expect(row(rows, 'strictInput').mark).toBe('off');
    expect(row(rows, 'actorLock').mark).toBe('off');
    expect(row(rows, 'tombstonePolicy').mark).toBe('off');
  });

  it("preset: 'critical' → the three overlay-written rows read `from: 'preset'`, not 'explicit'", () => {
    // The honesty this column exists for. Nobody wrote `strictInput` anywhere; the profile did, per
    // call, in registry.ts's run(). Reporting that as 'explicit' would credit the author with a
    // decision they did not make — and hide that removing the preset removes all three.
    const rows = describeProtections({ journal: journal(), preset: 'critical' });
    for (const id of ['strictInput', 'actorLock', 'tombstonePolicy'] as const) {
      expect(row(rows, id).mark).toBe('on');
      expect(row(rows, id).from).toBe('preset');
    }
    expect(row(rows, 'tombstonePolicy').value).toContain('reject');
  });

  it('identity is UNKNOWN unless the caller says — durable cannot see the HTTP surface', () => {
    const rows = describeProtections({ journal: journal() });
    expect(row(rows, 'identity').mark).toBe('unknown');
    expect(row(rows, 'identity').from).toBe('unknown');
  });

  it('a caller that binds a subject gets ✓; one that does not gets the fail-open sentence', () => {
    const bound = describeProtections({ journal: journal() }, { identity: { bound: true, via: 'resolveResourceId' } });
    expect(row(bound, 'identity')).toMatchObject({ mark: 'on', from: 'explicit' });
    expect(row(bound, 'identity').value).toContain('resolveResourceId');

    const open = describeProtections({ journal: journal() }, { identity: { bound: false } });
    expect(row(open, 'identity').mark).toBe('off');
    expect(row(open, 'identity').note).toContain('fail-open');
  });

  it('memory: false reads as a deliberate off (explicit), absence reads as a default off', () => {
    expect(row(describeProtections({ journal: journal(), memory: false }), 'threadGate')).toMatchObject({
      mark: 'off',
      from: 'explicit',
    });
    expect(row(describeProtections({ journal: journal() }), 'threadGate')).toMatchObject({
      mark: 'off',
      from: 'default',
    });
  });

  it('a dev-only memory injection is ─, and the note names the file that will not have it', () => {
    // `gnl dev` derives a memory factory when the config carries storage; src/app.ts does not. Same
    // config, two behaviours — which is the whole reason the third mark exists.
    const rows = describeProtections({ journal: journal() }, { devOnly: { memory: true }, surface: 'gnl dev' });
    const gate = row(rows, 'threadGate');
    expect(gate.mark).toBe('dev-only');
    expect(gate.note).toContain('src/app.ts');
    expect(gate.note).toContain('gnl dev');
  });

  // PAKET #6 — the row that is information rather than a switch, and must stay one.
  //
  // Whether a call names its work (`workKey` → derived `run1_<digest>`) or hands over a raw runId is
  // decided per REQUEST. No config field turns it on, so `?` is the only honest mark — the same one
  // the `identity` row wears until a surface fills it in. What makes it worth a row at all is the
  // note: a workKey is recognised only while its run record lives, and no other row on this screen
  // carries that bond. A future preset that flipped this to ✓ would be claiming to know something
  // the config genuinely does not.
  it("work identity is an INFO row: `?` on every config, and it states the retention↔uniqueness bond", () => {
    for (const cfg of [{ journal: journal() }, { journal: journal(), preset: 'critical' as const }]) {
      const r = row(describeProtections(cfg), 'workIdentity');
      expect(r.mark).toBe('unknown');
      // The row's own two columns must agree with each other and with the legend: the glyph `?` is
      // glossed 'per-call' in the header, so the provenance column cannot read 'unknown' — one row
      // saying both "it is decided per call" and "we do not know" is the matrix contradicting itself.
      expect(r.from).toBe('per-call');
      expect(r.value).toContain('workKey');
      expect(r.note).toContain('retention');
    }
    // The sibling `?` row keeps 'unknown', and the distinction is the point: identity is knowable
    // from the surface and simply was not supplied, work identity is not a config-time fact at all.
    expect(row(describeProtections({ journal: journal() }), 'identity').from).toBe('unknown');
    // A context that fills in the IDENTITY row must not be mistaken for one that settles this one:
    // the two questions are "who is this run for" and "what is this run called", and only the first
    // is a property of the surface.
    const bound = describeProtections({ journal: journal() }, { identity: { bound: true, via: 'principalOf' } });
    expect(row(bound, 'workIdentity').mark).toBe('unknown');
  });

  it('retention says nothing sweeps on its own', () => {
    const r = row(describeProtections({ journal: journal() }), 'retention');
    expect(r.mark).toBe('off');
    expect(r.value).toBe('not wired');
    expect(r.note).toContain('gnl sweep');
  });

  it('formatProtections renders all three marks and a legend', () => {
    const rows = describeProtections({ journal: journal(), preset: 'critical' }, { devOnly: { memory: true } });
    const text = formatProtections(rows).join('\n');
    expect(text).toContain('✓ on · ○ off · ─ dev-only');
    expect(text).toContain('✓');
    expect(text).toContain('○');
    expect(text).toContain('─');
  });
});

describe('a tool declares effectClass and nothing reads it', () => {
  const charge = { description: 'charge', effectClass: 'transactional' as const, execute: async () => 1 };

  it('warns at createGnl time, names the tools, and states the remedy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createGnl({ journal: journal(), agents: { a: { model: {} as any, tools: { charge } as any } } });
    const msg = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('effectClass'));
    expect(msg).toBeDefined();
    expect(msg).toContain('charge');
    expect(msg).toContain("preset: 'assistant'");
  });

  it('stays silent once a profile reads the declaration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createGnl({ journal: journal(), preset: 'assistant', agents: { a: { model: {} as any, tools: { charge } as any } } });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('effectClass'))).toEqual([]);
  });

  it('stays silent when no tool declares one (the ordinary project)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plain = { description: 'plain', execute: async () => 1 };
    createGnl({ journal: journal(), agents: { a: { model: {} as any, tools: { plain } as any } } });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('effectClass'))).toEqual([]);
  });

  it('a DYNAMIC toolset is not scanned — the warning may miss, it must never fire wrongly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createGnl({ journal: journal(), agents: { a: { model: {} as any, tools: (() => ({ charge })) as any } } });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('effectClass'))).toEqual([]);
  });
});
