// What a brand-new project is TOLD, on the three decisions it cannot discover by reading the code.
//
// Each of these is a switch whose absence is silent by construction, which is why the scaffold has
// to name it rather than leave it to a guide nobody opens:
//
//   preset      — a tool's `effectClass` is read ONLY through a profile. With none, a tool that
//                 declared itself `transactional` behaves exactly like one that declared nothing,
//                 and nothing anywhere says so.
//   memory      — `gnl dev` DERIVES a memory store from `storage`; `src/app.ts` does not. Threads
//                 work on the developer's machine and quietly stop working after deploy.
//   retention   — nothing sweeps on its own. A run holds the prompt it was given, indefinitely,
//                 until a human or a cron entry runs `gnl sweep`.
//
// Pinned by CONTENT, not by shape: the assertions are the words a reader has to find. A future edit
// may reword the prose; deleting the guidance is what has to fail.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, generateConfig, TEMPLATES } from '../src/scaffold.js';
import { RECIPES } from '../src/recipes.js';
import { APP_FILE } from '../src/hosts.js';

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'gnl-guide-'));
  rmSync(d, { recursive: true, force: true });
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const configOf = (dir: string) => readFileSync(join(dir, 'gnl.config.ts'), 'utf8');

// One template now — `full` was retired into a feature alias, and an alias reaches the GENERATED
// config below rather than a copied one. Driven off TEMPLATES so a second template, if one ever
// returns, is covered the day it exists rather than the day somebody remembers this file.
describe.each(TEMPLATES)('the %s template\'s gnl.config.ts', (template) => {
  const written = () => { const d = fresh(); scaffold(d, { template }); return configOf(d); };

  it("carries preset: 'assistant' and explains all three profiles", () => {
    const cfg = written();
    expect(cfg).toContain("preset: 'assistant',");
    // The three lines are the point — a value with no alternatives is a magic word, not a decision.
    expect(cfg).toMatch(/assistant\s+—.*human is on screen/);
    expect(cfg).toMatch(/headless\s+—.*nobody is there to ask/);
    expect(cfg).toMatch(/critical\s+—.*run lock/);
    // And why it is load-bearing at all: without it, declarations are inert.
    expect(cfg).toContain('effectClass');
  });

  it('names the dev/prod memory asymmetry and how to close it', () => {
    const cfg = written();
    expect(cfg).toContain('// memoryFactory,');
    expect(cfg).toContain('src/app.ts');
    expect(cfg).toContain('gnl add memory');
  });

  it('says retention is scheduled by nobody', () => {
    const cfg = written();
    expect(cfg).toContain('gnl sweep');
    expect(cfg).toMatch(/not scheduled by anything here/);
  });
});

describe('`gnl init --features` writes the same guidance', () => {
  it('the GENERATED config carries the profile, retention and (when unwired) the memory note', () => {
    // scaffoldFeatures OVERWRITES the copied template config, so a user who picked features would
    // otherwise be the only one who never read any of this — and the likeliest to have declared an
    // `effectClass` on a tool that nothing reads.
    const dir = fresh();
    scaffold(dir, { features: ['rag'] });
    const cfg = configOf(dir);
    expect(cfg).toContain("preset: 'assistant',");
    expect(cfg).toContain('// memoryFactory,');
    expect(cfg).toContain('gnl sweep');
  });

  it('picking the memory recipe REPLACES the commented hint with the real wiring', () => {
    // Telling someone to uncomment a line that is already there, wired, two lines above is noise —
    // and noise in generated code is what teaches people to stop reading it.
    const cfg = generateConfig([RECIPES.memory!]);
    expect(cfg).toContain('memoryFactory,');
    expect(cfg).not.toContain('// memoryFactory,');
  });

  it('leaves no double blank lines — generated code is read, not just compiled', () => {
    for (const recipes of [[RECIPES.memory!], [RECIPES.rag!], [RECIPES.workflow!, RECIPES.auth!], []]) {
      expect(generateConfig(recipes)).not.toMatch(/\n\n\n/);
    }
  });
});

describe('src/app.ts — the deployed half', () => {
  it('says who a run belongs to under auth, and under none', () => {
    expect(APP_FILE).toContain('WHO IS EACH RUN FOR?');
    expect(APP_FILE).toMatch(/AUTHENTICATED principal/);
    expect(APP_FILE).toMatch(/body\.resourceId/);
  });

  it('shows the identity skeleton for the auth-less adapters, with the body ruled out', () => {
    // The two routes that ship with no auth of their own are exactly where a host must name the
    // subject itself — and the one wrong answer (read it from the body) is the hole the engine's
    // context seal exists to close, so the example has to refuse it out loud.
    expect(APP_FILE).toContain('identity: (req) =>');
    expect(APP_FILE).toMatch(/NEVER from the request body/);
    expect(APP_FILE).toMatch(/session cookie|verified JWT/);
  });

  it('the commented example is a COMMENT — a scaffolded app.ts must still compile', () => {
    const identityLine = APP_FILE.split('\n').find((l) => l.includes('identity: (req) =>'))!;
    expect(identityLine.trimStart().startsWith('//')).toBe(true);
  });
});
