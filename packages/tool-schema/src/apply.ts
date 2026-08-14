import { asSchema, jsonSchema } from 'ai';
import { detectModel } from './detect.js';
import type { JsonSchema, ModelInfo, ToolSchemaRule } from './types.js';

/**
 * Converts tool.inputSchema (zod | AI SDK Schema | raw JSON) into a JSON Schema COPY.
 * Uses the AI SDK's own `asSchema` → patches the exact same schema that generateText would send.
 */
function toJsonSchema(input: unknown): JsonSchema | undefined {
  if (input == null) return undefined;
  try {
    const s = asSchema(input as Parameters<typeof asSchema>[0]);
    if (s?.jsonSchema && typeof s.jsonSchema === 'object') {
      return structuredClone(s.jsonSchema) as JsonSchema;
    }
  } catch {
    // AsSchema didn't accept it → it might be a raw JSON Schema object (below)
  }
  const obj = input as any;
  if (typeof obj === 'object' && (obj.type || obj.properties || obj.anyOf || obj.oneOf)) {
    return structuredClone(obj) as JsonSchema;
  }
  return undefined;
}

/**
 * Applies provider-specific schema compatibility to a tool set. PURE; must run BEFORE the model call.
 * ALL rules with `shouldApply()===true` are applied in sequence (composition).
 * `execute` and `description` are PRESERVED; only `inputSchema` is patched.
 * If no rule matches, the tool set is returned UNCHANGED (same reference).
 * A tool whose schema can't be extracted, or whose rule throws, does NOT DROP at that step — it passes through as-is/as far as it got.
 */
export function applyToolCompat(
  tools: Record<string, any>,
  model: unknown,
  rules: ToolSchemaRule[],
): Record<string, any> {
  const info: ModelInfo = detectModel(model);
  const active = rules.filter((r) => {
    try {
      return r.shouldApply(info);
    } catch {
      return false;
    }
  });
  if (active.length === 0) return tools;

  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    const base = toJsonSchema(t?.inputSchema);
    if (!base) {
      out[name] = t;
      continue;
    }
    let js: JsonSchema = base;
    for (const r of active) {
      try {
        js = r.transform(js, info) ?? js;
      } catch {
        // A rule error shouldn't drop the tool; skip that rule
      }
    }
    out[name] = { ...t, inputSchema: jsonSchema(js) };
  }
  return out;
}
