// gnl add <feature> — drop a boilerplate recipe into an existing project + print the config wiring.
// Deliberately does NOT rewrite gnl.config.ts (AST patching is fragile): it writes a src/ file
// (idempotent — never overwrites) and prints exactly what to add to the config object.
// Recipes live in ../recipes.ts (shared with `gnl init`'s feature composition).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from './types.js';
import { positional, flag, flagBool } from '../args.js';
import { bold, cyan, dim, green, yellow } from '../ansi.js';
import { RECIPES, recipeContents, defaultVariants } from '../recipes.js';
import { HOST_IDS } from '../hosts.js';

export const addCommand: Command = {
  name: 'add',
  group: 'project',
  summary: 'Add a feature recipe, a real model, or a server entry to an existing project',
  usage: 'gnl add <feature> [--only a,b] | gnl add model <provider> | gnl add host <framework> [--mount]',
  async run(ctx) {
    // `gnl add host <id>` — the deploy-day half of `gnl init --host`, which only ever ran at scaffold
    // time. The scaffold's own closing line promised this command before it existed: a project that
    // outgrows `gnl dev` needs src/app.ts + src/server.ts and has no way to ask for them.
    if (positional(ctx.argv, 0) === 'host') {
      const id = positional(ctx.argv, 1);
      if (!id || !HOST_IDS.includes(id)) {
        console.error(`gnl add host: ${id ? `unknown host '${id}'` : 'which server?'}`);
        console.error(`  valid: ${HOST_IDS.join(', ')}`);
        process.exit(1);
      }
      if (!existsSync(resolve('gnl.config.ts'))) {
        console.error("gnl add: no gnl.config.ts here — run this inside a gnl project (gnl init).");
        process.exit(1);
      }
      // `--mount`: the server file is YOURS. Only src/app.ts is written, and the binding lines are
      // printed — the same split `gnl init`'s serving question makes.
      const mount = ctx.argv.includes('--mount');
      const wouldWrite = mount ? ['src/app.ts'] : ['src/app.ts', 'src/server.ts'];
      for (const f of wouldWrite) {
        if (existsSync(resolve(f))) {
          console.error(`gnl add host: ${f} already exists — left untouched.`);
          console.error('  Delete it first if you want the generated one, or wire your own by hand.');
          process.exit(1);
        }
      }
      const { addHost } = await import('../scaffold.js');
      const { hostById } = await import('../hosts.js');
      addHost(resolve('.'), id, mount ? 'mount' : 'own');
      const host = hostById(id)!;
      if (mount) {
        console.log(`${green('✓')} created ${bold('src/app.ts')}   (the GNL surface — this is what you mount)`);
        console.log(`\n${cyan(`Paste into your ${host.label} server:`)}`);
        for (const line of host.mount.trimEnd().split('\n')) console.log(`  ${line}`);
        console.log(`\n${dim('appended to README.md too. Your package.json was not touched — the framework is already yours.')}`);
        if (id === 'fastify') console.log(dim('  this recipe needs @fastify/middie; koa needs koa-connect.'));
      } else {
        console.log(`${green('✓')} created ${bold('src/app.ts')}   (the GNL surface, no server attached)`);
        console.log(`${green('✓')} created ${bold('src/server.ts')}  (${host.label})`);
        console.log(`\n${dim('then: pnpm install   (the host dependency was added to package.json)')}`);
        console.log(`${dim('run it with: pnpm start   ·  `gnl dev` keeps working for development')}`);
      }
      return;
    }
    // `gnl add model nvidia` reads the way people say it; the recipe id it maps to is `model-nvidia`.
    const first = positional(ctx.argv, 0);
    const feature = first === 'model' ? `model-${positional(ctx.argv, 1) ?? ''}` : first;
    const names = Object.keys(RECIPES).filter((n) => !n.startsWith('model-'));
    const providers = Object.keys(RECIPES).filter((n) => n.startsWith('model-')).map((n) => n.slice('model-'.length));
    if (!feature || !RECIPES[feature]) {
      const shown = first === 'model' ? ['model', positional(ctx.argv, 1)].filter(Boolean).join(' ') : first;
      console.error(`gnl add: ${first ? `unknown feature '${shown}'` : 'missing feature'}`);
      console.error(`  available: ${names.join(', ')}`);
      console.error(`  models:    gnl add model <${providers.join('|')}>`);
      process.exit(1);
    }
    if (!existsSync(resolve('gnl.config.ts'))) {
      console.error("gnl add: no gnl.config.ts here — run this inside a gnl project (gnl init).");
      process.exit(1);
    }
    const r = RECIPES[feature]!;

    // A recipe made of parts asks which ones — in a terminal. `--only a,b` answers it (and a run
    // without a TTY takes the defaults), the same contract every other question in this CLI has:
    // a flag silences its prompt, and nothing ever blocks in CI.
    let picked: string[] | undefined;
    if (r.variants?.length) {
      const onlyFlag = flag(ctx.argv, 'only');
      if (onlyFlag !== undefined) {
        picked = onlyFlag.split(',').map((x) => x.trim()).filter(Boolean);
        const unknown = picked.filter((x) => !r.variants!.some((v) => v.id === x));
        if (unknown.length) {
          console.error(`gnl add ${feature}: unknown part(s): ${unknown.join(', ')}`);
          console.error(`  valid: ${r.variants.map((v) => v.id).join(', ')}`);
          process.exit(1);
        }
      } else if (process.stdin.isTTY && !flagBool(ctx.argv, 'yes')) {
        const { checkboxPrompt } = await import('../prompt.js');
        const chosen = await checkboxPrompt(
          r.variants.map((v) => ({ id: v.id, label: v.label, hint: v.hint })),
          { title: `gnl add ${feature} — which ones?`, preChecked: defaultVariants(r) },
        );
        if (chosen === undefined) { console.log('cancelled'); process.exit(0); }
        if (!chosen.length) {
          console.log('nothing picked — no file written.');
          process.exit(0);
        }
        picked = chosen;
      } else {
        picked = defaultVariants(r);
      }
    }

    const target = resolve(r.file);
    if (existsSync(target)) {
      console.log(`${yellow('•')} ${r.file} already exists — leaving it untouched.`);
    } else {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, recipeContents(r, picked));
      console.log(`${green('✓')} created ${bold(r.file)}`);
    }
    // A recipe whose output is a PROCESS brings the script that starts it. Printed instructions are
    // not enough here: a file you cannot run is indistinguishable from a file that does not work.
    if (r.script) {
      const pkgPath = resolve('package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.[r.script.name] === undefined) {
          pkg.scripts = { ...pkg.scripts, [r.script.name]: r.script.cmd };
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          console.log(`${green('✓')} added the ${bold(`pnpm ${r.script.name}`)} script`);
        } else {
          console.log(`${dim('•')} a \`${r.script.name}\` script already exists — left untouched (run: ${r.script.cmd}).`);
        }
      } catch {
        console.log(`${yellow('•')} could not read package.json — add this script yourself: "${r.script.name}": "${r.script.cmd}"`);
      }
    }

    // `.env.example` — the committed half of a `.env`. The scaffold's .gitignore already says
    // `!.env.example`, so the exception existed for a file nothing wrote; a recipe that reads
    // env vars is exactly who knows their names.
    if (r.env?.length) {
      const envPath = resolve('.env.example');
      const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      const missing = r.env.filter((line) => !existing.includes(line.split('=')[0]! + '='));
      if (missing.length) {
        const header = existing ? '' : '# Copy to .env and fill in. `.env` is gitignored; this file is not.\n';
        const block = `${existing.trimEnd()}${existing ? '\n\n' : ''}${header}# ${r.label}\n${missing.join('\n')}\n`;
        writeFileSync(envPath, block.replace(/^\n+/, ''));
        console.log(`${green('✓')} ${existing ? 'updated' : 'created'} ${bold('.env.example')}   (${missing.map((l) => l.split('=')[0]).join(', ')})`);
      }
    }

    // Not every recipe wires into the config — a worker and a scheduler are processes that READ it.
    // Printing "Add to gnl.config.ts:" over an instruction that says the opposite is the command
    // contradicting itself in two consecutive lines.
    console.log(`\n${cyan(r.wiring.code ? 'Add to gnl.config.ts:' : 'How to run it:')}`);
    for (const line of r.humanWire.split('\n')) console.log(`  ${line}`);
    if (r.note) console.log(`\n${dim('note: ' + r.note)}`);
    // THE DEPENDENCY GOES IN, it is not just announced. `gnl add` already writes into this
    // package.json (the script above), and the file it just wrote imports this package — printing
    // "then: pnpm add X" left a project that does not typecheck until the reader notices a dim line.
    // Measured: `gnl add job && pnpm install` produced `Cannot find module '@gnldev/queue'`.
    // (`gnl init` in an EXISTING project is the one place that still only prints — there the
    // manifest is the reader's, and this command is running inside a gnl project by definition.)
    if (r.dep || r.extraDeps?.length) {
      const pkgPath = resolve('package.json');
      // Every package this recipe's FILE imports, each at the range that is true for it — @gnldev/*
      // follows the CLI's own version (lockstep), a third-party provider does not. Computed OUTSIDE
      // the try: a recipe missing a range is our bug and should be loud, not swallowed into the
      // fallback line that a project with no readable manifest gets.
      const { recipeDeps } = await import('../scaffold.js');
      const needed = recipeDeps(r);
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
        // Deps already present are left alone: the reader's pin wins over ours.
        const wanted = Object.entries(needed).filter(([d]) => pkg.dependencies?.[d] === undefined);
        if (wanted.length) {
          pkg.dependencies = { ...pkg.dependencies, ...Object.fromEntries(wanted) };
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          for (const [d] of wanted) console.log(`${green('✓')} added ${bold(d)} to dependencies`);
          console.log(`\n${dim('then: pnpm install')}`);
        }
      } catch {
        console.log(`\n${dim(`then: pnpm add ${Object.keys(needed).join(' ')}`)}`);
      }
    }
  },
};
