// Command registry contract. Every `gnl <name>` subcommand is one module exporting an object shaped
// like this — cli.ts only dispatches + prints global help/version, it doesn't know command internals.
export type CommandGroup = 'project' | 'inspect' | 'operate';

export interface CommandCtx {
  /** argv AFTER the command name (e.g. for `gnl run abc --json`, argv = ['abc', '--json']). */
  argv: string[];
}

export interface Command {
  name: string;
  group: CommandGroup;
  summary: string;
  /** One-line usage shown in `gnl help <name>` and in `gnl --help`. */
  usage: string;
  run(ctx: CommandCtx): Promise<void>;
}
