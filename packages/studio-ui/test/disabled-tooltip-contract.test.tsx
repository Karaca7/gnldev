// @vitest-environment jsdom
// A disabled control must still be able to say why it is disabled.
//
// `disabled:pointer-events-none` removes the element from hit-testing, and the native `title` tooltip
// is DELIVERED by hit-testing — so the class suppressed the tooltip in the one state where the tooltip
// is the only explanation the user gets. `title` on these controls is almost always set precisely
// BECAUSE they are disabled.
//
// WHAT THIS FILE CANNOT PROVE, stated up front: jsdom does no layout and no hit-testing, so no test
// here can show that a tooltip actually appears on hover. `getComputedStyle` in jsdom also does not
// resolve Tailwind variant classes — they are class NAMES until a real stylesheet is applied. So the
// assertions are on the CLASS CONTRACT: the suppressing class is gone everywhere, the replacement is
// present, and every hover variant is gated on `enabled:` so a dead control still does not light up.
// Confirming the tooltip renders needs a real browser; that remains unverified here.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { Btn } from '../src/components';

afterEach(cleanup);

const srcRoot = join(import.meta.dirname, '..', 'src');

/** Source with comments removed — a comment may legitimately NAME the banned class (one does). */
const code = (file: string): string =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every .tsx/.ts file under src, recursively. */
function sources(dir = srcRoot): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the Btn component', () => {
  it('keeps its tooltip reachable when disabled', () => {
    render(<Btn disabled title="approvals are unreachable in this scope">Approve</Btn>);
    const btn = screen.getByRole('button');

    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('title'), 'the explanation is not even on the element').toBe('approvals are unreachable in this scope');
    expect(btn.className, 'the class that removes the element from hit-testing is back — the tooltip cannot be delivered')
      .not.toContain('pointer-events-none');
    expect(btn.className, 'nothing signals to the user that the control is dead').toContain('disabled:cursor-not-allowed');
  });

  // `busy` disables through the same path, so it must not lose the tooltip either.
  it('keeps it while busy', () => {
    render(<Btn busy title="saving">Save</Btn>);
    const btn = screen.getByRole('button');

    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.className).not.toContain('pointer-events-none');
  });

  it('is unchanged when enabled', () => {
    render(<Btn title="run it">Run</Btn>);
    const btn = screen.getByRole('button');

    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute('title')).toBe('run it');
  });

  // The reason `pointer-events-none` was there at all: stopping the hover colour on a dead control.
  // `enabled:` does that directly. If a variant were left as a bare `hover:`, a disabled button would
  // light up on hover — so the replacement has to be checked, not just the removal.
  it.each(['default', 'primary', 'outline', 'ghost', 'ok', 'deny'] as const)(
    'gates the %s variant\'s hover on `enabled:`', (variant) => {
      render(<Btn variant={variant} disabled title="t">X</Btn>);
      const cls = screen.getByRole('button').className;

      const bareHover = cls.split(/\s+/).filter((c) => /(^|:)hover:/.test(c) && !c.includes('enabled:hover:') && !c.startsWith('group-hover:'));
      expect(bareHover, `a disabled ${variant} button still lights up on hover`).toEqual([]);
    });
});

describe('every control in the UI', () => {
  // The five sites were changed by hand. A grep is what makes the rule hold for the sixth.
  it('has no `disabled:pointer-events-none` left anywhere in src', () => {
    const offenders = sources()
      .filter((f) => code(f).includes('disabled:pointer-events-none'))
      .map((f) => f.slice(srcRoot.length + 1));

    expect(offenders, 'a control was left unable to show the tooltip that explains why it is disabled').toEqual([]);
  });

  // The complementary rule, applied UI-WIDE.
  //
  // This was originally scoped to the five converted sites, because eleven other disabled-able
  // controls carried a bare `hover:` (Agents 180, Audit 117/189, Inspector 234, Observability 331,
  // Playground 803/1005, Workflows 239/538/797/798) and would have failed a global assertion. They
  // predated the change rather than regressed from it — none ever had `pointer-events-none`, so they
  // had always lit up while dead — and `Workflows.tsx:239` had solved it a third way with
  // `disabled:hover:bg-transparent`. All eleven now use the one convention, so the rule no longer has
  // to be narrowed to stay true, and a twelfth site cannot appear without failing here.
  it('gates hover on `enabled:` for every disabled-able control in src', () => {
    const offenders: string[] = [];
    for (const f of sources()) {
      for (const m of code(f).matchAll(/className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? '';
        if (!cls.includes('disabled:')) continue;
        for (const c of cls.split(/\s+/)) {
          if (/^hover:/.test(c)) offenders.push(`${f.slice(srcRoot.length + 1)}: ${c}`);
        }
      }
    }

    expect(offenders, 'a disabled-able control still lights up on hover while dead').toEqual([]);
  });

  // The `Btn` base itself is built by string concatenation rather than a className literal, so the
  // scan above does not see it. Asserted through the rendered output instead.
  it('including Btn, whose classes are assembled in code', () => {
    render(<Btn variant="outline" disabled title="t">X</Btn>);
    const cls = screen.getByRole('button').className;

    expect(cls).toContain('disabled:opacity-50');
    expect(cls).toContain('disabled:cursor-not-allowed');
    expect(cls.split(/\s+/).filter((c) => /^hover:/.test(c)), 'the Btn base carries a bare hover variant').toEqual([]);
  });
});

describe('the raw buttons that were changed alongside Btn', () => {
  // Asserted as a PROPERTY, not as a count. This used to pin an exact number of
  // `disabled:cursor-not-allowed` occurrences per file, which caught a lost declaration but also failed
  // the moment the convention was extended to the eleven pre-existing controls — a legitimate change
  // reading as a regression. The rule the count stood in for is that every disabled-state declaration
  // in these files uses the convention, and that is checked directly.
  it.each(['views/Agents.tsx', 'views/Playground.tsx', 'views/Workflows.tsx', 'views/Audit.tsx', 'views/Inspector.tsx', 'views/Observability.tsx'])(
    '%s states its disabled controls without killing hit-testing',
    (file) => {
      const text = readFileSync(join(srcRoot, file), 'utf8');

      expect(text).not.toContain('disabled:pointer-events-none');
      expect(text, `${file} has no disabled-state declaration at all — the scan found nothing to check`)
        .toMatch(/disabled:(cursor-not-allowed|opacity-)/);
      expect(text, `${file} lost the enabled: gate on its hover variants`).toContain('enabled:hover:');
    },
  );
});
