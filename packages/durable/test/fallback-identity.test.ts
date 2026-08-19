// A fallback chain must not lie about who served the call, and must hand each candidate the tool
// schema THAT candidate needs.
//
// `withModelFallback` copied `provider` / `modelId` / `supportedUrls` off candidates[0] once and never
// updated them, and run.ts shaped the tools once, before the call, keyed off that stale identity. So
// with ['anthropic/claude-x','openai/gpt-4o'] where anthropic fails: OpenAI served the call, the proxy
// still answered `anthropic`, and OpenAI was sent a schema built for anthropic — `openaiStrict`
// skipped, and a Zod `.url()` (`format: 'uri'`) reaching the provider that rejects it.
//
// Applying every candidate's rules in turn does NOT work, and trying three providers instead of two is
// what showed it. The requirements genuinely contradict: `openaiStrict` SETS
// `additionalProperties: false` (its strict mode requires it) and the gemini rule DELETES it (Gemini
// rejects the keyword). Composing them leaves whichever ran last in place:
//
//   chain [gemini, openai] → gemini was handed `additionalProperties: false`
//   chain [openai, gemini] → OpenAI was handed no `additionalProperties` at all
//
// There is no single shape for such a chain — so the shaping moved to where the candidate is KNOWN.
// It looked impossible because the AI SDK converts the tools before the call; it is not, because what
// `doGenerate` receives is `[{ type, name, description, inputSchema }]` with `inputSchema` a plain
// JSON Schema, which is exactly what these rules take and return. Each candidate is now shaped for
// inside the retry loop, at the moment it is chosen, including on the very first failover.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { withModelFallback, setChainToolShaper } from '../src/model-router.js';
import { runDurable } from '../src/run.js';
import { gnlTool } from '../src/types.js';
import { stepCountIs } from 'ai';

/** A model that either fails or answers, recording the tool schema it was handed. */
function mkModel(provider: string, modelId: string, opts: { fail?: boolean; seen?: (s: any) => void } = {}): any {
  return {
    specificationVersion: 'v2', provider, modelId, supportedUrls: {},
    doGenerate: async (o: any) => {
      if (opts.fail) throw new Error(`${provider} is down`);
      opts.seen?.(o.tools?.[0]?.inputSchema ?? null);
      return {
        content: [{ type: 'text', text: 'ok' }], finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [], response: { modelId },
      };
    },
    doStream: async () => { throw new Error('generate-only'); },
  };
}

/** `note` is OPTIONAL and `url` is a URL — the two properties the providers treat differently. */
const mixedTool = () => gnlTool({
  description: 'fetch a url',
  inputSchema: z.object({ url: z.string().url(), note: z.string().optional() }),
  execute: async () => ({ ok: true }),
} as never);

/** The schema a LONE model of this provider is sent — the reference each chain case must match. */
async function schemaFor(provider: string, modelId: string): Promise<any> {
  let seen: any;
  const journal = new InMemoryJournal();
  await runDurable({
    runId: `ref-${provider}`, journal, model: mkModel(provider, modelId, { seen: (s) => { seen = s; } }),
    tools: { fetchIt: mixedTool() }, prompt: 'go', schemaCompat: true, stopWhen: stepCountIs(3),
  } as never);
  return seen;
}

/** Runs a two-candidate chain where the first fails, and returns what the second was sent. */
async function afterFailover(runId: string, dead: [string, string], live: [string, string]): Promise<any> {
  let seen: any;
  const journal = new InMemoryJournal();
  await runDurable({
    runId, journal, tools: { fetchIt: mixedTool() }, prompt: 'go',
    schemaCompat: true, stopWhen: stepCountIs(3),
    model: withModelFallback([
      { spec: `${dead[0]}/${dead[1]}`, model: mkModel(dead[0], dead[1], { fail: true }) },
      { spec: `${live[0]}/${live[1]}`, model: mkModel(live[0], live[1], { seen: (s) => { seen = s; } }) },
    ], journal, runId),
  } as never);
  return seen;
}

describe('a fallback chain\'s identity', () => {
  it('names the candidate that actually served, not the one that failed', async () => {
    const journal = new InMemoryJournal();
    const proxy = withModelFallback([
      { spec: 'anthropic/claude-x', model: mkModel('anthropic', 'claude-x', { fail: true }) },
      { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o') },
    ], journal, 'id-1');

    expect(proxy.provider, 'before any call the first candidate is the only sensible answer').toBe('anthropic');
    await proxy.doGenerate({});

    expect(proxy.provider, 'the proxy still named the candidate that failed').toBe('openai');
    expect(proxy.modelId).toBe('gpt-4o');
  });

  it('keeps naming the winner once the choice is frozen', async () => {
    const journal = new InMemoryJournal();
    const make = () => withModelFallback([
      { spec: 'anthropic/claude-x', model: mkModel('anthropic', 'claude-x', { fail: true }) },
      { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o') },
    ], journal, 'id-2');

    await make().doGenerate({});
    const fresh = make(); // a new process, reading the frozen choice back from the journal
    await fresh.doGenerate({});
    expect(fresh.provider).toBe('openai');
  });

  it('a single-candidate chain is the raw model', async () => {
    const only = mkModel('openai', 'gpt-4o');
    const proxy = withModelFallback([{ spec: 'openai/gpt-4o', model: only }], new InMemoryJournal(), 'id-3');
    expect(proxy).toBe(only);
    expect(setChainToolShaper(proxy, (t) => t), 'a lone model must not accept a chain shaper').toBe(false);
  });

  it('a plain model is not mistaken for a chain', () => {
    expect(setChainToolShaper(mkModel('openai', 'gpt-4o'), (t) => t)).toBe(false);
    expect(setChainToolShaper(undefined, (t) => t)).toBe(false);
    expect(setChainToolShaper({}, (t) => t)).toBe(false);
  });
});

describe('tool-schema compat across a mixed chain', () => {
  it('shapes for OpenAI when OpenAI takes over from Gemini — on the FIRST run', async () => {
    // The case the old design could not reach at all. Nothing is frozen yet, so the tools were built
    // for the first candidate and handed to whoever answered. `openaiStrict` makes every property
    // required and sets additionalProperties:false; the gemini rule does the opposite.
    const seen = await afterFailover('mix-1', ['google', 'gemini-2'], ['openai', 'gpt-4o']);
    expect(seen, 'OpenAI was handed no schema').toBeTruthy();
    expect(seen).toEqual(await schemaFor('openai', 'gpt-4o'));
    expect(seen.required).toEqual(['url', 'note']);
    expect(seen.additionalProperties).toBe(false);
  });

  it('shapes for Gemini when Gemini takes over from OpenAI — the same run, mirrored', async () => {
    // The direction that proves it is per-candidate rather than "always apply OpenAI's rules". Gemini
    // must NOT receive additionalProperties, and `note` must stay optional.
    const seen = await afterFailover('mix-2', ['openai', 'gpt-4o'], ['google', 'gemini-2']);
    expect(seen).toEqual(await schemaFor('google', 'gemini-2'));
    expect(seen.required).toEqual(['url']);
    expect(seen.additionalProperties).toBeUndefined();
  });

  it('shapes for Anthropic when Anthropic takes over', async () => {
    const seen = await afterFailover('mix-3', ['openai', 'gpt-4o'], ['anthropic', 'claude-x']);
    expect(seen).toEqual(await schemaFor('anthropic', 'claude-x'));
  });

  it('leaves a run without schemaCompat alone', async () => {
    // The transform is opt-in and the shaper must not be installed without it — a chain that never
    // asked for compat should send exactly what the SDK produced.
    let withCompat: any;
    let without: any;
    const j1 = new InMemoryJournal();
    await runDurable({
      runId: 'off-1', journal: j1, tools: { fetchIt: mixedTool() }, prompt: 'go', stopWhen: stepCountIs(3),
      model: withModelFallback([
        { spec: 'a/x', model: mkModel('openai', 'gpt-4o', { fail: true }) },
        { spec: 'b/y', model: mkModel('openai', 'gpt-4o', { seen: (s) => { without = s; } }) },
      ], j1, 'off-1'),
    } as never);
    withCompat = await schemaFor('openai', 'gpt-4o');

    // `additionalProperties: false` is what zod's own conversion emits, so it proves nothing either
    // way — the first version of this assertion used it and failed for that reason. What compat
    // actually does to this schema is move `format: 'uri'` into the description and make every
    // property required.
    expect(JSON.stringify(without), 'compat ran on a run that did not ask for it').toContain('"format":"uri"');
    expect(without.required, 'compat made an optional field required without being asked').toEqual(['url']);
    expect(JSON.stringify(withCompat), 'the reference should have compat applied').not.toContain('"format":"uri"');
  });
});
