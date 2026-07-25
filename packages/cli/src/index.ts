// @gnldev/cli programmatic surface (for defineConfig inside gnl.config.ts + for tests/embedding).
export { defineConfig, loadConfig } from './config.js';
export type { GnlDevConfig } from './config.js';
export { buildDevApp, serveDev, loadDevRuntime, resolveAuthProvider } from './dev-server.js';
export type { DevRuntimeModules } from './dev-server.js';
export { scaffold, generateConfig } from './scaffold.js';
export type { ScaffoldOptions, ScaffoldResult, TemplateName } from './scaffold.js';
// Feature recipes (shared by `gnl add` + `gnl init` compose) + the pure checkbox reducer (unit-testable).
export { RECIPES, FEATURE_IDS, CHECKBOX_ITEMS, isFeature } from './recipes.js';
export type { Recipe, RecipeWiring, WiringPlace, CheckboxItem } from './recipes.js';
export { reducer, initState, selection, decodeKey, checkboxPrompt } from './prompt.js';
export type { SelectState, Key, PromptItem } from './prompt.js';
// Runtime resolver (@gnldev/durable/server/studio/memory/auth/hono/@hono-node-server resolved from the
// TARGET PROJECT, not bundled with @gnldev/cli) — for embedding that needs to drive buildDevApp directly.
export { projectDirOf, resolveFromProject, loadDurable, loadServer, loadStudio, loadStudioAi, loadMemory, loadAuth, loadHono, loadNodeServer } from './runtime.js';
// Command registry (init/dev/studio · runs/run/inspect · fork/resume/sweep/rm) — for embedding/tests
// that want to drive a command's Command.run() programmatically instead of spawning the `gnl` binary.
export { commands, commandList, GROUP_LABELS } from './commands/index.js';
export type { Command, CommandCtx, CommandGroup } from './commands/index.js';
