// @gnldev/tool-schema type surface — the core of the mechanism.

/** Tool input schema — JSON Schema node (loose; `any`-friendly across gnl). */
export type JsonSchema = Record<string, any>;

/** Provider identity — for rule matching. */
export interface ModelInfo {
  /** e.g. 'openai', 'google', 'anthropic', 'groq' */
  provider: string;
  /** e.g. 'gpt-4o', 'gemini-1.5-pro', 'claude-3-5-sonnet' */
  modelId: string;
}

/**
 * Extensible tool-schema compatibility rule. Must be PURE: runs BEFORE the model call,
 * never touches the journal, and returns the same output for the same input. Developers can
 * write their own rule and add it to the pipeline (`[...defaultRules, myRule]`).
 */
export interface ToolSchemaRule {
  /** Stable, unique name (for logging/diagnostics). */
  name: string;
  /** Does this rule apply to the given model? */
  shouldApply(model: ModelInfo): boolean;
  /** Transform the JSON Schema (may mutate in place and return the same object). */
  transform(schema: JsonSchema, model: ModelInfo): JsonSchema;
}
