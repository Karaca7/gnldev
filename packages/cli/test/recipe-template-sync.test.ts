// The scaffold's own source files, checked the way a user meets them: as TEXT that has to compile.
//
// What happened: a sentence-capitaliser was run over this package and it did not stop at prose. It
// walked INSIDE the template literals in recipes.ts and hosts.ts — the strings that become a
// scaffolded project's src/*.ts — and upper-cased the first word of every comment line. Most of
// those lines are prose and survived it looking odd. Three of them were COMMENTED-OUT CODE next to
// an instruction to uncomment it:
//
//   recipes.ts  // IdempotencyWindow: 'cross-run' as const,   (idempotencyWindow)
//   recipes.ts  // Const handle = mcpTools({ … })             (const)
//   recipes.ts  // Export const mcpToolset: ToolSet = …       (export const)
//   hosts.ts    // Server.use('/app', express.json(), …)      (server)
//   hosts.ts    // Server.get('/app/health', …)               (server)
//   hosts.ts    // Server.use(bodyParser());                  (server)
//
// So `gnl init` shipped files that said "uncomment these two lines" and produced a syntax error when
// you did. Nothing caught it: the strings are never compiled here, and the one guard that pointed at
// the drift — recipes.ts's "Kept in sync with templates/full/src/tools.ts" — was a COMMENT, which
// cannot notice that the two copies had stopped agreeing. (That second copy is gone now; the
// template it lived in was retired into a feature alias. The checks below outlived it, because the
// capitaliser's other victims are still generated from these same literals.)
//
// This file replaces both promises with checks. It reads the generated TEXT (never a re-implementation
// of it), so a future pass of any such tool over either file lands here instead of in someone's
// scaffold.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPES, recipeContents } from '../src/recipes.js';
import { generateConfig } from '../src/scaffold.js';
import { HOSTS, APP_FILE } from '../src/hosts.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every string this package writes into a scaffolded project, with a name to report it under. */
function generatedSources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const r of Object.values(RECIPES)) out.push({ name: `recipe:${r.id} (${r.file})`, text: recipeContents(r) });
  out.push({ name: 'hosts:src/app.ts', text: APP_FILE });
  for (const h of HOSTS) out.push({ name: `host:${h.id} (src/server.ts)`, text: h.server });
  return out;
}

/**
 * The exact damage pattern, not a general "is this comment capitalised" rule.
 *
 * Deliberately narrow. Prose comments in these files legitimately start with a capital (`// GNL is
 * the misconfiguration…`, `// MOUNT ORDER.`), and a rule broad enough to catch those would be turned
 * off the first time it fired on a sentence. These four alternatives are the identifiers the
 * capitaliser actually reached — a language keyword, an export, a host variable, and a durable-tool
 * option — and none of them can legitimately appear capitalised at the start of a commented-out line.
 */
const MANGLED_CODE_COMMENT = /^\s*\/\/\s*(Const|Export const|Server\.|IdempotencyWindow)/m;

describe('scaffold sources: commented-out code is still code', () => {
  it('no generated file carries a capitalised comment-code line', () => {
    const offenders: string[] = [];
    for (const { name, text } of generatedSources()) {
      for (const line of text.split('\n')) {
        if (MANGLED_CODE_COMMENT.test(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the mcp recipe\'s two "replace with these" lines uncomment into valid code', () => {
    const text = recipeContents(RECIPES.mcp!);
    // The file's own instruction is "replace the export below with the two commented lines" — so
    // those two lines are the contract, and they have to read as the code they claim to be.
    expect(text).toContain('// const handle = mcpTools({');
    expect(text).toContain('// export const mcpToolset: ToolSet = await handle.tools();');
  });

  it('the charge tool\'s cross-run hint uncomments into the real option name', () => {
    const text = recipeContents(RECIPES['idempotency-tool']!);
    // `IdempotencyWindow` is not an option on anything; the tool declaration reads `idempotencyWindow`.
    expect(text).toContain("// idempotencyWindow: 'cross-run' as const,");
  });
});

/**
 * The charge tool's OTHER HALF, wherever it currently lives.
 *
 * `templates/full/src/tools.ts` used to be a second copy of the recipe below, held equal to it by a
 * comment saying "kept in sync" — a promise that cannot notice being broken. That template became a
 * feature alias, then the feature became the BASE: every scaffold now ships this tool, the
 * `charge-demo` agent whose mock model calls it, and the proof test that asserts three duplicate
 * calls charge once. Three files that only work if they agree about one name and one path, and none
 * of them is compiled here — so the same class of rot applies, and the same kind of check answers
 * it: do they still name what the recipe actually writes?
 */
describe('the charge tool, the agent that calls it, and the proof that watches', () => {
  const tmpl = (...p: string[]) => readFileSync(join(pkgRoot, 'templates', 'minimal', ...p), 'utf8');

  it('the proof test imports the tool from the path the recipe actually writes', () => {
    const proof = tmpl('test', 'proof.test.ts');
    expect(RECIPES['idempotency-tool']!.file).toBe('src/tools/charge-order.ts');
    expect(proof).toContain("from '../src/tools/charge-order.js'");
    for (const name of ['chargeOrder', 'ledger']) {
      expect(proof, `the proof imports ${name}`).toContain(name);
      expect(recipeContents(RECIPES['idempotency-tool']!), `the recipe exports ${name}`).toContain(`export const ${name}`);
    }
  });

  it('the demo agent calls the tool the recipe declares, by the name the config wires', () => {
    // A mock that names a different tool is a demo that silently does nothing — which is exactly the
    // state `--template full` was in when its finishReason shape regressed. The default tool name
    // lives in @gnldev/durable/mock now, so the agent takes it by omission; what must hold here is
    // that the agent asks for the tool-calling model at all, and that the config wires that agent to
    // this tool under the name the model emits.
    const agent = tmpl('src', 'agents', 'charge-demo.ts');
    expect(agent).toContain('toolCallingModel');
    expect(agent).toContain('export const chargeDemo');
    const config = generateConfig([]);
    expect(config).toContain("import { chargeOrder } from './src/tools/charge-order.js';");
    expect(config).toContain("'charge-demo': { ...chargeDemo, tools: { chargeOrder } }");
  });

  it('the model recipes write where the config expects, and export what it imports', () => {
    // `gnl add model <provider>` writes src/models/<provider>.ts exporting `model`; its instruction
    // tells the reader to import that into src/agents/assistant.ts. A recipe whose file path and
    // whose printed instruction disagree is a recipe that scaffolds a broken import.
    for (const [id, r] of Object.entries(RECIPES).filter(([id]) => id.startsWith('model-'))) {
      const provider = id.slice('model-'.length);
      expect(r.file, id).toBe(`src/models/${provider}.ts`);
      expect(recipeContents(r), id).toContain('export const model');
      expect(r.humanWire, id).toContain(`../models/${provider}.js`);
    }
  });
});
