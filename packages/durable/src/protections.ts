// What is actually protecting this deployment, derived from the resolved config rather than recited.
//
// WHY IT LIVES HERE AND NOT IN THE CLI. This repository has already paid for a hand-maintained list
// once: `gnl dev` printed "(auth: protected)" whenever an auth provider existed, so a project still
// carrying the shipped `admin-dev` token was told it was protected by a credential published in the
// npm registry (see dev-server.ts's own note around the `mode` line). The banner was a second copy
// of a truth it did not own. A second list of protections, kept in the CLI next to the config that
// decides them, is the same mistake with more rows — so the rows are computed HERE, where the
// overlay that turns `preset` into real behaviour also lives (registry.ts's run()/stream()), and
// every surface prints what this function returns.
//
// WHAT IT WILL NOT DO. It reports the CONFIG-time picture. It cannot know what a per-call
// `RunOptions` will override, and it does not pretend to: rows whose value is only a config-time
// default say so. And it cannot see the HTTP surface at all — whether a request's subject is bound
// is a property of the adapter in front of this config, not of the config, so that row is filled by
// the caller (`ProtectionContext.identity`) or it honestly reads "unknown".
import type { CreateGnlConfig } from './registry.js';

/**
 * ✓ on · ○ off · ─ dev-only.
 *
 * The third mark is the one that earns its place. A protection that is on HERE and off in the
 * project's own config is not protection, it is a difference between two machines — and the way that
 * difference is normally discovered is in production, by its absence. `gnl dev` derives a memory
 * store when the config has storage; `src/app.ts` does not. Same config, two behaviours.
 */
export type ProtectionMark = 'on' | 'off' | 'dev-only' | 'unknown';

/**
 * Where the effective value came from. `'preset'` = the profile overlay wrote it, not the author.
 *
 * `'per-call'` and `'unknown'` are both "not from this config", and the difference between them is
 * the difference between not living here and not being knowable from here. A `?` row's `from` column
 * is the only place a reader learns which: `per-call` means each REQUEST answers it (work identity —
 * a workKey or a raw runId, and two callers into one config may differ), `unknown` means the answer
 * exists but is out of sight (identity — the route in front binds the subject, and could have told
 * us via `ProtectionContext.identity`, so its absence really is a gap in what was supplied).
 *
 * The work-identity row used to print `unknown` here while the legend under the same glyph read
 * `? per-call` — the two columns of one row disagreeing about the same fact, which is the one thing
 * a matrix like this cannot afford. It was cosmetic in the sense that no behaviour changed, and not
 * cosmetic at all in the sense that "unknown" reads as a failure to look.
 */
export type ProtectionSource = 'preset' | 'explicit' | 'default' | 'per-call' | 'unknown';

export interface ProtectionRow {
  /** Stable machine-readable id (tests pin these, not the prose). */
  id:
    | 'journal'
    | 'dedup'
    | 'identity'
    | 'workIdentity'
    | 'actorLock'
    | 'threadGate'
    | 'strictInput'
    | 'tombstonePolicy'
    | 'retention';
  /** Column 2 — what is being protected. */
  label: string;
  mark: ProtectionMark;
  /** Column 3 — the effective value, in one phrase. */
  value: string;
  from: ProtectionSource;
  /** Column 4 — what to do about it, when there is something to do. */
  note?: string;
}

/** Facts the config cannot carry, supplied by whoever is printing. */
export interface ProtectionContext {
  /**
   * Does the surface in front of this config bind a SUBJECT to each run?
   *
   * `@gnldev/durable` genuinely cannot answer this. A resolver (`resolveResourceId` / `identity` on the
   * chat and AG-UI routes, `principalOf` in @gnldev/server) is an option of the ROUTE, and the same config
   * can be mounted behind one route that binds and another that does not. Left out, the row reads
   * 'unknown' — which is the honest answer, and a louder one than a wrong ✓.
   */
  identity?: { bound: boolean; via?: string; from?: ProtectionSource; note?: string };
  /**
   * Protections THIS PROCESS turned on that the project's config does not carry. Marked `─`, because
   * the reader's next deployment will not have them.
   */
  devOnly?: { memory?: boolean };
  /** Names the process in the dev-only note, e.g. 'gnl dev'. */
  surface?: string;
}

const MARKS: Record<ProtectionMark, string> = { on: '✓', off: '○', 'dev-only': '─', unknown: '?' };

/** The class name of whatever is doing the storing — the one honest label a Journal port offers. */
function adapterName(config: CreateGnlConfig): string {
  const src = config.storage ?? config.journal;
  const name = (src as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return name && name !== 'Object' ? name : config.storage ? 'storage' : 'journal';
}

/**
 * The rows, in the order a reader needs them: what is being written, what the profile decided, and
 * then the gates that profile did or did not open.
 *
 * THREE-STATE HONESTY. Most of the fields read here distinguish "absent" from "explicitly set"
 * through `undefined` (`config.preset`, `config.memory`, `config.memoryFactory`), so `from` is a
 * measurement, not a guess. The three rows derived from the preset overlay — actor lock, strictInput,
 * tombstonePolicy — have NO config-level field at all: they exist only on `RunOptions`, and the
 * overlay in registry.ts writes them per call (`opts.strictInput ?? true` under `preset: 'critical'`).
 * So at config time their `from` is 'preset' or 'default' and never 'explicit', and each says in its
 * note that a per-call option still wins. That is a limit of where the setting lives, and it is
 * reported rather than papered over with a type refactor.
 */
export function describeProtections(config: CreateGnlConfig, ctx: ProtectionContext = {}): ProtectionRow[] {
  const preset = config.preset;
  const critical = preset === 'critical';
  const surface = ctx.surface ?? 'this process';

  const rows: ProtectionRow[] = [];

  rows.push({
    id: 'journal',
    label: 'journal',
    mark: 'on',
    value: adapterName(config),
    from: 'explicit',
    ...(config.storage ? {} : { note: 'a journal alone has no memory port — `storage` adds threads/recall' }),
  });

  rows.push(
    preset
      ? {
          id: 'dedup',
          label: 'dedup profile',
          mark: 'on',
          value: preset,
          from: 'explicit',
          note:
            preset === 'critical'
              ? 'every repeat is a human question; declared classes keep their own cell'
              : preset === 'headless'
                ? 'no human to ask: a money repeat is refused (typed), notifications/deletes skip'
                : 'a human is on screen: money/notification repeats ask, idempotent writes stay silent',
        }
      : {
          id: 'dedup',
          label: 'dedup profile',
          mark: 'off',
          value: 'none — declarations inert',
          from: 'default',
          // The exact failure this row exists to make visible: a tool can declare `effectClass` and
          // have that declaration do nothing at all, because nothing reads it without a profile.
          note: "a tool's `effectClass` is read only through a profile — add `preset: 'assistant'`",
        },
  );

  rows.push(
    ctx.identity
      ? {
          id: 'identity',
          label: 'identity',
          mark: ctx.identity.bound ? 'on' : 'off',
          value: ctx.identity.bound
            ? `bound via ${ctx.identity.via ?? 'the adapter'}`
            : 'not bound — runs are born ownerless',
          from: ctx.identity.from ?? (ctx.identity.bound ? 'explicit' : 'default'),
          ...(ctx.identity.note
            ? { note: ctx.identity.note }
            : ctx.identity.bound
              ? {}
              : { note: 'ownership gates stay fail-open; give the route `identity` or `resolveResourceId`' }),
        }
      : {
          id: 'identity',
          label: 'identity',
          mark: 'unknown',
          value: 'decided by the surface in front of this config',
          from: 'unknown',
          note: 'the HTTP adapter binds the subject — durable cannot see it from here',
        },
  );

  /**
   * WORK IDENTITY — the one row here that is not a switch, and says so.
   *
   * Whether a call names its work (`workKey`, and the engine derives `run1_<digest>` from it) or
   * hands over a raw `runId` it already holds is decided PER REQUEST, at the door. Two callers into
   * the same config can differ, and the same caller can differ between two endpoints. There is
   * nothing in `CreateGnlConfig` that turns this on or off, so there is nothing here to measure —
   * and `?` is exactly what this matrix already says when the answer lives somewhere it cannot see
   * (compare the `identity` row, which is `?` until the surface in front fills it in).
   *
   * It is a row rather than nothing because of the second sentence. A reader who scans this screen
   * and never learns that two regimes exist will read `run1_…` in a log as an opaque accident, and —
   * more expensively — will size their retention window as "how long do I want history", which is
   * the wrong question. A workKey is recognised for exactly as long as the run record it opened
   * still exists; the sweep that deletes the run makes the key a stranger again. That bond is not
   * derivable from any other row on this screen, and it is the one that decides whether a late retry
   * replays or silently starts the job over.
   *
   * Deliberately NOT filled in from a ProtectionContext the way `identity` is. Identity is a
   * property of the surface (one route binds a subject, another does not); this is a property of
   * each individual CALL, and a per-surface flag would report an average as if it were a fact.
   */
  rows.push({
    id: 'workIdentity',
    label: 'work identity',
    mark: 'unknown',
    value: 'per call: a workKey names it, or a raw runId is it',
    // Matches the legend's gloss for `?` — see ProtectionSource. Nothing here is unknown: WHERE the
    // answer is decided is known exactly, and it is the call.
    from: 'per-call',
    note: 'a workKey is recognised only while its run record lives — keep retention ≥ your clients\' longest retry',
  });

  rows.push({
    id: 'actorLock',
    label: 'actor lock',
    mark: critical ? 'on' : 'off',
    value: critical ? 'auto owner, ttl 300s' : 'per-call `lock` only',
    from: critical ? 'preset' : 'default',
    note: critical
      ? 'a concurrent duplicate of the same runId gets 409, not a second execution'
      : 'RunOptions.lock still applies per call; the chat route takes one by default',
  });

  const memoryOff = config.memory === false;
  const memoryHere = !!(config.memory || config.memoryFactory);
  rows.push(
    ctx.devOnly?.memory && !memoryHere
      ? {
          id: 'threadGate',
          label: 'thread gate',
          mark: 'dev-only',
          value: 'memory derived from storage',
          from: 'default',
          note: `memory is on HERE (${surface}) and off in src/app.ts — \`gnl add memory\``,
        }
      : {
          id: 'threadGate',
          label: 'thread gate',
          mark: memoryHere ? 'on' : 'off',
          value: memoryHere
            ? config.memory
              ? 'memory (object)'
              : 'memory (factory)'
            : memoryOff
              ? 'memory: false — deliberately none'
              : 'no memory — threadId carries nothing',
          from: memoryHere || memoryOff ? 'explicit' : 'default',
          ...(memoryHere ? {} : { note: 'without memory a threadId is a label, not a boundary — `gnl add memory`' }),
        },
  );

  rows.push({
    id: 'strictInput',
    label: 'strictInput',
    mark: critical ? 'on' : 'off',
    value: critical ? 'on — one runId = one request' : 'off',
    from: critical ? 'preset' : 'default',
    note: 'config-time value; a per-call RunOptions.strictInput still wins',
  });

  rows.push({
    id: 'tombstonePolicy',
    label: 'tombstonePolicy',
    mark: critical ? 'on' : 'off',
    value: critical ? "reject — a swept runId's late retry is refused" : 'ignore — a swept runId re-runs',
    from: critical ? 'preset' : 'default',
    note: 'config-time value; a per-call RunOptions.tombstonePolicy still wins',
  });

  rows.push({
    id: 'retention',
    label: 'retention',
    mark: 'off',
    value: 'not wired',
    from: 'default',
    // Said plainly because the alternative is a reader who assumes a sweep runs. Nothing in this
    // process schedules one: sweepRuns/purgeRun are functions, and `gnl sweep` is a command a human
    // or a cron entry runs.
    note: 'nothing sweeps on its own — run `gnl sweep` (or call sweepRuns) from your own schedule',
  });

  return rows;
}

/**
 * The rows as printable lines — ONE formatter, so the REST host and `gnl dev` cannot drift into
 * describing the same config two ways. Returns lines without a trailing newline; the caller decides
 * whether that is one `console.log` or several.
 */
export function formatProtections(rows: ProtectionRow[], opts: { title?: string } = {}): string[] {
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const valueW = Math.max(...rows.map((r) => r.value.length));
  const lines = rows.map((r) => {
    const head = `  ${MARKS[r.mark]} ${r.label.padEnd(labelW)}  ${r.value.padEnd(valueW)}  ${r.from}`;
    return r.note ? `${head}\n      ${r.note}` : head;
  });
  return [
    // `?` WAS MISSING FROM THIS LEGEND, and it is the mark that most needs explaining. Two rows use
    // it — `identity` (the HTTP surface binds the subject; durable cannot see it from here) and
    // `work identity` (decided per call, by whether the caller sends a workKey or a raw runId) — so
    // a reader met an undocumented glyph on exactly the rows where guessing is worst. `?` next to
    // `✓ on · ○ off` reads as "broken" or "unset"; what it actually says is "this one is not a
    // config setting at all — it is answered per call, or by the route in front of this config".
    // Naming it "per-call" rather than "unknown" is the point: unknown sounds like a failure to
    // look, and this is a fact that does not live here. The `from` column of each `?` row says which
    // of the two elsewheres it is — `per-call` (work identity) or `unknown` (identity: the surface
    // knows and did not say). For a while the work-identity row said `unknown` there while this line
    // said `per-call` about the very same glyph.
    `${opts.title ?? 'gnl protections'}   ✓ on · ○ off · ─ dev-only · ? per-call`,
    ...lines,
  ];
}
