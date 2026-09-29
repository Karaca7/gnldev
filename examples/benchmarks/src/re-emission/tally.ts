// Classifies a re-emission run by the scenario's ground truth and the engine's own reason for asking.
// No network, no database: it reads a traffic-report JSON and prints the numbers quoted on gnl.dev.
//
//   pnpm re-emission:tally                                   # the committed 2026-09-08 run
//   pnpm re-emission:tally results/re-emission/<file>.json   # a run of your own
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Row { scenario: string; turn: number; intent: string; asked: boolean; origin?: string; executed: boolean; judged: number }
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const file = process.argv[2] ?? here('../../results/re-emission/traffic-report.2026-09-08.json');
const report = JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[]; judgeCalls: number };

// Turns where the model never called a tool (provider errors, or it just talked) are outside the measurement.
const withTool = report.rows.filter((r) => r.executed || r.asked);
const asked = withTool.filter((r) => r.asked);
const isRepeat = (r: Row) => r.intent.startsWith('repeat-of');
const repeats = withTool.filter(isRepeat);

// A question on a turn whose intent was NOT a repeat has two possible causes, and the engine records which:
//   origin 'exact'  → the model emitted a call byte-identical to an earlier one — a real duplicate side
//                     effect the user never asked for (the "re-emission" this benchmark is named after)
//   anything else   → the semantic layer matched two different jobs — a false alarm
const reEmitted = asked.filter((r) => !isRepeat(r) && r.origin === 'exact');
const falseAlarms = asked.filter((r) => !isRepeat(r) && r.origin !== 'exact');

const tally = {
  source: file.split('/').pop(),
  turns: report.rows.length,
  toolTurns: withTool.length,
  questions: asked.length,
  repeatsAsked: `${repeats.filter((r) => r.asked).length}/${repeats.length}`,
  modelReEmittedIdenticalCall: reEmitted.length,
  falseAlarms: falseAlarms.length,
  judgeCalls: report.judgeCalls,
  byOrigin: Object.fromEntries(
    [...new Set(asked.map((r) => r.origin ?? 'unknown'))].map((o) => [o, asked.filter((r) => (r.origin ?? 'unknown') === o).length]),
  ),
};
console.log(JSON.stringify(tally, null, 2));
if (!process.argv[2]) writeFileSync(here('../../results/re-emission/tally.2026-09-08.json'), `${JSON.stringify(tally, null, 2)}\n`);
