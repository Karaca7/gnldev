// Gnl dev [--config gnl.config.ts] — hot-reload dev: REST API + Studio Playground on one port.
// Behavior unchanged from the original cli.ts switch-statement version, only moved into the
// Command-module shape (devEntry path adjusted: this file now lives one directory deeper, in dist/commands/).
import type { Command } from './types.js';
import { flag } from '../args.js';

export const devCommand: Command = {
  name: 'dev',
  group: 'project',
  summary: 'Hot-reload dev: REST API + Studio Playground (single port)',
  usage: 'gnl dev [--config gnl.config.ts]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { readFileSync } = await import('node:fs');

    const require = createRequire(import.meta.url);
    const tsxPkgPath = require.resolve('tsx/package.json');
    const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, 'utf8'));
    const binRel = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx;
    const tsxBin = join(dirname(tsxPkgPath), binRel);
    const devEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev-entry.js');

    const child = spawn(process.execPath, [tsxBin, 'watch', devEntry], {
      stdio: 'inherit',
      env: { ...process.env, GNL_CONFIG: configPath },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  },
};
