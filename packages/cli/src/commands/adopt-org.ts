// Gnl adopt-org [<id>] [--yes] — moves data written BEFORE organizations were configured into one
// organization. SAFE BY DEFAULT: without --yes this only PREVIEWS, exactly like `gnl sweep`.
//
// The organization id is the OPERATOR'S, and nothing here derives it. On a free deployment there was
// one tenant and only the person upgrading knows which organization that data becomes. So the command
// asks, and refuses to guess: with no id and no TTY it stops rather than picking one.
//
// Asking matters more here than in most commands, because the mistake is irreversible. Adopting into
// a mistyped id moves every row under `org:<typo>:`, and running it again with the correct name fixes
// NOTHING — those rows now carry a prefix, so they count as already-scoped and are skipped. Measured
// end to end. `adoptIntoOrg` additionally refuses an id with no `__org__:<id>` registration record,
// which is the check that catches the typo while it is still correctable.
import type { AdoptIntoOrgResult } from '@gnldev/durable';
import type { Command } from './types.js';
import { flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import { bold, dim, yellow } from '../ansi.js';

/** Reads the organization id from the terminal. `undefined` when there is no TTY to ask. */
async function askOrgId(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Which organization does this data belong to? (id, e.g. acme) ')).trim();
    return answer || undefined;
  } finally { rl.close(); }
}

export function renderAdoptResult(r: AdoptIntoOrgResult): string[] {
  const out: string[] = [];
  const total = Object.values(r.moved).reduce((a: number, b: number) => a + b, 0);
  out.push(`${r.dryRun ? 'Would move' : 'Moved'} ${total} row(s) into ${bold(`org:${r.orgId}:`)}`);
  for (const [store, n] of Object.entries(r.moved).sort()) out.push(`  ${store.padEnd(9)} ${String(n).padStart(5)}`);
  if (r.alreadyScoped) out.push(dim(`  ${'already scoped'.padEnd(9)} ${String(r.alreadyScoped).padStart(5)} (left alone)`));
  if (r.skippedPlatformKeys.length) {
    // Named, not counted. These are the keys whose migration would break the deployment —
    // `schema_version`, the organization registry, the paid user store — and an operator running a
    // migration is entitled to see what it decided not to touch.
    out.push(dim(`  platform keys left at the root: ${r.skippedPlatformKeys.join(', ')}`));
  }
  return out;
}

export const adoptOrgCommand: Command = {
  name: 'adopt-org',
  group: 'operate',
  summary: 'Move pre-organization data into one organization (upgrade path)',
  usage: 'gnl adopt-org [<id>] [--yes] [--config gnl.config.ts]',
  async run(ctx) {
    // No `loadDurable` here, unlike the other operate commands. They need the project's own copy of
    // the framework to call its functions; this one only calls a METHOD on the storage object the
    // config already built, so resolving the package again would add a failure mode (and did — it
    // rejected a project whose packages are linked under a different scope) for nothing.
    const config = await loadConfig(process.env.GNL_CONFIG ?? 'gnl.config.ts');
    const storage = config.storage;
    if (!storage) throw new Error("gnl adopt-org needs `storage` in gnl.config — a journal-only deployment has no ports to migrate.");
    if (typeof storage.adoptIntoOrg !== 'function') {
      throw new Error(`gnl adopt-org: this storage engine (${storage.name}) does not implement adoptIntoOrg.`);
    }

    const positional = ctx.argv.find((a) => !a.startsWith('-'));
    const orgId = positional ?? (await askOrgId());
    if (!orgId) {
      throw new Error(
        'gnl adopt-org: no organization id. Pass one (`gnl adopt-org acme`) or run this in a terminal '
        + 'so it can ask. It is not guessed: the data belongs to whichever organization YOU are '
        + 'upgrading into, and adopting into the wrong one cannot be undone by running it again.',
      );
    }

    const apply = flagBool(ctx.argv, 'yes') || flagBool(ctx.argv, 'force');
    const preview = await storage.adoptIntoOrg(orgId, { dryRun: true });
    for (const l of renderAdoptResult(preview)) console.log(l);

    if (!apply) {
      console.log('');
      console.log(yellow('Preview only — nothing was moved.'));
      console.log(dim(`Run again with --yes to apply:  gnl adopt-org ${orgId} --yes`));
      return;
    }

    console.log('');
    const done = await storage.adoptIntoOrg(orgId);
    for (const l of renderAdoptResult(done)) console.log(l);
    console.log('');
    console.log(dim('Safe to run again: rows that already carry a prefix are counted, not moved.'));
  },
};
