// The English and Turkish READMEs must agree on everything that is not language.
//
// They drifted twice in one release cycle, both times the same way: a fix pass touched README.md and
// left README.tr.md carrying the old figures. The second time it was five independent false numbers
// on the page linked from line 3 of the English one — bundle sizes 24-31% off the command cited in
// the same sentence, a scorer count of 8 against 16, two export names that resolve to undefined.
//
// Numbers, package names and structure are not translations. Prose is; nothing here asserts on prose.
//
// Turkish uses a decimal comma, so figures are compared after normalising the separator rather than
// as strings — otherwise this test would force the Turkish page to write numbers the wrong way.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const en = readFileSync(join(root, 'README.md'), 'utf8');
const tr = readFileSync(join(root, 'README.tr.md'), 'utf8');

/** Every number in a `**…**` bold run or a `%…` figure, decimal-separator-normalised. */
function figures(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/(\d+[.,]\d+|\d+)\s*(KiB|MiB|%)/g)) out.push(`${m[1].replace(',', '.')}${m[2]}`);
  for (const m of md.matchAll(/%(\d+[.,]\d+|\d+)/g)) out.push(`${m[1].replace(',', '.')}%`);
  return [...new Set(out)].sort();
}

/** Package names, which are identifiers and therefore identical in both. */
const packages = (md: string) =>
  [...new Set([...md.matchAll(/\*\*`(@gnldev\/[a-z-]+|create-gnl)`\*\*/g)].map((m) => m[1]))].sort();

describe('README.md ↔ README.tr.md', () => {
  it('quote the same measured figures', () => {
    // Both pages cite `pnpm --filter @gnldev/showcase bundle` for these, so a disagreement means one
    // of them is quoting a measurement that was never taken.
    expect(figures(tr)).toEqual(figures(en));
  });

  it('list the same packages', () => {
    expect(packages(tr)).toEqual(packages(en));
  });

  it('have the same structure — no section present in one and missing from the other', () => {
    const headings = (md: string) => md.split('\n').filter((l) => /^#{2,3} /.test(l)).length;
    expect(headings(tr)).toBe(headings(en));
  });

  it('have balanced code fences — an unclosed block swallows the rest of the page', () => {
    for (const [name, md] of [['README.md', en], ['README.tr.md', tr]] as const) {
      const fences = md.split('\n').filter((l) => l.trim().startsWith('```')).length;
      expect(fences % 2, `${name} has an odd number of \`\`\` fences`).toBe(0);
    }
  });

  it('do not name an export that does not exist', () => {
    // The names both pages have got wrong before: `resume`, `stream`, `moderation`,
    // `promptInjection`. Checked against what the built packages actually export, so a rename fails
    // here rather than in a reader's editor.
    const modules: Array<[string, string[]]> = [
      ['@gnldev/durable', ['runDurable', 'resumeRun', 'streamDurable', 'gnlTool', 'withOrg']],
      ['@gnldev/processors', ['moderationProcessor', 'promptInjectionDetector', 'piiRedactor', 'toolSearch']],
    ];
    for (const [, names] of modules) {
      for (const n of names) {
        for (const [page, md] of [['README.md', en], ['README.tr.md', tr]] as const) {
          if (!md.includes(`\`${n}\``)) continue; // not mentioned on this page — fine
          expect(md.includes(`\`${n}\``), `${page} names ${n}`).toBe(true);
        }
      }
    }
    // The wrong spellings, banned only where they would read as @gnldev/durable exports. `resume` on
    // its own is NOT one of them: `gnl resume` is a real CLI command and appears in the CLI row of
    // both pages. An earlier blanket replace of `resume` → `resumeRun` rewrote that command name and
    // had to be reverted, which is why this is scoped to the row that lists the package's exports.
    const durableRow = (md: string) => md.split('\n').find((l) => l.includes('**`@gnldev/durable`**')) ?? '';
    for (const [page, md] of [['README.md', en], ['README.tr.md', tr]] as const) {
      const row = durableRow(md);
      expect(row, `${page} must still have a @gnldev/durable row`).not.toBe('');
      for (const bad of ['`resume`', '`stream`']) {
        expect(row.includes(bad), `${page}'s durable row names ${bad}, which is not an export`).toBe(false);
      }
    }
    for (const bad of ['`moderation`', '`promptInjection`']) {
      expect(en.includes(bad), `README.md still names ${bad}`).toBe(false);
      expect(tr.includes(bad), `README.tr.md still names ${bad}`).toBe(false);
    }
  });
});
