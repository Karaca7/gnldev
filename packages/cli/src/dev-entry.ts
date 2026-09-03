// Target of `gnl dev`'s tsx-watch: load + serve the gnl.config in cwd. tsx watch restarts on file changes.
import { loadConfig } from './config.js';
import { serveDev } from './dev-server.js';
import { projectDirOf } from './runtime.js';

const path = process.env.GNL_CONFIG ?? 'gnl.config.ts';

/**
 * A startup failure is reported the way `gnl studio` reports it — one line — instead of as an
 * uncaught throw.
 *
 * The difference was only ever cosmetic, and it was measured: the same refused bind printed a clean
 * sentence under `gnl studio` and the same sentence plus three frames of
 * `at resolveBind / at serveDev / at async <anonymous>` under `gnl dev`. The message this package
 * writes for that case is a careful one — it says which admin operations the bind would expose and
 * the two ways to proceed — and burying it under a Node stack trace is how a reader stops reading.
 *
 * Still a non-zero exit, so nothing about the watcher changes: it keeps waiting, and reruns when the
 * file is fixed. That waiting is correct — verified that a broken config, a busy port and a refused
 * bind all recover on the next save. The one case a watcher cannot help with, a config path that does
 * not exist, is refused before the watcher is spawned (see commands/dev.ts).
 */
try {
  const config = await loadConfig(path);
  await serveDev(config, projectDirOf(path), {
    host: process.env.GNL_HOST,
    port: process.env.GNL_PORT ? Number(process.env.GNL_PORT) : undefined,
    allowOpenNetwork: process.env.GNL_ALLOW_OPEN_NETWORK === '1',
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error('  (gnl dev is watching — fix the cause and save to retry, or press Ctrl-C to stop.)');
  process.exit(1);
}
