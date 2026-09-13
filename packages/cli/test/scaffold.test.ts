// scaffold: writes the template into a temp dir, verifies placeholder + .gitignore + e2e.
//
// `full` is no longer a directory. It is an ALIAS for the feature set it used to bundle, so the tests
// that used to prove the template's contents now prove the alias produces the same project — which is
// the only claim the alias makes.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/scaffold.js';

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const base = mkdtempSync(join(tmpdir(), 'gnl-'));
  created.push(base);
  return base;
}

describe('scaffold', () => {
  it('minimal (default): fills the placeholder, gitignore→.gitignore, no e2e', () => {
    const dir = join(tmp(), 'my-agent');
    const res = scaffold(dir);

    expect(res.template).toBe('minimal');
    expect(res.files).toContain('gnl.config.ts');
    expect(res.files).toContain(join('src', 'model.ts'));
    expect(res.files).toContain('.gitignore');
    expect(res.files).not.toContain('gitignore');
    // `src/auth.ts` and the model setup read keys from `process.env`; a .env is the usual way to
    // supply them, and the template did not ignore it. Asserted over every template rather than here —
    // measured, an assertion in this test alone left the second template free to drop the line.
    expect(res.files).not.toContain(join('test', 'e2e.test.ts'));

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-agent');
    expect(pkg.scripts.dev).toBe('gnl dev');

    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('my-agent');
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  it("pins every @gnldev range to the CLI's OWN version, not the template's literal", () => {
    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { features: ['idempotency-tool', 'rag'] });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const cliVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;

    // The literal in the template files is a placeholder. The audit's F1: those literals said
    // '^0.1.0', the packages move in lockstep, so at the first minor bump every scaffold would have
    // installed 0.1.x under a 0.2.0 CLI — the mixed install lockstep exists to prevent, and one this
    // codebase already shipped once as '^0.0.0'. Asserting against the CLI's own manifest (not a
    // hardcoded string) keeps this test meaningful at every future version.
    const gnlDeps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([name]) => name.startsWith('@gnldev/'));
    expect(gnlDeps.length).toBeGreaterThan(0);
    for (const [name, range] of gnlDeps) {
      expect(range, `${name} must track the CLI version`).toBe(`^${cliVersion}`);
    }
  });

  it('minimal --e2e: adds the durability test + vitest + test script', () => {
    const dir = join(tmp(), 'a');
    const res = scaffold(dir, { e2e: true });
    expect(res.files).toContain(join('test', 'e2e.test.ts'));
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.devDependencies.vitest).toBeTruthy();
  });

  it("the retired 'full' name still produces the project it named — tool, e2e, test script", () => {
    // The alias's entire promise. Whoever types the old name gets what they got before; what they do
    // not get is a second template directory whose five shared files drift away from the first.
    const dir = join(tmp(), 'b');
    const res = scaffold(dir, { template: 'full' as never });
    expect(res.template, 'a retired name resolves to a composition, not a directory').toBe('custom');
    expect(res.aliasedFrom, 'the caller needs this to say the new spelling once').toBe('full');
    expect(res.features).toEqual(['idempotency-tool', 'e2e']);
    expect(res.files).toContain(join('src', 'tools.ts'));
    expect(res.files).toContain(join('test', 'e2e.test.ts'));
    const tools = readFileSync(join(dir, 'src', 'tools.ts'), 'utf8');
    expect(tools).toContain("idempotency: 'args'");
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('vitest run');
  });

  it("and it ships a model that actually CALLS the tool — otherwise the demo demonstrates nothing", () => {
    // The one thing the old template had that the base template does not. Without this the Playground
    // answers `echo: charge order-1` and the ledger stays empty, which is a quieter project than the
    // one the name used to produce.
    const dir = join(tmp(), 'b2');
    scaffold(dir, { template: 'full' as never });
    const model = readFileSync(join(dir, 'src', 'model.ts'), 'utf8');
    expect(model).toContain("toolName: 'chargeOrder'");
    // And the config is what binds that name to the real tool — one wiring, in the file that holds
    // every other feature's wiring too.
    const config = readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
    expect(config).toContain('tools: { chargeOrder }');
  });

  it('rejects an unknown template, and the message names the retired ones', () => {
    expect(() => scaffold(join(tmp(), 'c'), { template: 'nope' as any })).toThrow(/unknown template/);
    expect(() => scaffold(join(tmp(), 'c2'), { template: 'nope' as any })).toThrow(/full/);
  });

  it('throws if the target directory is not empty', () => {
    const base = tmp();
    scaffold(join(base, 'a'));
    expect(() => scaffold(base)).toThrow(/is not empty/);
  });
});

describe('scaffold — feature composition', () => {
  it('composes idempotency-tool + rag + memory + e2e: files, deps, and a wired gnl.config.ts', () => {
    const dir = join(tmp(), 'composed');
    const res = scaffold(dir, { features: ['idempotency-tool', 'rag', 'memory', 'e2e'] });

    expect(res.template).toBe('custom');
    // recipe src files written
    expect(res.files).toContain(join('src', 'tools.ts'));
    expect(res.files).toContain(join('src', 'rag.ts'));
    expect(res.files).toContain(join('src', 'memory.ts'));
    // e2e (idempotency variant) + vitest config
    expect(res.files).toContain(join('test', 'e2e.test.ts'));
    expect(res.files).toContain('vitest.config.ts');
    // idempotency-tool selected → the idempotency e2e (references ../src/tools.js)
    const e2e = readFileSync(join(dir, 'test', 'e2e.test.ts'), 'utf8');
    expect(e2e).toContain("from '../src/tools.js'");

    // package.json: new deps added, memory dep already present, vitest + test script from e2e
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@gnldev/rag']).toBeTruthy();
    expect(pkg.dependencies['@gnldev/memory']).toBeTruthy(); // base template already had it
    expect(pkg.devDependencies.vitest).toBeTruthy();
    expect(pkg.scripts.test).toBe('vitest run');

    // generated gnl.config.ts: correct imports + wiring, NO @gnldev/cli import
    const config = readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
    expect(config).not.toContain('@gnldev/cli');
    expect(config).toContain("import { chargeOrder } from './src/tools.js';");
    expect(config).toContain("import { searchDocs } from './src/rag.js';");
    expect(config).toContain("import { memoryFactory } from './src/memory.js';");
    // agentTools → assistant.tools ; configField → top level
    expect(config).toContain('agents: { assistant: { ...assistant, tools: { chargeOrder, searchDocs } } }');
    expect(config).toContain('memoryFactory,');
    expect(config).toContain("satisfies CreateGnlConfig & { port?: number; studio?: boolean; subjects?: 'internal' | 'end-users' }");
  });

  it('workflow + auth: configField wiring + auth widens the satisfies type', () => {
    const dir = join(tmp(), 'cfg2');
    scaffold(dir, { features: ['workflow', 'auth'] });
    const config = readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
    expect(config).toContain('agents: { assistant },'); // no agentTools → unchanged assistant
    expect(config).toContain('workflows: { checkout },');
    expect(config).toContain('auth,');
    expect(config).toContain('& { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@gnldev/workflow']).toBeTruthy();
  });

  it('mcp: spread wiring into agent tools', () => {
    const dir = join(tmp(), 'mcp1');
    scaffold(dir, { features: ['mcp'] });
    const config = readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
    expect(config).toContain('tools: { ...mcpToolset }');
  });

  it('e2e alone (no idempotency-tool) → the durability replay test', () => {
    const dir = join(tmp(), 'e2eonly');
    scaffold(dir, { features: ['e2e'] });
    const e2e = readFileSync(join(dir, 'test', 'e2e.test.ts'), 'utf8');
    expect(e2e).toContain('resume replays instead of re-running');
    expect(e2e).not.toContain("from '../src/tools.js'");
  });

  it('rejects an unknown feature', () => {
    expect(() => scaffold(join(tmp(), 'bad'), { features: ['rag', 'nope'] })).toThrow(/unknown feature/);
  });
});
