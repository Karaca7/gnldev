#!/usr/bin/env node
// `npm create gnl [dir] [flags]` — the same door as `gnl init`, because it IS `gnl init`.
//
// This used to be a 30-line shim around scaffold(dir): no gate, no questions, and every flag —
// `--features` included — silently ignored, while the polished init flow (one gate, then the
// QUESTIONS behind it) sat unreachable behind a different command. The two doors are now one code
// path, so they cannot drift: what `gnl init` asks, `npm create gnl` asks. The count is not written
// down here either — the help text below reads `QUESTIONS.length`.
import { commands, QUESTIONS } from '@gnldev/cli';

const argv = process.argv.slice(2);

if (argv[0] === '--help' || argv[0] === '-h') {
  const flags = commands.init!.usage.replace(/^gnl init\s*/, '');
  console.log(`Usage: npm create gnl ${flags}`);
  console.log('');
  // Counted from the list rather than written down: this line said "three" for a day after the
  // fourth question landed, which is the exact drift a generated string cannot have.
  console.log(`  One gate, at most ${QUESTIONS.length} questions — every one skippable with flags or --yes.`);
  console.log('  Scaffolds a gnl project (mock model, no API key needed).');
  process.exit(0);
}

commands.init!.run({ argv }).catch((e) => {
  console.error('create-gnl:', (e as Error).message);
  process.exit(1);
});
