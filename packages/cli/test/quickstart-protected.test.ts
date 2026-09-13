// The quickstart quotes a terminal screen. This is what stops the quote from rotting.
//
// A pasted block of program output is the most reliable form of documentation rot there is: it is
// correct on the day it is pasted, it is never compiled, never run, and nothing anywhere connects it
// back to the code that produces it. `check-doc-samples.mjs` compiles every ```ts block in this
// repository for exactly that reason — but a ```text block holding a protections matrix is not
// TypeScript and that gate cannot see it.
//
// So the block is kept SHORT, and every row it shows is asserted against what `formatProtections`
// actually returns for the configuration the page tells the reader to create. The page defers the
// full screen to `gnl doctor`, which cannot be out of date because it is the program.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeProtections, formatProtections } from '@gnldev/durable';
import { scaffold } from '../src/scaffold.js';
import { DEFAULT_ANSWERS, QUESTIONS } from '../src/init-answers.js';
import { identityRow } from '../src/protections-view.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const pages = ['docs/QUICKSTART-PROTECTED.md', 'docs/QUICKSTART-PROTECTED.tr.md'];

/**
 * Every matrix the page is allowed to quote from.
 *
 * TWO of them, because the page shows two screens and they legitimately differ: the one `gnl init`
 * prints for the recommended answers, and the one `gnl dev` prints when it has DERIVED a memory store
 * the project's own config does not carry. Section 5 is entirely about the second — the `─` row — so a
 * check that only knew the first would reject the very line that section exists to teach.
 */
function quotableMatrices(): string {
  const shape = { storage: new (class SqliteStorage {})(), preset: DEFAULT_ANSWERS.preset, subjects: DEFAULT_ANSWERS.identity };
  const ctx = { surface: 'gnl init', identity: identityRow(shape as never, false) };
  return [
    formatProtections(describeProtections(shape as never, ctx)).join('\n'),
    formatProtections(describeProtections(shape as never, { ...ctx, surface: 'gnl dev', devOnly: { memory: true } })).join('\n'),
  ].join('\n');
}

describe.each(pages)('%s', (rel) => {
  const path = join(repoRoot, rel);
  const text = (): string => readFileSync(path, 'utf8');

  it('exists', () => {
    expect(existsSync(path), `${rel} is missing`).toBe(true);
  });

  it('every matrix row it quotes is a row the program really prints', () => {
    // Row lines only — the page abbreviates, so it is allowed to show FEWER rows, never different
    // ones. Matched on the `<mark> <label>` prefix, which is the part a reader uses to find the row
    // on their own screen; the value column is left to `gnl doctor`.
    const produced = quotableMatrices();
    const quoted = text().split('\n').filter((l) => /^ {2}[✓○─?] \w/.test(l));
    expect(quoted.length, 'the page quotes no matrix rows at all — this test would pass vacuously').toBeGreaterThan(2);
    for (const line of quoted) {
      // `<mark> <label>` — the part a reader uses to find the row on their own screen. The value and
      // provenance columns are left to `gnl doctor`, which cannot be out of date.
      const [head] = line.trim().split(/\s{2,}/);
      expect(produced, `the page quotes a row the program does not print:\n    ${line.trim()}`).toContain(head!);
    }
  });

  it('quotes the legend verbatim, including the ─ that section 5 is about', () => {
    expect(text()).toContain('✓ on · ○ off · ─ dev-only');
  });

  it('names the three questions with the flags that answer them', () => {
    const t = text();
    for (const q of QUESTIONS) {
      expect(t, `the page never mentions --${q.flag}`).toContain(`--${q.flag}`);
      for (const o of q.options) expect(t, `--${q.flag} ${o.id} is undocumented`).toContain(o.id);
    }
  });

  it('the one command it opens with really produces a project', () => {
    // The page's first instruction, executed. A quickstart whose first line does not work is worse
    // than no quickstart: the reader concludes the framework is broken, not the page.
    const base = mkdtempSync(join(tmpdir(), 'gnl-qs-'));
    try {
      const res = scaffold(join(base, 'my-agent'), { answers: DEFAULT_ANSWERS });
      expect(res.files).toContain('gnl.config.ts');
      const cfg = readFileSync(join(res.dir, 'gnl.config.ts'), 'utf8');
      expect(cfg).toContain(`preset: '${DEFAULT_ANSWERS.preset}',`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('every command it tells you to run is a command that exists', async () => {
    const { commands } = await import('../src/commands/index.js');
    const named = [...text().matchAll(/`gnl ([a-z-]+)/g)].map((m) => m[1]!);
    expect(named.length, 'the page names no gnl commands').toBeGreaterThan(3);
    const unknown = [...new Set(named)].filter((n) => !commands[n]);
    expect(unknown, 'the page tells the reader to run a command that does not exist').toEqual([]);
  });

  it('links to EXACTLY three places, and each one is a file that exists', () => {
    // Three, deliberately. A "where to go next" list with nine entries is a list nobody follows —
    // it hands the reader the same choice they came here to avoid making.
    const section = text().slice(text().lastIndexOf('---'));
    const links = [...section.matchAll(/\]\((\.[^)#]+)\)/g)].map((m) => m[1]!);
    expect(links).toHaveLength(3);
    for (const href of links) {
      expect(existsSync(join(repoRoot, 'docs', href)), `${rel} links to a missing file: ${href}`).toBe(true);
    }
  });
});
