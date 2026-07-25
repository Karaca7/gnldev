import type { Processor } from '@gnldev/durable';

export interface ToolFilterOptions {
  /** Only these tools are visible (whitelist). If given, `deny` is ignored. */
  allow?: string[];
  /** These tools are hidden (blacklist). */
  deny?: string[];
}

/**
 * toolFilter — restricts the tool set the model SEES (deterministic; no journaling needed).
 *
 * WARNING (philosophy): Our core approach is "the LLM sees all tools, `guard` controls EXECUTION"
 * (smart + safe). toolFilter, in contrast, hides a tool from the model ENTIRELY → use it opt-in
 * (e.g. role-based visibility). Prefer `guard` to block side effects.
 */
export function toolFilter(opts: ToolFilterOptions): Processor {
  return {
    name: 'tool-filter',
    processTools(tools: Record<string, any>) {
      const out: Record<string, any> = {};
      for (const [name, t] of Object.entries(tools)) {
        if (opts.allow) {
          if (opts.allow.includes(name)) out[name] = t;
        } else if (!opts.deny?.includes(name)) {
          out[name] = t;
        }
      }
      return out;
    },
  };
}
