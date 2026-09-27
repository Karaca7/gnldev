// `gnl init [dir]` — one gate, then at most three questions.
//
// WHAT CHANGED AND WHY. This command used to open with a seven-row feature checkbox and then a
// six-row server picker: thirteen things to have an opinion about, before a project existed, none of
// which can be got wrong permanently — every feature is `gnl add <feature>` later and the server
// choice is two files you can write on the day you deploy. Meanwhile the three decisions that ARE
// expensive to change went unasked and were silently defaulted.
//
// So the questions were swapped for the ones that matter, and the gate in front of them exists
// because most people should not answer any: "Recommended" is a working, protected project and is
// what Enter does.
//
// The three, and the rule that keeps them three, live in init-answers.ts. Read the iron rule there
// before adding a fourth.
//
// NON-INTERACTIVE PATHS, all of which must never block:
//   --preset / --identity / --store  a flag ANSWERS its question, so that question is not asked
//   --yes                            every unanswered question takes its default
//   no TTY (CI, an agent)            same as --yes; the prompt never opens without a terminal
//   --features a,b,c                 still composes; the answers apply on top
//   --template minimal               the static starter; --template full is a retired alias
import type { Command } from './types.js';
import { positional, flag, flagBool } from '../args.js';
import { TEMPLATES, RETIRED_TEMPLATES, recipeDeps, type TemplateName } from '../scaffold.js';
import { FEATURE_IDS, RECIPES, recipeContents, type Recipe } from '../recipes.js';
import { HOST_IDS, HOSTS } from '../hosts.js';
import {
  DEFAULT_ANSWERS, QUESTIONS, resolveAnswers, readLastAnswers, writeLastAnswers,
  type InitAnswers, type ResolvedAnswers, type ServingAnswer,
} from '../init-answers.js';
import { bold, cyan, dim, green } from '../ansi.js';
import { identityRow } from '../protections-view.js';

function parseFeatures(csv: string): string[] {
  const list = csv.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((f) => !FEATURE_IDS.includes(f));
  if (unknown.length) {
    console.error(`gnl init: unknown feature(s): ${unknown.join(', ')}`);
    console.error(`  valid: ${FEATURE_IDS.join(', ')}`);
    process.exit(1);
  }
  return list;
}

/** Reads the three answer flags off argv. A flag that is absent leaves its question to be asked. */
function answerFlags(argv: string[]): Record<string, string | undefined> {
  return Object.fromEntries(QUESTIONS.map((q) => [q.id, flag(argv, q.flag)]));
}

/**
 * Is this run allowed to stop and ask?
 *
 * Both halves matter and they fail differently. Without a TTY the prompt would render escape codes
 * into a log and then wait forever on a stdin that never produces a key — a CI job that hangs until
 * its timeout, with no clue why. `--yes` is the other case: a terminal exists and the human has
 * already said they do not want to be asked.
 */
function canAsk(argv: string[]): boolean {
  return !flagBool(argv, 'yes') && !!process.stdin.isTTY;
}

/**
 * The gate, and then only what the gate asked for.
 *
 * The "Reuse my last answers" door appears ONLY when there are last answers. An option that is
 * present but inert teaches people that options here might not do anything, which is a worse cost
 * than the convenience is worth.
 */
async function askAnswers(resolved: ResolvedAnswers): Promise<ResolvedAnswers | undefined> {
  const { selectPrompt } = await import('../prompt.js');
  const last = readLastAnswers();

  const gate = await selectPrompt(
    [
      { id: 'recommended', label: 'Recommended', hint: describeAnswers(DEFAULT_ANSWERS) },
      { id: 'customize', label: 'Let me choose', hint: `${resolved.pending.length} question(s)` },
      ...(last ? [{ id: 'last', label: 'Same as last time', hint: describeAnswers(last) }] : []),
    ],
    { title: 'gnl init — how should this project start?' },
  );
  if (gate === undefined) return undefined;

  // `null` only reaches here from an empty list, which this one never is — Enter now takes the row
  // under the cursor (prompt.ts, single mode). Kept as the same branch as "recommended" anyway:
  // if a list ever did come up empty, the safe reading of silence is still "the usual way".
  if (gate === 'recommended' || gate === null) return resolved;
  if (gate === 'last' && last) {
    // Flags still outrank remembered answers: the flag is on the command line in front of them.
    return resolveAnswers(Object.fromEntries(
      QUESTIONS.filter((q) => resolved.from[q.id] === 'flag').map((q) => [q.id, resolved.answers[q.id]]),
    ), last, 'last');
  }

  const answers: InitAnswers = { ...resolved.answers };
  const from = { ...resolved.from };
  for (const q of resolved.pending) {
    const picked = await selectPrompt(
      q.options.map((o) => ({ id: o.id, label: o.label, hint: o.hint })),
      { title: `gnl init — ${q.title}` },
    );
    if (picked === undefined) return undefined;
    if (picked === null) continue; // empty list only (Enter takes the cursor row) → default stands
    (answers as unknown as Record<string, string>)[q.id] = picked;
    from[q.id] = 'asked';
  }
  return { answers, from, pending: [] };
}

/**
 * The one follow-up question in this command, asked only when the answer above made it meaningful.
 *
 * Not a fifth question in QUESTIONS: it exists only under two of `serving`'s three answers, and a
 * question that is sometimes absent cannot be a flag-silenced member of a fixed list without making
 * `--host` mean something different depending on another flag. Here it is plainly conditional, and
 * `--host <id>` skips it exactly like the other flags skip theirs.
 */
async function askHost(serving: ServingAnswer): Promise<string | undefined | null> {
  const { selectPrompt } = await import('../prompt.js');
  return selectPrompt(
    HOSTS.map((h) => ({ id: h.id, label: h.label, hint: h.hint })),
    {
      title: serving === 'own'
        ? 'gnl init — which server should it run on?'
        : 'gnl init — which server are you mounting into?',
    },
  );
}

/** The one-line shape of a set of answers, for the gate's hints. */
function describeAnswers(a: InitAnswers): string {
  // The gate's one-line preview, in the same words the questions use. It used to read
  // "sqlite · preset assistant · no owner · gnl dev" — four setting NAMES, three of which a reader
  // meets for the first time on this screen, offered as the summary of a choice they are making now.
  const repeat = a.preset === 'assistant' ? 'repeats ask' : a.preset === 'headless' ? 'repeats refused' : 'repeats refused + locked';
  const owner = a.identity === 'end-users' ? 'per-user' : 'no owner';
  const store = a.store === 'pg' ? 'Postgres' : 'file';
  const serving = a.serving === 'own' ? 'own server' : a.serving === 'mount' ? 'mounted' : 'gnl dev';
  return `${repeat} · ${owner} · ${store} · ${serving}`;
}

const INIT_USAGE = 'gnl init [dir] [--preset assistant|headless|critical] [--identity internal|end-users] [--store sqlite|pg] [--serving dev|own|mount] [--features a,b,c] [--host hono|node|express|fastify|koa|nest] [--template minimal] [--e2e] [--yes]';

// Every flag this command reads. A flag outside this set is refused, not skipped: `--fetures x`
// silently scaffolding the default project is how a caller learns weeks later that their flag never
// did anything — measured on create-gnl, whose old shim swallowed `--features` whole.
const KNOWN_FLAGS = new Set(['preset', 'identity', 'store', 'serving', 'features', 'host', 'template', 'e2e', 'yes']);

export const initCommand: Command = {
  name: 'init',
  group: 'project',
  summary: 'Create a new project (one gate, at most three questions; mock model, no API key)',
  usage: INIT_USAGE,
  async run(ctx) {
    for (const a of ctx.argv) {
      const m = /^--([a-z0-9-]+)/.exec(a);
      if (m && !KNOWN_FLAGS.has(m[1]!)) {
        console.error(`gnl init: unknown flag '--${m[1]}'`);
        console.error(`  usage: ${INIT_USAGE}`);
        process.exit(1);
      }
    }
    const dir = positional(ctx.argv, 0) ?? '.';
    const { scaffold } = await import('../scaffold.js');

    // WHERE AM I — decided before a single question is asked. The first cut of integrate mode
    // detected the directory AFTER the answer flow, so a person picked their three answers and was
    // then told the directory refuses them — measured on the first outside test run, twice in a
    // row, because the refusal did not say what to do instead either. Three states, three answers:
    //   already a gnl project → say so and point at `gnl add`;
    //   an existing app       → integrate (only new files);
    //   non-empty, no manifest → refuse now, not after the questions.
    const fs = await import('node:fs');
    const { join: pJoin, resolve: pResolve } = await import('node:path');
    const targetDir = pResolve(dir);
    const dirNonEmpty = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0;
    if (dirNonEmpty && fs.existsSync(pJoin(targetDir, 'gnl.config.ts'))) {
      console.error('gnl init: this is already a gnl project (gnl.config.ts is here).');
      console.error('  To extend it:  gnl add <idempotency-tool|rag|mcp|memory|workflow|auth>');
      console.error('                 gnl add model <nvidia|openai|anthropic|openai-compatible>');
      console.error('  To scaffold fresh, run `gnl init <dir>` with an empty (or new) directory.');
      process.exit(1);
    }
    const integrate = dirNonEmpty && fs.existsSync(pJoin(targetDir, 'package.json'));
    if (dirNonEmpty && !integrate) {
      console.error(`gnl init: target directory is not empty: ${targetDir}`);
      console.error('  An existing project is recognised by its package.json; a directory with neither');
      console.error('  a manifest nor room to scaffold is one this command will not guess about.');
      process.exit(1);
    }

    // The host flag is orthogonal to every path below. Validated once, here, so a typo fails before
    // anything is written.
    const hostFlag = flag(ctx.argv, 'host');
    if (hostFlag !== undefined && !HOST_IDS.includes(hostFlag)) {
      console.error(`gnl init: unknown host '${hostFlag}'`);
      console.error(`  valid: ${HOST_IDS.join(', ')}`);
      process.exit(1);
    }

    // Answer flags, validated the same way and for the same reason: `--preset critcal` must not
    // quietly produce an unprotected project.
    let resolved: ResolvedAnswers;
    try {
      resolved = resolveAnswers(answerFlags(ctx.argv));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
      return;
    }

    if (canAsk(ctx.argv) && resolved.pending.length) {
      const asked = await askAnswers(resolved);
      if (!asked) { console.log('cancelled'); process.exit(0); }
      resolved = asked;
    }

    // `--host X` on its own still means "give me my own server", which is what it meant before there
    // was a question to ask — the flag predates `--serving` and must not start meaning nothing.
    let host = hostFlag;
    let serving = resolved.answers.serving;
    if (host !== undefined && serving === 'dev') serving = 'own';
    if (serving !== 'dev' && host === undefined) {
      if (!canAsk(ctx.argv)) {
        // A non-interactive run that asked to be served but named no framework. Refused rather than
        // defaulted: picking someone's HTTP framework for them is the one choice here with no
        // recoverable wrong answer — the files land in their tree either way.
        console.error(`gnl init: --serving ${serving} needs --host <${HOST_IDS.join('|')}>`);
        process.exit(1);
      }
      const picked = await askHost(serving);
      if (picked === undefined) { console.log('cancelled'); process.exit(0); }
      // `null` is the empty-list case only; Enter answers with the cursor row. Treated as "not yet"
      // rather than as the first framework in the list, because a server nobody asked for is a file
      // in their tree — `gnl dev` serves it and `gnl add host <id>` is one command away.
      if (picked === null) serving = 'dev'; else host = picked;
    }
    resolved = { ...resolved, answers: { ...resolved.answers, serving } };

    // ── Integrate mode: an EXISTING project (detected above, decided here). ─────────────────────
    // The more common half of "getting started" — most people have an app already, and the old
    // answer here was a refusal ("target directory is not empty"). Same gate, same questions; what
    // changes is what gets written: ONLY new files (gnl.config.ts, src/model.ts when absent, chosen
    // feature files). package.json is never edited — the exact `pnpm add` line is printed instead,
    // because a generator that edits an existing manifest must be right about every package manager
    // and monorepo layout, and one copy-pasteable line is right about all of them.
    if (integrate) {
      const { generateConfig, templatesDir, addHost } = await import('../scaffold.js');
      for (const f of ['template', 'e2e'] as const) {
        if (ctx.argv.some((a) => a === `--${f}` || a.startsWith(`--${f}=`))) {
          console.error(`gnl init: --${f} is for a fresh scaffold — integrating into an existing project writes only gnl.config.ts and new src files.`);
          console.error('  For a full example, run `gnl init` in an empty directory.');
          process.exit(1);
        }
      }
      // `--serving own` is refused HERE and nowhere else: this project already has a server (that is
      // what made this integrate mode), so generating a second one writes a file that competes with
      // the reader's for the port. Mounting is the answer that fits, and it is what an existing app
      // most often wants anyway.
      if (serving === 'own') {
        console.error('gnl init: --serving own writes a second server into a project that already has one.');
        console.error('  Use --serving mount (the lines go into YOUR server file), or run `gnl init` in an empty directory.');
        process.exit(1);
      }
      const featuresCsv = flag(ctx.argv, 'features');
      const featureIds = featuresCsv !== undefined ? parseFeatures(featuresCsv).filter((f) => f !== 'e2e') : [];
      const recipes = featureIds.map((f) => RECIPES[f]).filter((r): r is Recipe => r !== undefined);

      console.log(`${cyan('existing project detected')} (package.json) — integrating gnl instead of scaffolding.`);
      fs.writeFileSync(pJoin(targetDir, 'gnl.config.ts'), generateConfig(recipes, resolved.answers));
      console.log(`${green('✓')} created ${bold('gnl.config.ts')}   (${describeAnswers(resolved.answers)})`);

      // Everything the generated config imports, and nothing else. It names two agents and one tool,
      // so all three have to exist or the config it just wrote would not load — while an existing
      // file with one of those paths is the user's, and is left exactly as it is (the iron rule).
      const write = (rel: string, body: string | Buffer, note = ''): void => {
        const dst = pJoin(targetDir, rel);
        if (fs.existsSync(dst)) { console.log(`${dim('•')} ${rel} already exists — left untouched.`); return; }
        fs.mkdirSync(pJoin(dst, '..'), { recursive: true });
        fs.writeFileSync(dst, body);
        console.log(`${green('✓')} created ${bold(rel)}${note ? `   ${note}` : ''}`);
      };
      const fromTemplate = (rel: string): Buffer => fs.readFileSync(pJoin(templatesDir('minimal'), ...rel.split('/')));
      write('src/agents/assistant.ts', fromTemplate('src/agents/assistant.ts'),
        '(mock model, no API key — switch with `gnl add model <provider>`)');
      write('src/agents/charge-demo.ts', fromTemplate('src/agents/charge-demo.ts'),
        '(calls the tool below, so the wiring is visible from the first run)');
      write(RECIPES['idempotency-tool']!.file, recipeContents(RECIPES['idempotency-tool']!));
      for (const r of recipes) write(r.file, recipeContents(r));

      // EVERY package the files above import, asked of the one function that knows — not `r.dep`,
      // which is singular and therefore silently dropped the second import the otel recipe makes
      // (`piiTextRedactor` from @gnldev/processors). This path only needs the NAMES: the line it
      // prints is the reader's to run, and `pnpm add` picks the range. `pg` rides along for the same
      // reason it does in a fresh scaffold — the config written two lines up imports PostgresStorage,
      // and the driver is an optional peer that nobody would think to ask for.
      const deps = ['@gnldev/durable', '@gnldev/server', '@gnldev/studio', '@gnldev/memory', '@gnldev/auth', 'ai', 'zod',
        ...recipes.flatMap((r) => Object.keys(recipeDeps(r))),
        ...(resolved.answers.store === 'pg' ? ['pg'] : [])];
      console.log(`\n${cyan('Add the dependencies (package.json is yours — nothing was edited):')}`);
      console.log(`  pnpm add ${[...new Set(deps)].join(' ')}`);
      console.log(`  pnpm add -D @gnldev/cli tsx typescript @types/node`);

      try {
        const pkg = JSON.parse(fs.readFileSync(pJoin(targetDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
        const detectedHost = ['hono', 'express', 'fastify', 'koa', '@nestjs/core', 'next'].find((h) => pkg.dependencies?.[h]);
        // Only when nothing was mounted: with `--serving mount` the recipe is already on screen, and
        // telling someone to go fetch what they just received reads as the command not knowing.
        if (detectedHost && serving !== 'mount') {
          const id = detectedHost === '@nestjs/core' ? 'nest' : detectedHost;
          console.log(`\n${dim(`detected ${detectedHost} — your app keeps serving as it does today; \`gnl dev\` runs alongside on its own port.`)}`);
          console.log(dim(`  To put GNL inside it: \`gnl add host ${id} --mount\` prints the lines for your server file.`));
        }
      } catch { /* an unreadable package.json only skips the hint, never the integration */ }

      if (serving === 'mount' && host) {
        // src/app.ts + the lines for the reader's own server file. `addHost` in mount mode writes no
        // server.ts and touches no dependency — both belong to the app that is already here.
        addHost(targetDir, host, 'mount');
        const { hostById, hostReadme } = await import('../hosts.js');
        console.log(`${green('✓')} created ${bold('src/app.ts')}   (the GNL surface — this is what you mount)`);
        console.log(`\n${cyan(`Paste into your ${hostById(host)!.label} server:`)}`);
        for (const line of hostById(host)!.mount.trimEnd().split('\n')) console.log(`  ${line}`);
        // addHost appends to an existing README; a project without one gets the recipe as its own
        // file rather than losing it to the scrollback.
        if (fs.existsSync(pJoin(targetDir, 'README.md'))) {
          console.log(`\n${dim('also appended to README.md, so it survives this terminal')}`);
        } else {
          fs.writeFileSync(pJoin(targetDir, 'GNL.md'), hostReadme(hostById(host)!, 'mount').trimStart());
          console.log(`\n${dim('also written to GNL.md, so it survives this terminal')}`);
        }
      }

      console.log(`\nThen: ${bold('gnl dev')} — REST + Studio Playground against your new gnl.config.ts.`);
      writeLastAnswers(resolved.answers);
      await summarize(resolved);
      return;
    }

    const templateFlag = flag(ctx.argv, 'template');
    const retired = templateFlag !== undefined ? RETIRED_TEMPLATES[templateFlag] : undefined;
    if (templateFlag !== undefined && !retired && !TEMPLATES.includes(templateFlag as TemplateName)) {
      console.error(`gnl: unknown template '${templateFlag}' (expected: ${TEMPLATES.join(' | ')})`);
      console.error(`  retired, still accepted: ${Object.keys(RETIRED_TEMPLATES).join(', ')}`);
      process.exit(1);
    }

    const featuresFlag = flag(ctx.argv, 'features');
    const res = scaffold(dir, {
      answers: resolved.answers,
      ...(featuresFlag !== undefined ? { features: parseFeatures(featuresFlag) } : {}),
      ...(templateFlag !== undefined ? { template: templateFlag as TemplateName } : {}),
      e2e: flagBool(ctx.argv, 'e2e'),
      ...(serving !== 'dev' && host ? { host, hostMode: serving === 'mount' ? 'mount' as const : 'own' as const } : {}),
    });

    // Remembered only on the way out, and only for a project that was actually created. Remembering
    // answers that then failed to scaffold would offer somebody a shortcut back into a broken run.
    writeLastAnswers(resolved.answers);

    if (res.aliasedFrom) {
      console.log(dim(`  --template ${res.aliasedFrom} is now --features ${(retired ?? []).join(',')} — same project, one less template to keep in sync.`));
    }
    report(res, dir);
    await summarize(resolved);
  },
};

function report(res: { dir: string; files: string[]; template: string; features?: string[] }, dir: string): void {
  const tag =
    res.template === 'custom'
      ? `custom: ${(res.features ?? []).length ? (res.features ?? []).join(', ') : 'base'}`
      : res.template;
  const e2eNote = (res.features ?? []).includes('e2e') ? '  (with e2e test — pnpm test)' : '';
  console.log(`${green('✓')} created ${res.dir}  [${tag}]  (${res.files.length} files)${e2eNote}`);
  console.log(`  Next step:  cd ${dir}  &&  pnpm install  &&  pnpm dev`);
}

/**
 * What is protecting the thing that was just created — the rows DERIVED, never listed.
 *
 * The temptation here is a hand-written "✓ dedup on, ✓ journal on" block, and this repository has
 * already paid for one: `gnl dev` printed "(auth: protected)" whenever an auth provider existed, so a
 * project still carrying the shipped `admin-dev` token was told it was protected by a credential
 * published in the npm registry. A closing summary is where that lie is most convincing, because it
 * is the last thing the reader sees and they have no running project to check it against.
 *
 * So the rows come from `describeProtections` — the same function `gnl dev` and `gnl doctor` print,
 * in @gnldev/durable, next to the overlay that decides the behaviour it reports.
 *
 * WHAT IT CANNOT DO, and why. `gnl dev` reads the project's OWN gnl.config.ts through the project's
 * OWN @gnldev/durable. Neither exists yet: the directory was created ninety milliseconds ago and has
 * no node_modules, so importing the config it just wrote would fail on its first import line. What is
 * passed instead is a SHAPE built from the same `answers` that generateConfig was handed — the same
 * input, one function apart. Honest about its limit: it reports the config as WRITTEN, and `gnl
 * doctor` reports the config as LOADED, which is the one that counts once there is something to load.
 */
async function summarize(resolved: ResolvedAnswers): Promise<void> {
  const chosen = QUESTIONS.filter((q) => resolved.from[q.id] !== 'default');
  console.log('');
  console.log(
    chosen.length
      ? `  You answered ${chosen.length} of ${QUESTIONS.length} question(s); the rest took the recommended default.`
      : `  All ${QUESTIONS.length} decisions took the recommended default.`,
  );

  try {
    // Named classes, so the journal row prints the adapter the config actually names rather than a
    // generic word. The only thing describeProtections reads off a storage is its constructor name.
    const Adapter = resolved.answers.store === 'pg'
      ? class PostgresStorage {}
      : class SqliteStorage {};
    const shape = {
      storage: new Adapter(),
      preset: resolved.answers.preset,
      subjects: resolved.answers.identity,
    };
    const d = await import('@gnldev/durable');
    if (typeof d.describeProtections !== 'function') return;
    const rows = d.describeProtections(shape as never, {
      surface: 'gnl init',
      identity: identityRow(shape as never, false),
    });
    console.log(d.formatProtections(rows, { title: `  ${bold('what is protecting it')}` }).join('\n'));
    const off = rows.filter((r) => r.mark === 'off');
    if (off.length) {
      console.log(dim(`  ${off.length} row(s) are off — each is a command, not a rewrite. ${cyan('gnl doctor')} prints this again, from the config as LOADED.`));
    }
  } catch {
    // The project is fine. Only the block is missing — a cosmetic summary must never turn a
    // successful scaffold into a failed command.
  }
  // The serving answer decides which half of this is worth saying. Telling somebody who just chose
  // "mounted" how to get a server entry is the command failing to remember what it was told.
  if (resolved.answers.serving === 'dev') {
    // The answer that says "a worker or cron job lives here too" used to end the conversation there:
    // the reader identified themselves as exactly the case this framework has two packages for, and
    // was told nothing about either. Now the answer routes.
    console.log(dim('  A worker or a cron job? `gnl add job` · `gnl add schedule` — each runs as its own process.'));
    console.log(dim('  A server, the day you deploy: `gnl add host <framework>` (add `--mount` for one you already run).'));
  }
  console.log(dim('  Everything else is additive: `gnl add <feature>`.'));
}
