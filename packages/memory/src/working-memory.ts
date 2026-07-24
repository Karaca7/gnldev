// Track 2 — schema working memory: the updateWorkingMemory tool + system injection.
// The tool is wrapped with durableTool inside runDurable → the merge result is journaled (exactly-once; no double-write on resume).
import { tool } from 'ai';
import { z } from 'zod';

export interface WorkingMemoryConfig {
  /** Structured WM schema (zod). Also determines the updateWorkingMemory input. */
  schema?: z.ZodTypeAny;
  /** Alternative: a free-form template (markdown/json). */
  template?: string;
  scope?: 'thread' | 'resource';
  /** true → WM is injected into the system message but the update tool is NOT REGISTERED. */
  readOnly?: boolean;
}

/** The updateWorkingMemory AI SDK tool. `apply` performs the merge and returns the new WM. */
export function createWorkingMemoryTool(opts: {
  apply: (patch: any) => Promise<Record<string, unknown>>;
  schema?: z.ZodTypeAny;
}): Record<string, any> {
  const isObjSchema = !!opts.schema && typeof (opts.schema as any).partial === 'function';
  const inputSchema = isObjSchema ? (opts.schema as any).partial() : z.object({ memory: z.record(z.any()) });
  return {
    updateWorkingMemory: Object.assign(tool({
      description:
        "Update persistent user/session information (deep-merge; set a field's value to null to delete it).",
      inputSchema,
      execute: async (input: any) => {
        const patch = isObjSchema ? input : input?.memory ?? input;
        const merged = await opts.apply(patch);
        return { ok: true, memory: merged };
      },
    }), { idempotent: true } /* H7: repeat with the same input = same WM (deterministic merge) */),
  };
}

/** Dump the current WM + schema/template into the system message (a `<working_memory>` tag, the common pattern). */
export function renderWorkingMemorySystem(current: Record<string, unknown>, cfg: WorkingMemoryConfig): string {
  const body = cfg.template ?? JSON.stringify(current, null, 2);
  const shape = cfg.schema && (cfg.schema as any).shape ? Object.keys((cfg.schema as any).shape) : [];
  const fields = shape.length ? `\nFields: ${shape.join(', ')}` : '';
  const tail = cfg.readOnly ? '' : "\nUpdate persistent information via 'updateWorkingMemory' (null=delete).";
  return `# Working Memory\n<working_memory>\n${body}\n</working_memory>${fields}${tail}`;
}
