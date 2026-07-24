#!/usr/bin/env node
// gnl CLI: project (init/dev/studio) · inspect (runs/run/inspect) · operate (fork/resume/sweep/rm).
// Dispatch only — every command's behavior lives in src/commands/<name>.ts (see commands/index.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandList, commands, GROUP_LABELS } from './commands/index.js';
import type { CommandGroup } from './commands/index.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

/** Package version, read from package.json next to dist/ (same pattern dev.ts uses for tsx's package.json). */
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function groupedHelp(): string {
  const groups: CommandGroup[] = ['project', 'inspect', 'operate'];
  const lines: string[] = ['gnl — durable agent CLI', ''];
  for (const g of groups) {
    lines.push(`${GROUP_LABELS[g]}:`);
    for (const c of commandList.filter((c) => c.group === g)) {
      lines.push(`  ${c.usage}`);
      lines.push(`      ${c.summary}`);
    }
    lines.push('');
  }
  lines.push('Other:');
  lines.push('  gnl help [command]               Show this help, or help for one command');
  lines.push('  gnl --version, -v                 Print the installed version');
  lines.push('');
  lines.push('Example:');
  lines.push('  gnl init my-agent && cd my-agent && pnpm install && pnpm dev');
  return lines.join('\n');
}

function printHelp(): void {
  console.log(groupedHelp());
}

/** Small edit-distance so an unknown command gets a "did you mean" suggestion (zero-dep, ~10 lines). */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

function suggest(name: string): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const c of commandList) {
    const dist = levenshtein(name, c.name);
    if (!best || dist < best.dist) best = { name: c.name, dist };
  }
  return best && best.dist <= 2 ? best.name : undefined;
}

async function main(): Promise<void> {
  if (cmd === '--version' || cmd === '-v') {
    console.log(readVersion());
    return;
  }
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = cmd === 'help' ? argv[1] : undefined;
    if (target && commands[target]) {
      const c = commands[target]!;
      console.log(`${c.usage}\n\n  ${c.summary}`);
      return;
    }
    printHelp();
    return;
  }

  const command = commands[cmd];
  if (!command) {
    const hint = suggest(cmd);
    console.error(`gnl: unknown command '${cmd}'${hint ? ` (did you mean '${hint}'?)` : ''}`);
    console.error(`Run 'gnl --help' for the full command list.`);
    process.exitCode = 1;
    return;
  }

  // Every command except init/add loads a gnl.config.ts — real projects write it with the standard
  // TS+NodeNext convention (relative imports end in `.js`, resolving to a sibling `.ts` source file).
  // Plain `node` can strip TS syntax but does not remap a `.js` specifier to `.ts` the way a bundler
  // or tsx's loader does, so a compiled dist/cli.js run via plain `node` can't load such a config on
  // its own. Registering tsx's loader here (once, whole-process) — the same mechanism `gnl dev`
  // already spawns tsx for — makes config loading work without requiring the project to pre-build.
  if (command.name !== 'init' && command.name !== 'add') {
    const { register } = await import('tsx/esm/api');
    register();
  }

  try {
    await command.run({ argv: argv.slice(1) });
  } catch (e: any) {
    console.error(`gnl: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}

void main();
