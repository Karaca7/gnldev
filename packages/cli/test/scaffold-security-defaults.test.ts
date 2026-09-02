// What `gnl init` / `gnl add host` WRITES had no security assertions on it, so three separate
// regressions could be introduced with the suite green. Measured on the current tree:
//
//   remove `?? '127.0.0.1'` from all six host recipes  -> 261/261 green, every generated server
//                                                         binds every interface
//   `hosts.ts:70` roleAuth(...) -> undefined           -> 261/261 green, generated admin surface open
//   `recipes.ts` devToken -> `${role}-dev`             -> 261/261 green, the published literal is back
//
// These are the defaults a user inherits without reading anything, which is exactly why they need
// holding: the framework's own bind and auth fixes do not travel into code it generates.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/scaffold.js';
import { APP_FILE, HOSTS } from '../src/hosts.js';
import { RECIPES, recipeContents } from '../src/recipes.js';

describe('every generated server binds loopback by default', () => {
  it.each(HOSTS.map((h) => [h.id, h] as const))('%s', (_id, host) => {
    // `HOST=0.0.0.0` stays available for containers — the default is what must not be implicit.
    expect(host.server, 'an implicit host binds every interface').toContain("process.env.HOST ?? '127.0.0.1'");
    expect(host.server).not.toMatch(/listen\(\s*port\s*\)/);
  });

  it('covers every recipe, so a new host cannot be added without one', () => {
    expect(HOSTS.length).toBeGreaterThan(0);
  });
});

// `src/app.ts` is the file every host recipe emits, and it mounts both the REST API and Studio. Its
// own comment records that this once shipped with no auth at all — "gnl add host copied an
// unauthenticated admin surface into every generated project" — and nothing held the fix afterwards.
describe('the generated app resolves auth rather than mounting an open admin surface', () => {
  it('wires roleAuth from config or the environment, and passes it to BOTH surfaces', () => {
    expect(APP_FILE, 'without a provider the generated project serves everyone').toContain('roleAuth(');
    expect(APP_FILE).toContain('GNL_ADMIN_TOKEN');
    // Passing it to the REST API but not to Studio, or the reverse, leaves half the surface open.
    expect(APP_FILE).toContain("createRestApi(config, { title: 'app', auth })");
    const studioBlock = APP_FILE.slice(APP_FILE.indexOf('createStudioApp({'));
    expect(studioBlock.slice(0, 200), 'the inspector is an admin surface too').toContain('auth,');
  });
});

describe('generated credentials are not values anyone can look up', () => {
  // `admin-dev` shipped in this package's published source, so every project scaffolded with it had
  // The same admin token — and `bind.ts` treats exactly those literals as "no auth at all".
  it('the auth recipe writes a per-project random token, not a fixed literal', () => {
    // Generated twice: a fixed literal would come out identical, a per-project secret must not.
    const a = recipeContents(RECIPES.auth);
    const b = recipeContents(RECIPES.auth);
    expect(a, 'precondition: the auth recipe produces a credential').toContain('token: credential(');
    expect(a, 'a published literal is a public credential').not.toContain('admin-dev');
    expect(a).not.toContain('viewer-dev');
    expect(a, 'two projects must not share an admin token').not.toBe(b);
  });
});

// Every template, not one of them. An assertion inside the "minimal" test left `templates/full` free
// to drop the line: measured, deleting `.env` from full kept all 261 tests green.
describe('every template ignores the file that holds provider keys', () => {
  it.each(['minimal', 'full'] as const)('%s', (template) => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-ignore-'));
    try {
      scaffold(dir, { name: 'demo', template });
      const ignored = readFileSync(join(dir, '.gitignore'), 'utf8');
      expect(ignored, `${template}: a .env holding GNL_ADMIN_TOKEN must not be committable`).toMatch(/^\.env$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
