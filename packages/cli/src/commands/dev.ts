// Gnl dev [--config gnl.config.ts] — hot-reload dev: REST API + Studio Playground on one port.
// Behavior unchanged from the original cli.ts switch-statement version, only moved into the
// Command-module shape (devEntry path adjusted: this file now lives one directory deeper, in dist/commands/).
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';

export const devCommand: Command = {
  name: 'dev',
  group: 'project',
  summary: 'Hot-reload dev: REST API + Studio Playground (single port)',
  usage: 'gnl dev [--config gnl.config.ts] [--port 3000] [--host 127.0.0.1] [--allow-open-network]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    // The actual server runs in the tsx-watch child (dev-entry.ts), so the bind choice travels by env
    // Alongside GNL_CONFIG rather than argv.
    const host = flag(ctx.argv, 'host');
    // There was no way to move off 3000 except editing gnl.config, so a second project or anything
    // else already on the port gave a raw Node EADDRINUSE traceback out of a watch process.
    const port = flag(ctx.argv, 'port') ?? process.env.PORT;
    const allowOpen = flagBool(ctx.argv, 'allow-open-network');
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { readFileSync } = await import('node:fs');

    // Checked HERE, before the watcher exists, because this is the one startup failure `tsx watch`
    // Cannot hold open for you. Measured: every other early failure — a syntax error in the config, a
    // Busy port, a refused bind — leaves the watcher waiting and RECOVERS the moment you fix the file
    // (verified including a cold start on a broken config, and a refused bind fixed by adding `auth`
    // To the config: the server came up on the rerun). That is what a watcher is for.
    //
    // A config path that does not exist is different in kind: there is no file to watch, so creating
    // It later triggers nothing — measured, zero reruns — and `gnl dev` waits for an event that can
    // Never arrive. Failing before the spawn turns the one dead hang into an ordinary error.
    const { existsSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    if (!existsSync(resolvePath(configPath))) {
      throw new Error(
        `config '${configPath}' not found (looked in ${resolvePath(configPath)}).\n` +
        `  Run this from your project root, or point at it with \`gnl dev --config <path>\`.`,
      );
    }

    const require = createRequire(import.meta.url);
    const tsxPkgPath = require.resolve('tsx/package.json');
    const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, 'utf8'));
    const binRel = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx;
    const tsxBin = join(dirname(tsxPkgPath), binRel);
    const devEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev-entry.js');

    const child = spawn(process.execPath, [tsxBin, 'watch', devEntry], {
      stdio: 'inherit',
      // These three are this command's private channel to `dev-entry`, not an interface. Spreading
      // `process.env` and only overwriting when a flag was PASSED let an inherited value decide
      // instead: measured, `GNL_HOST=0.0.0.0 GNL_ALLOW_OPEN_NETWORK=1 gnl dev` bound every interface
      // with no flag on the command line, and the banner then blamed `--allow-open-network` for a
      // Decision nobody had made. `bind.ts` says why that matters — the flag exists so the answer is
      // RECORDED in the command line rather than assumed — and one line in a shell profile or a
      // `docker-compose` env block would have opened every `gnl dev` in that shell from then on.
      //
      // `gnl studio` never read them, so this was a leaking internal, not a documented escape hatch.
      // The parent's decision is now the only source: absent flags mean absent variables.
      env: {
        ...process.env,
        GNL_CONFIG: configPath,
        GNL_HOST: host,
        GNL_PORT: port,
        GNL_ALLOW_OPEN_NETWORK: allowOpen ? '1' : undefined,
      },
    });
    // Forward termination to the tsx child. Without this a SIGTERM to `gnl dev` exited the parent and
    // ORPHANED the watcher, which kept the port bound — so the next `gnl dev` failed with EADDRINUSE
    // on a server nobody could see. `exited` guards the double-signal case (a supervisor sending
    // SIGTERM then SIGKILL) from racing the exit handler.
    let exited = false;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => {
        if (!exited) child.kill(sig);
      });
    }
    child.on('exit', (code, signal) => {
      exited = true;
      // Report the child's fate, so a supervisor sees a signal death as a signal death.
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
  },
};
