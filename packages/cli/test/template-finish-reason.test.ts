// The scaffolded templates' mock models must report the finish reason in the shape a v4 provider
// emits and AI SDK 7 reads: `finishReason: { unified, raw }`. A bare string leaves
// `finishReason.unified` undefined, and from ai@7.0.70 the agent loop stops BEFORE executing any
// tool — so `gnl init --template full` shipped an agent that never called its tool, and the
// template's own `pnpm test` failed 2/2 on a fresh scaffold.
//
// This file lives in packages/cli/test (NOT in templates/*/test): the root vitest config only
// includes `packages/*/test/**`, so a test placed next to the template would never run in CI. It
// reaches the template by relative path instead.
//
// NOTE ON `ai`: the model factories are not exported by the templates — `assistant.model` IS the
// model object, so it is imported through the AgentConfig the template exports. The templates'
// `@gnldev/durable` import is type-only (erased); `./tools.js` resolves to the template's own
// tools.ts through vite's TS extension resolution.
import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { assistant as minimalAssistant } from '../templates/minimal/src/model.js';
import { assistant as fullAssistant } from '../templates/full/src/model.js';

const aiVersion: string = createRequire(import.meta.url)('ai/package.json').version;

/** Drains a v4 doStream ReadableStream into an array of parts. */
async function drain(stream: ReadableStream<any>): Promise<any[]> {
  const parts: any[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

const minimalModel = minimalAssistant.model as any;
const fullModel = fullAssistant.model as any;

/** A tool-result message shaped like the one the SDK feeds back on the second turn. */
const AFTER_TOOL_PROMPT = [
  { role: 'user', content: [{ type: 'text', text: 'charge order-1' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'chargeOrder', input: '{}' }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'chargeOrder', output: { charged: 42 } }] },
];

// ── B1: the shape itself, asserted at RUNTIME (nothing typechecks these template files) ──
describe('template mock models emit finishReason as {unified, raw}', () => {
  // The exact thing that regressed: a bare string. `typeof` is asserted explicitly, because
  // `finishReason === 'stop'` and `finishReason.unified === 'stop'` are both "truthy and correct
  // looking" from a distance, and only one of them is what AI SDK 7 reads.
  it('minimal echoModel doGenerate: finishReason is an object with unified === "stop"', async () => {
    const r = await minimalModel.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    expect(typeof r.finishReason).toBe('object');
    expect(r.finishReason).not.toBeNull();
    expect(r.finishReason.unified).toBe('stop');
    expect(r.finishReason.raw).toBe('stop');
    // sanity: the model still does its job (an all-object finishReason with no content would pass above)
    expect(r.content[0].text).toBe('echo: hi');
  });

  it('minimal echoModel doStream: the finish part carries finishReason.unified === "stop"', async () => {
    const { stream } = await minimalModel.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    const finishPart = (await drain(stream)).find((p) => p.type === 'finish');
    expect(finishPart).toBeTruthy();
    expect(typeof finishPart.finishReason).toBe('object');
    expect(finishPart.finishReason.unified).toBe('stop');
  });

  // Turn 1 is the one that broke the `full` template: 'tool-calls' as a bare string means the loop
  // never runs chargeOrder, and the template exists to demonstrate exactly-once side effects.
  it('full toolCallingMock doGenerate turn 1: finishReason is an object with unified === "tool-calls"', async () => {
    const r = await fullModel.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'charge order-1' }] }] });
    expect(typeof r.finishReason).toBe('object');
    expect(r.finishReason.unified).toBe('tool-calls');
    expect(r.finishReason.raw).toBe('tool-calls');
    expect(r.content[0].type).toBe('tool-call');
    expect(r.content[0].toolName).toBe('chargeOrder');
  });

  it('full toolCallingMock doGenerate turn 2 (a tool result is in the prompt): unified === "stop"', async () => {
    const r = await fullModel.doGenerate({ prompt: AFTER_TOOL_PROMPT });
    expect(typeof r.finishReason).toBe('object');
    expect(r.finishReason.unified).toBe('stop');
    expect(r.content[0].type).toBe('text');
  });

  it('full toolCallingMock doStream: the finish part carries finishReason.unified === "stop"', async () => {
    const { stream } = await fullModel.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    const finishPart = (await drain(stream)).find((p) => p.type === 'finish');
    expect(finishPart).toBeTruthy();
    expect(typeof finishPart.finishReason).toBe('object');
    expect(finishPart.finishReason.unified).toBe('stop');
  });

  // Guards the OTHER half of the same v4 migration, which is what made the finish-reason half easy to
  // miss: usage counts are nested in v7 and a flat `{inputTokens: 1}` reads as undefined, so a spend
  // ceiling would price the run at zero.
  it('both templates report v4 nested usage (usage.inputTokens.total), not a flat count', async () => {
    for (const m of [minimalModel, fullModel]) {
      const r = await m.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
      expect(typeof r.usage.inputTokens).toBe('object');
      expect(r.usage.inputTokens.total).toBe(1);
      expect(r.usage.outputTokens.total).toBe(1);
      expect(m.specificationVersion).toBe('v4');
    }
  });
});

// ── B2: the consequence, read back through the SDK's own result ─────────────
describe('the full template model driven through ai\'s generateText', () => {
  // The SDK's OWN reading of the finish reason, which discriminates on the version installed here.
  //
  // The tool-execution consequence only appears from ai@7.0.70, so a test that asserts "the tool
  // fired" proves nothing at 7.0.66 — it passes with a bare string too. But the SDK surfaces what it
  // read: `result.finishReason` is derived from `finishReason.unified`, so a bare string leaves it
  // UNDEFINED right now. Measured against the installed 7.0.66, with no gnl code in the path:
  //
  //   bare string    fired=1 text="done" finishReason=undefined
  //   {unified,raw}  fired=1 text="done" finishReason="stop"
  //
  // That is the same defect the loop starts enforcing at 7.0.70, observed one layer earlier. It also
  // means a scaffolded project's `POST /agents/:name/run` answers `finishReason: undefined` today —
  // the field @gnldev/server added specifically so an empty answer could be told apart from a silent
  // model.
  it('reports finishReason "stop" — a bare string leaves it undefined on this very version', async () => {
    let fired = 0;
    const res = await generateText({
      model: fullModel,
      prompt: 'charge order-1',
      stopWhen: stepCountIs(4),
      tools: {
        chargeOrder: tool({
          description: 'Charge a customer order',
          inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
          execute: async ({ orderId, amount }) => { fired++; return { charged: amount, orderId }; },
        }),
      },
    });

    expect(res.finishReason, 'the SDK could not read the finish reason the model reported').toBe('stop');
    // The step that emitted the tool call must report the reason that MEANS "a tool call is pending".
    expect(res.steps[0]?.finishReason, 'the tool-calling turn reported no finish reason').toBe('tool-calls');
    // And the consequence the 7.0.70 loop enforces, kept for when `ai` is bumped past it.
    expect(fired, 'the template that exists to demonstrate exactly-once side effects performed none').toBe(1);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('the minimal template reports finishReason "stop" through the SDK too', async () => {
    const res = await generateText({ model: minimalModel, prompt: 'hi' });
    expect(res.finishReason, 'the SDK could not read the finish reason the model reported').toBe('stop');
    expect(res.text).toBe('echo: hi');
  });

  // Records the version the assertions above were made against. The finishReason assertion
  // discriminates from 7.0.0; the `fired` assertion only from 7.0.70. Fails loudly if `ai` ever leaves
  // the 7.x line the templates' peer range (`^7.0.0`) promises.
  it('records the installed ai version', () => {
    expect(aiVersion).toMatch(/^7\./);
    // eslint-disable-next-line no-console
    console.log(`[template-finish-reason] installed ai version: ${aiVersion}`);
  });
});
