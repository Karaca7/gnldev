// gnl init [dir] — scaffold a new project (mock model, no API key). Four ways to pick what goes in:
//   --features a,b,c   non-interactive custom compose (skips the checkbox)
//   --template full|minimal   a preset static starter
//   --yes / non-TTY    minimal (the prompt NEVER opens without a TTY → CI-safe)
//   otherwise (TTY)    interactive checkbox → compose the selected features
import type { Command } from './types.js';
import { positional, flag, flagBool } from '../args.js';
import { TEMPLATES, type TemplateName } from '../scaffold.js';
import { FEATURE_IDS, CHECKBOX_ITEMS } from '../recipes.js';
import { HOSTS, HOST_IDS } from '../hosts.js';

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

export const initCommand: Command = {
  name: 'init',
  group: 'project',
  summary: 'Create a new project (interactive feature picker; mock model, no API key)',
  usage: 'gnl init [dir] [--features a,b,c] [--host hono|node|express|fastify|koa|nest] [--template minimal|full] [--e2e] [--yes]',
  async run(ctx) {
    const dir = positional(ctx.argv, 0) ?? '.';
    const { scaffold } = await import('../scaffold.js');

    // 1. --features → non-interactive custom compose.
    // The server flag is orthogonal to every path below: it may accompany --features, --template,
    // --yes, or the interactive run. Validated once, here, so a typo fails before anything is written.
    const hostFlag = flag(ctx.argv, 'host');
    if (hostFlag !== undefined && !HOST_IDS.includes(hostFlag)) {
      console.error(`gnl init: unknown host '${hostFlag}'`);
      console.error(`  valid: ${HOST_IDS.join(', ')}`);
      process.exit(1);
    }

    const featuresFlag = flag(ctx.argv, 'features');
    if (featuresFlag !== undefined) {
      const features = parseFeatures(featuresFlag);
      const res = scaffold(dir, { features, e2e: flagBool(ctx.argv, 'e2e'), host: hostFlag });
      report(res, dir);
      return;
    }

    // 2. --template → a preset static starter.
    const templateFlag = flag(ctx.argv, 'template');
    if (templateFlag !== undefined) {
      if (!TEMPLATES.includes(templateFlag as TemplateName)) {
        console.error(`gnl: unknown template '${templateFlag}' (expected: ${TEMPLATES.join(' | ')})`);
        process.exit(1);
      }
      const res = scaffold(dir, { template: templateFlag as TemplateName, e2e: flagBool(ctx.argv, 'e2e'), host: hostFlag });
      report(res, dir);
      return;
    }

    // 3. --yes or no TTY → minimal (never open the prompt without an interactive terminal → CI-safe).
    if (flagBool(ctx.argv, 'yes') || !process.stdin.isTTY) {
      // No server file unless one was named: --yes must not silently pick a framework for you.
      const res = scaffold(dir, { template: 'minimal', e2e: flagBool(ctx.argv, 'e2e'), host: hostFlag });
      report(res, dir);
      return;
    }

    // 4. Interactive checkbox → compose the selection.
    const { checkboxPrompt } = await import('../prompt.js');
    const selected = await checkboxPrompt(CHECKBOX_ITEMS, { title: 'gnl init — select features (SPACE to toggle, ENTER to confirm):' });
    if (selected === undefined) {
      console.log('cancelled');
      process.exit(0);
    }
    // 5. Which server this will actually run on. Asked SECOND because it is the question people do
    //    not know they need until they try to deploy — `gnl dev` serves the project without it, so
    //    the gap only shows up on the day it is expensive.
    const { selectPrompt } = await import('../prompt.js');
    const host = hostFlag ?? await selectPrompt(
      [...HOSTS.map((h) => ({ id: h.id, label: h.label, hint: h.hint })),
       { id: '', label: 'none for now', hint: 'gnl dev serves it; add src/server.ts later' }],
      { title: 'gnl init — which server will you run this on? (SPACE to pick, ENTER to confirm):' },
    );
    if (host === undefined) {
      console.log('cancelled');
      process.exit(0);
    }
    const res = scaffold(dir, { features: selected, host: host || undefined });
    report(res, dir);
  },
};

function report(res: { dir: string; files: string[]; template: string; features?: string[] }, dir: string): void {
  const tag =
    res.template === 'custom'
      ? `custom: ${(res.features ?? []).length ? (res.features ?? []).join(', ') : 'base'}`
      : res.template;
  const e2eNote =
    res.template === 'full' || (res.features ?? []).includes('e2e') ? '  (with e2e test — pnpm test)' : '';
  console.log(`✓ created ${res.dir}  [${tag}]  (${res.files.length} files)${e2eNote}`);
  console.log(`  Next step:  cd ${dir}  &&  pnpm install  &&  pnpm dev`);
}
