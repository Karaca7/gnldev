// @gnldev/tool-schema — provider-specific tool-schema compatibility.
//
// MECHANISM: `ToolSchemaRule` interface — developers write their own rule and add/override it.
// OPT-IN DEFAULT SET: openaiStrict / gemini / anthropic — the AI SDK's known provider gaps.
//
// Opt-in usage with @gnldev/durable:
//   RunDurable({ ..., schemaCompat: true })                  // default set
//   RunDurable({ ..., schemaCompat: [...defaultRules, mine] }) // extend
//   RunDurable({ ..., schemaCompat: [mine] })                 // fully your own set
//
// Correctness: rules are PURE; run before the model call, never touch the journal.
export type { JsonSchema, ModelInfo, ToolSchemaRule } from './types.js';
export { detectModel } from './detect.js';
export { applyToolCompat } from './apply.js';
export { defaultRules } from './defaults.js';
export { openaiStrict } from './rules/openai.js';
export { gemini } from './rules/gemini.js';
export { anthropic } from './rules/anthropic.js';
export { walk, stripStringFormats } from './rules/util.js';
