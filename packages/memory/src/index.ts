// @gnldev/memory — rich, durable agent memory. One rich class: AgentMemory (Memory + loadContext).
export { AgentMemory } from './agent-memory.js';
export type { MemoryConfig, RecallOptions, LoadedContext, ThreadRecord } from './agent-memory.js';
export { messageText, hasNorm } from './keys.js';
export type { Embed } from './keys.js';
export { deepMerge } from './deep-merge.js';
export { createWorkingMemoryTool, renderWorkingMemorySystem } from './working-memory.js';
export type { WorkingMemoryConfig } from './working-memory.js';
export { observe, reflect, approxTokens, ModelByTokens, createOmRecallTool } from './observational.js';
export type { ObservationalMemoryConfig, Observation, OmRecallMatch, OmVectorStore, OmVectorItem, OmVectorMatch } from './observational.js';
export { MessageList } from './message-list.js';
export type { MessageSource, TaggedMessage } from './message-list.js';
export { defaultEmbed, createDefaultEmbed, memoryPreset } from './presets.js';
export type { MemoryPresetKind, MemoryPresetOptions } from './presets.js';
