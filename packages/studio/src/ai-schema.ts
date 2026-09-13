// AI SDK bridge — OPTIONAL subpath (`@gnldev/studio/ai`). ONLY this file imports `ai`;
// the studio core (`.` export, server, runner) stays `ai`-free. Converts a tool's zod (or other AI SDK)
// input schema to JSON Schema so the Tools view can generate a form.
//   createStudioRunner(gnl, config, { toJsonSchema: aiToolSchema })
import { asSchema } from 'ai';

/** Converts a zod / AI SDK schema to JSON Schema; returns undefined if it can't be converted (UI shows "no schema"). */
export function aiToolSchema(schema: unknown): unknown {
  try {
    return asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema;
  } catch {
    return undefined;
  }
}
