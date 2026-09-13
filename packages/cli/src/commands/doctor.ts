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
import { bold, dim } from '../ansi.js';

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
    console.log('');
    console.log(dim('  `gnl doctor --share` prints a copyable version with no names in it.'));
  },
};
