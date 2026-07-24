import type { SchemaCompatRule } from './types.js';
import { openaiStrict } from './rules/openai.js';
import { gemini } from './rules/gemini.js';
import { anthropic } from './rules/anthropic.js';

/**
 * Opt-in default set — closes the AI SDK's known provider gaps.
 * Deliberately small; when a new quirk appears, the developer extends it with `[...defaultRules, theRule]`.
 */
export const defaultRules: SchemaCompatRule[] = [openaiStrict, gemini, anthropic];
