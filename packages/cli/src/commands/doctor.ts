// `gnl doctor` — what is protecting this project, and when it last did something about it.
//
// Two things a project cannot otherwise find out about itself, and one thing this command
// deliberately refuses to do.
//
// WHAT IS ON. The protections matrix, from `describeProtections` in @gnldev/durable — the SAME rows
// `gnl dev` prints, from the same function, next to the overlay that decides the behaviour it
// describes. Not a second list kept here: a hand-maintained protection banner in this CLI once
// reported "protected" because an auth provider existed, while that provider's only credential was a
// token published in the npm tarball. The lesson is not "be careful", it is "do not keep a second
// copy". So there is one, in durable, and every surface prints what it returns.
//
// WHETHER IT EVER FIRED. A matrix full of ✓ is a claim about configuration. It says nothing about
// whether the configuration has ever met a duplicate — and a dedup profile that has never declined
// anything is indistinguishable, from the config alone, from one that is wired to nothing. So the
// stamps below read the journal: when the first run happened, and when a guard first refused
// something. The gap between them is the only honest measure of "how long until this was actually
// protecting me", and it is a local fact, computed from local records.
//
// WHAT IT WILL NOT DO. `--share` prints to the SCREEN. It opens no socket, sends nothing, and reports
// no identifiers — not the project name, not the config's keys, not a machine id. What it prints is
// the SHAPE: which protections are on, which are off, and the two timestamps. That is what a person
// asking for help needs to paste, and it is deliberately the whole of what this command knows how to
// produce. There is no telemetry here to opt out of, because there is none to opt into.
import type { Command } from './types.js';
import type * as Durable from '@gnldev/durable';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { identityRow } from '../protections-view.js';
import { bold, dim, yellow } from '../ansi.js';

/**
 * How far back the incident search is willing to walk.
 *
 * Finding the FIRST guard firing means asking runs in age order until one has an incident, and a
 * journal with ten thousand clean runs would make that ten thousand reads for a line of output. The
 * cap is generous for the local journal this command is pointed at, and when it is hit the report says
 * so rather than reporting "never" — "we did not look far enough" and "it never happened" are
 * different answers and only one of them is true.
 */
const MAX_RUNS_SCANNED = 500;

/** Sources that mean a DUPLICATE was caught, as opposed to a loop or a call-count ceiling. */
const GUARD_SOURCES = new Set(['duplicate-guard', 'semantic-guard', 'semantic-judge']);

export interface DoctorStamps {
  /** Write time of the oldest entry of the oldest run, when the adapter records write times. */
  firstRunAt?: number;
  /** Time of the earliest duplicate/semantic guard incident found. */
  firstGuardAt?: number;
  /** The guard that fired first, for the line that reports it. */
  firstGuardSource?: string;
  runsScanned: number;
  /** True when the walk stopped at MAX_RUNS_SCANNED without finding an incident. */
  truncated: boolean;
  /** True when there are runs but the adapter does not record write times (`JournalEntry.ts`). */
  timesUnavailable: boolean;
}

/**
 * The local stamps, as a pure function of (journal, durable) — no console, same testability shape as
 * `listRunsCore`.
 *
 * ASCENDING ORDER IS THE CONTRACT this leans on: `listRuns()` returns runs in append order and
 * `readRun()` returns entries in ascending write-time order (JournalReader's documented ordering,
 * which limits.ts and regression.ts already depend on). So the oldest run is the first element, and
 * the first run to carry an incident is the earliest one that has any.
 */
export async function doctorStamps(journal: Durable.Journal & Durable.JournalReader, d: typeof Durable): Promise<DoctorStamps> {
  const out: DoctorStamps = { runsScanned: 0, truncated: false, timesUnavailable: false };
  const runs = await journal.listRuns();
  if (!runs.length) return out;

  const first = await journal.readRun(runs[0]!.runId).catch(() => []);
  const times = first.map((e) => e.ts).filter((t): t is number => typeof t === 'number');
  if (times.length) out.firstRunAt = Math.min(...times);
  else out.timesUnavailable = true;

  for (const summary of runs) {
    if (out.runsScanned >= MAX_RUNS_SCANNED) { out.truncated = true; break; }
    out.runsScanned++;
    // Best-effort per run: a journal that cannot answer for one run must not stop the report. The
    // incident reader already degrades to [] on an adapter with no listKeys.
    const incidents = await d.readIncidents(journal, summary.runId).catch(() => []);
    const hit = incidents.filter((i) => GUARD_SOURCES.has(i.source)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
    if (hit) {
      out.firstGuardAt = hit.at;
      out.firstGuardSource = hit.source;
      break;
    }
  }
  return out;
}

/** A run row that no run ever wrote — see `doctorGhostRuns`. */
export interface GhostRun {
  runId: string;
  /** What a sweep would delete under `${runId}:`, capped — enough to recognise whose data it is. */
  wouldDelete: string[];
  /** True when the listing was capped, so the operator reads "at least these" rather than "these". */
  more: boolean;
}

/**
 * Run rows that were never runs — the read-only half of the key-schema collision.
 *
 * `parseJournalKey` claims any key with a `:model:`/`:tool:` SEGMENT as a run record, whatever
 * namespace it started in, and every adapter derives its run index from that on write. So a thread,
 * organization or resource named `model` mints a run row named after its own keyspace — `mem`,
 * `xthr`, `org` — and `sweepRuns` then purges that "run" by PREFIX. Measured: two unrelated users'
 * threads, one sweep, `listKeys('')` empty.
 *
 * THE POISON IS ALREADY WRITTEN. It froze into `gnl_runs` / `gnl_run_journal.run_id` at write time,
 * so no later code change reaches it — which is why this reports before anything repairs.
 *
 * THE RULE IS `:input`, and it is not a heuristic: `run.ts` writes that key unconditionally, before
 * the first model call, for every run — which is exactly why `runIdOfKey` leans on it. A run that
 * died at step 0 (an upstream 401, a guard rejection, a limit tripped early) therefore still has
 * one, and must not be reported. Naming that class wrongly would be worse than silence: an operator
 * who repairs a real run deletes a real run.
 *
 * READ-ONLY BY CONSTRUCTION. It lists and it gets. Nothing here writes, and nothing here deletes —
 * the report is for a person to read before deciding, not a repair that runs itself.
 */
export async function doctorGhostRuns(
  journal: Durable.Journal & Durable.JournalReader,
  max = MAX_RUNS_SCANNED,
): Promise<{ ghosts: GhostRun[]; runsScanned: number; truncated: boolean; keysUnavailable: boolean }> {
  const out = { ghosts: [] as GhostRun[], runsScanned: 0, truncated: false, keysUnavailable: false };
  const runs = await journal.listRuns();
  const canList = typeof journal.listKeys === 'function';
  out.keysUnavailable = !canList && runs.length > 0;

  for (const summary of runs) {
    if (out.runsScanned >= max) { out.truncated = true; break; }
    out.runsScanned++;
    // A failed read is not an absent key. Treating "I could not look" as "it is not there" is how a
    // detector reports a healthy run as a ghost, so an unreadable input is left alone.
    let input: unknown;
    try { input = await journal.get(`${summary.runId}:input`); } catch { continue; }
    if (input !== undefined) continue;

    const CAP = 5;
    const keys = canList ? await journal.listKeys!(`${summary.runId}:`).catch(() => [] as string[]) : [];
    out.ghosts.push({ runId: summary.runId, wouldDelete: keys.slice(0, CAP), more: keys.length > CAP });
  }
  return out;
}

/** `3d 4h` / `12m` / `8s` — a duration a person reads, not a number of milliseconds. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const units: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1000, 's']];
  const parts: string[] = [];
  let rest = ms;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { parts.push(`${n}${label}`); rest -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '0s';
}

const iso = (t?: number): string => (typeof t === 'number' ? new Date(t).toISOString() : 'never');

/**
 * The shareable block: protections and stamps, and nothing that identifies anybody.
 *
 * Every row is reduced to its id and its mark. Not the adapter's name (a connection string's shape is
 * a hint about somebody's infrastructure), not the agent names, not the path, not the project. A
 * reader of this block can tell what is on and what is off and how long the project has been running,
 * which is exactly what a question about a protection needs, and nothing else.
 */
export function shareBlock(rows: readonly { id: string; mark: string }[], stamps: DoctorStamps): string[] {
  const lines = ['```', 'gnl protections'];
  for (const r of rows) lines.push(`  ${r.mark.padEnd(8)} ${r.id}`);
  lines.push(`  first run          ${iso(stamps.firstRunAt)}`);
  lines.push(`  first guard firing ${iso(stamps.firstGuardAt)}`);
  if (stamps.firstRunAt && stamps.firstGuardAt) {
    lines.push(`  time to first protected run  ${humanDuration(stamps.firstGuardAt - stamps.firstRunAt)}`);
  }
  lines.push('```');
  return lines;
}

export const doctorCommand: Command = {
  name: 'doctor',
  group: 'inspect',
  summary: 'What is protecting this project, and when a guard last caught something',
  usage: 'gnl doctor [--share] [--config gnl.config.ts]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const config: GnlDevConfig = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));

    if (typeof d.describeProtections !== 'function') {
      throw new Error(
        "this project's @gnldev/durable is older than `describeProtections` — upgrade it, or run `gnl dev`, which degrades without the matrix.",
      );
    }

    // `bound: false` on purpose. This command loads a CONFIG; it does not stand up a route, so it
    // cannot observe a subject being resolved. Claiming otherwise from a declaration would be the
    // "(auth: protected)" banner again, in a command whose whole job is to be trusted about this.
    const rows = d.describeProtections(config as never, {
      surface: 'gnl doctor',
      identity: identityRow(config, false),
    });

    const journal = getJournal(config, d);
    const stamps = await doctorStamps(journal, d);

    if (flagBool(ctx.argv, 'share')) {
      console.log(dim('  Copy the block below. It leaves this machine only if you paste it — nothing here sends anything.'));
      console.log('');
      for (const line of shareBlock(rows, stamps)) console.log(line);
      return;
    }

    console.log(d.formatProtections(rows, { title: bold('gnl protections') }).join('\n'));
    console.log('');
    console.log(bold('this journal'));

    if (!stamps.runsScanned) {
      console.log('  no runs yet — nothing has been protected because nothing has run.');
      console.log(dim('  `gnl dev`, then ask the same thing twice in the Playground.'));
      return;
    }

    // Before the protection story, the thing that would DELETE it. A ghost run is not a warning
    // about the future — the row is already in the index, and the next sweep is what spends it.
    const ghostly = await doctorGhostRuns(journal).catch(() => null);
    if (ghostly?.ghosts.length) {
      console.log(`  ${bold('run rows that were never runs')}  ${ghostly.ghosts.length}`);
      for (const g of ghostly.ghosts) {
        console.log(`    ${g.runId}${dim(' — a sweep would delete everything under this prefix:')}`);
        for (const k of g.wouldDelete) console.log(`      ${k}`);
        if (g.more) console.log(dim('      …and more'));
      }
      console.log(dim('  These came from an id containing a `model` or `tool` segment (a thread, organization'));
      console.log(dim('  or resource name). The rows are already written; upgrading alone does not remove them.'));
      console.log(dim('  Do not delete anything by hand from this list — the prefixes hold real data.'));
      console.log('');
    } else if (ghostly?.keysUnavailable) {
      console.log(dim('  ghost-run scan: this adapter cannot list keys, so the scan did not run'));
    }

    console.log(`  first run           ${stamps.timesUnavailable ? dim('unknown — this adapter records no write times') : iso(stamps.firstRunAt)}`);
    if (stamps.firstGuardAt !== undefined) {
      console.log(`  first guard firing  ${iso(stamps.firstGuardAt)}  ${dim(`(${stamps.firstGuardSource})`)}`);
      if (stamps.firstRunAt !== undefined) {
        console.log(`  ${bold('time to first protected run')}  ${humanDuration(stamps.firstGuardAt - stamps.firstRunAt)}`);
      }
    } else if (stamps.truncated) {
      // "Did not look far enough" is not "never happened", and reporting the second would be a lie
      // that reads as reassurance.
      console.log(`  first guard firing  ${dim(`none in the ${stamps.runsScanned} oldest runs — stopped there`)}`);
    } else {
      console.log(`  first guard firing  ${dim('never — no duplicate has been caught yet')}`);
      console.log(dim(`  Across ${stamps.runsScanned} run(s). A profile that has never declined anything looks, from here,`));
      console.log(dim('  exactly like one wired to nothing. Ask for the same side effect twice to see which you have.'));
    }
    // Thread state no erasure request can reach. Read-only on purpose: `sweepThreads` reports the
    // same list but DELETES as it goes, so it can never be the thing a diagnostic command calls.
    // Counted rather than listed by default — a thread id is a name, and this is a report someone
    // may well paste into an issue.
    const orphans = await d.listOrphanThreadState(journal).catch(() => undefined);
    if (orphans && orphans.threadIds.length > 0) {
      console.log('');
      console.log(`  ${yellow('orphaned thread state')}  ${orphans.threadIds.length} thread(s)`);
      console.log(dim('  Runs with no resourceId left state behind: no person owns it, so no erasure'));
      console.log(dim('  request can reach it. `sweepThreads()` deletes by age; this is only the count.'));
    }
    // A key this build cannot classify is the one case the count above cannot include — and the
    // reason it is printed separately rather than folded in: nobody can act on a number that mixes
    // "state with no owner" with "state I could not read the shape of".
    if (orphans && orphans.unrecognisedKeys.length > 0) {
      console.log('');
      console.log(`  ${yellow('unrecognised thread keys')}  ${orphans.unrecognisedKeys.length}`);
      console.log(dim('  Written under an `xthr:` family this version does not know — likely a newer'));
      console.log(dim('  @gnldev/durable wrote them. No sweep here can reclaim what it cannot parse.'));
    }
    console.log('');
    console.log(dim('  `gnl doctor --share` prints a copyable version with no names in it.'));
  },
};
