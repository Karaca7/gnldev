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
import { TEMPLATES, RETIRED_TEMPLATES, type TemplateName } from '../scaffold.js';
import { FEATURE_IDS } from '../recipes.js';
import { HOST_IDS } from '../hosts.js';
import {
  DEFAULT_ANSWERS, QUESTIONS, resolveAnswers, readLastAnswers, writeLastAnswers,
  type InitAnswers, type ResolvedAnswers,
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
    { title: 'gnl init — how should this project start? (SPACE to pick, ENTER to confirm):' },
  );
  if (gate === undefined) return undefined;

  // Enter with nothing picked is the default door, not a cancellation. Somebody who wanted to stop
  // pressed q, and answering "nothing" to "how should this start" most plainly means "the usual way".
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
      { title: `gnl init — ${q.title} (SPACE to pick, ENTER to confirm):` },
    );
    if (picked === undefined) return undefined;
    if (picked === null) continue; // nothing chosen → the default stands, and the summary says so
    (answers as unknown as Record<string, string>)[q.id] = picked;
    from[q.id] = 'asked';
  }
  return { answers, from, pending: [] };
}

/** The one-line shape of a set of answers, for the gate's hints. */
function describeAnswers(a: InitAnswers): string {
  return `${a.store} · preset ${a.preset} · ${a.identity === 'end-users' ? 'per-user identity' : 'no owner'}`;
}

export const initCommand: Command = {
  name: 'init',
  group: 'project',
  summary: 'Create a new project (one gate, at most three questions; mock model, no API key)',
  usage: 'gnl init [dir] [--preset assistant|headless|critical] [--identity internal|end-users] [--store sqlite|pg] [--features a,b,c] [--host hono|node|express|fastify|koa|nest] [--template minimal] [--e2e] [--yes]',
  async run(ctx) {
    const dir = positional(ctx.argv, 0) ?? '.';
    const { scaffold } = await import('../scaffold.js');

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
      host: hostFlag,
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
  console.log(dim('  Features and a server entry are added when you need them: `gnl add <feature>`, `gnl add host`.'));
}
