// The schema the PROVIDER sees for workflow_<name>, pinned.
//
// `@ai-sdk/provider-utils` forces `additionalProperties: false` on every object it converts through
// its ZOD 4 path (addAdditionalPropertiesToJsonSchema, reached from zod4Schema but not zod3Schema).
// The workflow tool's input was `z.record(z.string(), z.any()).optional()`, so on zod 4 it told the
// model the input object accepts NO properties at all — while the tool's whole purpose is to take an
// arbitrary input object. Measured:
//
//   zod 3.25.76 → {"type":"object","additionalProperties":{}}                       (correct)
//   zod 4.4.3   → {"type":"object","propertyNames":{...},"additionalProperties":false}
//
// Not specific to z.record: `z.looseObject({})` and `z.object({}).passthrough()` are clobbered the
// same way, so there is no zod spelling that survives. The input is now declared with `jsonSchema()`
// from `ai`, which bypasses the converter — and that is what this asserts, because the peer range
// allows both majors and this repo only dev-installs one of them. A test on the zod OUTPUT would
// silently only ever exercise zod 3.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

/** Minimal workflow shape the registry accepts. */
const stubWorkflow = () => ({
  build: () => [{ id: 'a' }],
  run: async () => 'done',
  async runResumable() { return { status: 'completed' as const, output: 'done' }; },
});

/**
 * The tool list the PROVIDER actually receives, captured from inside doGenerate.
 *
 * An ARRAY of `{ type:'function', name, inputSchema }` — the AI SDK's model-facing spec, not the
 * keyed map the caller wrote. Reading it here rather than the caller's map is the point: this is the
 * JSON Schema that reaches the model, after every conversion has happened.
 */
async function providerTools(): Promise<Array<{ name: string; type: string; inputSchema: Record<string, any> }>> {
  let captured: Array<{ name: string; type: string; inputSchema: Record<string, any> }> | undefined;
  const model = createMockModel(async (opts: any) => {
    captured = opts?.tools ?? undefined;
    return finalTextResult('ok');
  });
  const gnl = createGnl({
    journal: new InMemoryJournal(),
    workflows: { onboarding: stubWorkflow() as never },
    agents: { clerk: { model, workflows: ['onboarding'] } },
  } as never);
  await gnl.run('clerk', { runId: 'wf-schema-1', prompt: 'hi' } as never);
  expect(captured, 'the mock model must have received a tool list').toBeDefined();
  return captured!;
}

const workflowTool = (tools: Array<{ name: string }>) => tools.find((t) => t.name === 'workflow_onboarding');

describe('workflow_<name> provider schema', () => {
  it('declares an input object that accepts properties', async () => {
    const wf = workflowTool(await providerTools());
    expect(wf, 'the workflow tool must be exposed to the model').toBeDefined();

    const schema = wf!.inputSchema;
    expect(schema.type).toBe('object');

    const input = schema.properties?.input;
    expect(input, 'the tool must still have an `input` property').toBeDefined();
    expect(input.type).toBe('object');
    // THE assertion. `false` here is the bug: it tells the model the object takes nothing, so a
    // workflow can only ever be started with an empty input.
    expect(
      input.additionalProperties,
      'the workflow input must accept arbitrary properties — `false` means the model is told it takes none',
    ).toBe(true);
  });

  it('carries no zod fingerprint, so it cannot drift with the installed major', async () => {
    const schema = workflowTool(await providerTools())!.inputSchema;
    // `propertyNames` is what zod 4's record conversion emits; its presence means the schema went
    // through the converter after all.
    expect(JSON.stringify(schema)).not.toContain('propertyNames');
    expect(schema.properties.input.description).toBe('input object handed to the workflow');
  });
});
