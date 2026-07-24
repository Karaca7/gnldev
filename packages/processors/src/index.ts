// @gnl/processors — input/output processors for @gnl/durable agents.
// Built-ins inherit durability: input processors run before persistInput
// (masking is journaled), non-deterministic processors journal via ctx.step.
export { piiRedactor } from './pii.js';
export type { PiiRedactorOptions } from './pii.js';
export { moderationProcessor } from './moderation.js';
export type { ModerationOptions } from './moderation.js';
export { toolFilter } from './tool-filter.js';
export type { ToolFilterOptions } from './tool-filter.js';
export { tokenLimit, promptInjectionDetector, outputLimit, untrustedToolContent } from './safety.js';
export { tokenLimiter } from './token-limiter.js';
export type { TokenLimiterOptions } from './token-limiter.js';
export { PII_PATTERNS, redactString, redactMessages } from './redact.js';
export type { PiiType } from './redact.js';
// Re-export: lets consumers get the Processor type/Tripwire from a single package.
export { ProcessorTripwire } from '@gnl/durable';
export type { Processor, ProcessorToolResult } from '@gnl/durable';
export { toolSearch } from './tool-search.js';
export type { ToolSearchOptions } from './tool-search.js';
