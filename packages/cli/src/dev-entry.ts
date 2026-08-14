// Target of `gnl dev`'s tsx-watch: load + serve the gnl.config in cwd. tsx watch restarts on file changes.
import { loadConfig } from './config.js';
import { serveDev } from './dev-server.js';
import { projectDirOf } from './runtime.js';

const path = process.env.GNL_CONFIG ?? 'gnl.config.ts';
const config = await loadConfig(path);
await serveDev(config, projectDirOf(path), {
  host: process.env.GNL_HOST,
  allowOpenNetwork: process.env.GNL_ALLOW_OPEN_NETWORK === '1',
});
