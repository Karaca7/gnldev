// @gnl/schema-compat — provider-specific tool-schema compatibility.
//
// MECHANISM: `SchemaCompatRule` interface — developers write their own rule and add/override it.
// OPT-IN DEFAULT SET: openaiStrict / gemini / anthropic — the AI SDK's known provider gaps.
//
// Opt-in usage with @gnl/durable:
//   runDurable({ ..., schemaCompat: true })                  // default set
//   runDurable({ ..., schemaCompat: [...defaultRules, mine] }) // extend
//   runDurable({ ..., schemaCompat: [mine] })                 // fully your own set
//
// Correctness: rules are PURE; run before the model call, never touch the journal.
export type { JsonSchema, ModelInfo, SchemaCompatRule } from './types.js';
export { detectModel } from './detect.js';
export { applyToolCompat } from './apply.js';
export { defaultRules } from './defaults.js';
export { openaiStrict } from './rules/openai.js';
export { gemini } from './rules/gemini.js';
export { anthropic } from './rules/anthropic.js';
export { walk, stripStringFormats } from './rules/util.js';
