// Command registry: cli.ts only dispatches through this map + prints grouped help — it doesn't know
// any command's internals. Order here is also the order `gnl --help` lists commands within a group.
import type { Command } from './types.js';
import { initCommand } from './init.js';
import { addCommand } from './add.js';
import { devCommand } from './dev.js';
import { studioCommand } from './studio.js';
import { runsCommand } from './runs.js';
import { runCommand } from './run.js';
import { inspectCommand } from './inspect.js';
import { forkCommand } from './fork.js';
import { resumeCommand } from './resume.js';
import { sweepCommand } from './sweep.js';
import { rmCommand } from './rm.js';

export type { Command, CommandCtx, CommandGroup } from './types.js';

export const commandList: Command[] = [
  initCommand,
  addCommand,
  devCommand,
  studioCommand,
  runsCommand,
  runCommand,
  inspectCommand,
  forkCommand,
  resumeCommand,
  sweepCommand,
  rmCommand,
];

export const commands: Record<string, Command> = Object.fromEntries(commandList.map((c) => [c.name, c]));

export const GROUP_LABELS: Record<Command['group'], string> = {
  project: 'Project',
  inspect: 'Inspect',
  operate: 'Operate',
};
