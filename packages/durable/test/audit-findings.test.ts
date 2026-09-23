// AUDIT FINDINGS — rounds 11-12 (audit-log.md). Each test asserts the behaviour that SHOULD hold.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertRunIdSafe } from '../src/run.js';
import { assertThreadId } from '../src/journal.js';

const root = join(__dirname, '..');

// ── #22 — the README told npm readers to run a file the package does not contain ──────────────
// `files: ["dist"]` shipped no `examples/`, yet README.md is IN the tarball and line 379 says to run
// one. Measured from an installed copy: `npx tsx examples/no-double-charge.ts` → exit 1.
describe('#22 the README must agree with what the package ships', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const files: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files;
  const runnable = [...readme.matchAll(/(?:npx tsx|node)\s+((?:examples|scripts|dist)\/[\w./-]+)/g)].map((m) => m[1]!);

  it('the README offers at least one runnable example (sanity)', () => {
    expect(runnable.length).toBeGreaterThan(0);
  });
  for (const path of [...new Set(runnable)]) {
    it(`"${path}" exists on disk AND is covered by \`files\``, () => {
      expect(existsSync(join(root, path)), 'missing on disk').toBe(true);
      expect(files, `package.json files: ${JSON.stringify(files)} — an npm reader does not get this file`)
        .toContain(path.split('/')[0]!);
    });
  }
});

// ── #24 — the runId gate was looser than the thread-id gate ───────────────────────────────────
// journal.ts assertThreadId  → /(^|:)(model|tool)(:|$)/   (also catches leading/trailing)
// run.ts   assertRunIdSafe   → /:(?:model|tool):/         (colon on BOTH sides only)
// A run called `pipeline:model` writes `pipeline:model:input`, which parseJournalKey reads as run
// `pipeline` — a run-index row no run ever wrote.
describe('#24 the run gate must refuse the TRAILING record separator', () => {
  for (const id of ['pipeline:model', 'pipeline:tool']) {
    it(`'${id}' must be refused as a runId too`, () => {
      let threadRefused = false, runRefused = false;
      try { assertThreadId(id); } catch { threadRefused = true; }
      try { assertRunIdSafe(id); } catch { runRefused = true; }
      expect(threadRefused, 'the thread gate already refuses this (reference)').toBe(true);
      expect(runRefused, 'otherwise it mints a phantom run-index row').toBe(true);
    });
  }
  it('CONTROL: an innocent id passes both', () => {
    expect(() => assertThreadId('orders-daily')).not.toThrow();
    expect(() => assertRunIdSafe('orders-daily')).not.toThrow();
  });
  it('CONTROL: the colon-on-both-sides form was already refused', () => {
    expect(() => assertRunIdSafe('pipeline:model:x')).toThrow();
  });
  it('CONTROL: the two gates deliberately DISAGREE on the leading form', () => {
    // Not a gap. A threadId sits mid-key so its leading segment matters; a runId is a key prefix so
    // only its tail does. Refusing `model:pipeline` here would reject an id that parses correctly.
    expect(() => assertRunIdSafe('model:pipeline'), 'runId: a prefix, tail is what matters').not.toThrow();
    expect(() => assertThreadId('model:pipeline'), 'threadId: mid-key, leading segment matters').toThrow();
  });
});
