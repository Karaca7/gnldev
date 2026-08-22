/**
 * `@gnldev/cli/dev` — the dev-server surface, split out of the root entry.
 *
 * Everything here is typed against the SEVEN optional peers (`@gnldev/durable`, `server`, `studio`,
 * `studio/ai`, `memory`, `auth`, `hono`, `@hono/node-server`). While it lived on the root entry, those
 * type references were pulled into the program of anyone who imported the package at all — so
 * `import { scaffold } from '@gnldev/cli'` in a project with none of them installed produced 16
 * `TS2307: Cannot find module` errors under `skipLibCheck: false`. `create-gnl` imports exactly that
 * one symbol, and it is a scaffolder: it has no reason to carry a web framework.
 *
 * Moving rather than deleting, because the reachability is now honest instead of accidental. Importing
 * this module means booting the dev server, and anything that boots the dev server has the peers by
 * definition — they are what it boots. The root entry keeps config, scaffold, recipes, prompt and the
 * command registry, none of which name a peer.
 */
export { buildDevApp, serveDev, loadDevRuntime, resolveAuthProvider } from './dev-server.js';
export type { DevRuntimeModules } from './dev-server.js';
// Runtime resolver (@gnldev/durable/server/studio/memory/auth/hono/@hono-node-server resolved from the
// TARGET PROJECT, not bundled with @gnldev/cli) — for embedding that needs to drive buildDevApp directly.
export { projectDirOf, resolveFromProject, loadDurable, loadServer, loadStudio, loadStudioAi, loadMemory, loadAuth, loadHono, loadNodeServer } from './runtime.js';
