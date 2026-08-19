// A fallback chain must not lie about who served the call, and must not prepare tools for the wrong one.
//
// `withModelFallback` copied `provider` / `modelId` / `supportedUrls` off candidates[0] once and never
// updated them. Measured with ['anthropic/claude-x', 'openai/gpt-4o'] where anthropic fails:
//
//   before the call  provider = anthropic
//   served by        openai
//   after the call   provider = anthropic      <- still
//
// That is wrong for anything that asks the model who it is, and it is worse than cosmetic for
// tool-schema compat. run.ts applies compat ONCE per run, before the first model call, and
// @gnldev/tool-schema selects rules by `model.provider` / `model.modelId`. So the chain above applied
// anthropic's rules and then let OpenAI answer: `openaiStrict` never ran, and a Zod `.url()` — which
// becomes `format: 'uri'` — reached OpenAI, which is precisely the silent rejection that rule exists to
// prevent. The more providers a chain mixes, the more this bites.
//
// Two separate fixes, because reporting the truth afterwards cannot repair the tools:
//
//   - the identity fields became getters over the candidate that is actually serving;
//   - compat is applied for EVERY candidate in the chain, not for the proxy's identity.
//
// The second is a deliberate widening: the tools a chain sends must satisfy whichever candidate
// answers, and nothing can be deferred until the winner is known because the AI SDK converts the tools
// before the call. Rules are selected per model by `shouldApply`, so applying them in chain order
// composes rather than fighting.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { withModelFallback, fallbackCandidatesOf } from '../src/model-router.js';
import { runDurable } from '../src/run.js';
import { gnlTool } from '../src/types.js';
import { stepCountIs } from 'ai';

/** A model that either fails or answers, recording the tool schema it was handed. */
function mkModel(provider: string, modelId: string, opts: { fail?: boolean; seen?: (s: unknown) => void } = {}): any {
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

/** `note` is OPTIONAL — the one property whose treatment DIFFERS between the two providers. */
const mixedTool = () => gnlTool({
  description: 'fetch a url',
  inputSchema: z.object({ url: z.string().url(), note: z.string().optional() }),
  execute: async () => ({ ok: true }),
} as never);

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
    // The chain freezes on first success and stays frozen for the run and every resume, so this is
    // what the identity reads as for the overwhelming majority of calls.
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

  it('a single-candidate chain is the raw model, with nothing to prepare for', async () => {
    const only = mkModel('openai', 'gpt-4o');
    const proxy = withModelFallback([{ spec: 'openai/gpt-4o', model: only }], new InMemoryJournal(), 'id-3');
    expect(proxy).toBe(only);
    expect(fallbackCandidatesOf(proxy), 'a lone model must not look like a chain').toBeUndefined();
  });

  it('a plain model is not mistaken for a chain', () => {
    expect(fallbackCandidatesOf(mkModel('openai', 'gpt-4o'))).toBeUndefined();
    expect(fallbackCandidatesOf(undefined)).toBeUndefined();
    expect(fallbackCandidatesOf({})).toBeUndefined();
  });
});

describe('tool-schema compat across a mixed chain', () => {
  // The discriminator has to be a property the two rules treat DIFFERENTLY. `format: 'uri'` is not
  // one: anthropic strips it too, so an assertion on it passes whichever identity compat was keyed
  // off — the first version of this test was green against the bug. `openaiStrict` alone rewrites
  // `required` to every property; anthropic leaves an optional field optional.
  it('applies the SERVING provider\'s rules, not the failed candidate\'s', async () => {
    let seen: any;
    const journal = new InMemoryJournal();
    const proxy = withModelFallback([
      { spec: 'anthropic/claude-x', model: mkModel('anthropic', 'claude-x', { fail: true }) },
      { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o', { seen: (s2) => { seen = s2; } }) },
    ], journal, 'compat-1');

    await runDurable({
      runId: 'compat-1', journal, model: proxy, tools: { fetchIt: mixedTool() },
      prompt: 'go', schemaCompat: true, stopWhen: stepCountIs(3),
    } as never);

    expect(seen, 'OpenAI was handed no schema at all').toBeTruthy();
    expect(seen.required, 'OpenAI received a schema shaped for anthropic — openaiStrict never ran')
      .toEqual(['url', 'note']);
    expect(JSON.stringify(seen)).not.toContain('"format"');
  });

  it('a chain presents ONE contract: the strictest of its candidates', async () => {
    // A deliberate consequence, asserted rather than discovered. Nothing can wait until the winner is
    // known — the AI SDK converts the tools before the call — so the choice is between one contract
    // for the chain or a contract that depends on which candidate happened to answer. The second
    // would hand the model different tool definitions on different attempts of the same run, which is
    // the opposite of what this framework is for. The cost is visible here: an optional field is
    // required for every candidate in a chain that contains OpenAI, including the ones that would
    // have accepted it optional.
    let viaChain: any;
    let viaSingle: any;

    const j1 = new InMemoryJournal();
    await runDurable({
      runId: 'compat-2', journal: j1, tools: { fetchIt: mixedTool() }, prompt: 'go',
      schemaCompat: true, stopWhen: stepCountIs(3),
      model: withModelFallback([
        { spec: 'anthropic/claude-x', model: mkModel('anthropic', 'claude-x', { seen: (s2) => { viaChain = s2; } }) },
        { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o') },
      ], j1, 'compat-2'),
    } as never);

    const j2 = new InMemoryJournal();
    await runDurable({
      runId: 'compat-3', journal: j2, tools: { fetchIt: mixedTool() }, prompt: 'go',
      schemaCompat: true, stopWhen: stepCountIs(3),
      model: mkModel('anthropic', 'claude-x', { seen: (s2) => { viaSingle = s2; } }),
    } as never);

    expect(viaSingle.required, 'a lone anthropic model leaves an optional field optional').toEqual(['url']);
    expect(viaChain.required, 'the chain did not adopt its strictest candidate\'s contract').toEqual(['url', 'note']);
  });
});
