// @gnldev/cli programmatic surface (for defineConfig inside gnl.config.ts + for tests/embedding).
//
// The DEV-SERVER half lives at `@gnldev/cli/dev` (src/dev.ts) — buildDevApp/serveDev/loadDevRuntime/
// resolveAuthProvider and the load* runtime resolvers. It is typed against the seven OPTIONAL peers,
// and while it was re-exported here those type references entered the program of anyone importing
// this package at all. Nothing below names a peer except `CreateGnlConfig`, which every project that
// has a gnl.config already depends on.
export { defineConfig, loadConfig } from './config.js';
export type { GnlDevConfig } from './config.js';
// `addHost` is deliberately NOT here. Exporting it put `hosts.d.ts` into the root entry's type
// graph, and that file declares APP_FILE with its VALUE — a template whose text contains
// `from '@gnldev/auth'`, which entry-points-independent.test.ts reads as the root dragging an
// optional peer into a consumer's types. The command modules import it dynamically instead.
export { scaffold, generateConfig } from './scaffold.js';
export type { ScaffoldOptions, ScaffoldResult, TemplateName } from './scaffold.js';
// Feature recipes (shared by `gnl add` + `gnl init` compose) + the pure checkbox reducer (unit-testable).
export { RECIPES, FEATURE_IDS, CHECKBOX_ITEMS, isFeature } from './recipes.js';
// Exported for create-gnl's help text: the question COUNT is a fact about this list, and a second
// copy of it in another package is a sentence that goes stale silently (it said "three" the day the
// fourth question landed).
export { QUESTIONS } from './init-answers.js';
export type { Recipe, RecipeWiring, WiringPlace, CheckboxItem } from './recipes.js';
export { reducer, initState, selection, decodeKey, checkboxPrompt } from './prompt.js';
export type { SelectState, Key, PromptItem } from './prompt.js';
// Command registry (init/dev/studio · runs/run/inspect · fork/resume/sweep/rm) — for embedding/tests
// that want to drive a command's Command.run() programmatically instead of spawning the `gnl` binary.
export { commands, commandList, GROUP_LABELS } from './commands/index.js';
export type { Command, CommandCtx, CommandGroup } from './commands/index.js';
