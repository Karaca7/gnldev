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
// Two fixes, because reporting the truth afterwards cannot repair the tools:
//
//   - the identity fields became getters over the candidate that is actually serving;
//   - the frozen choice is resolved BEFORE compat runs, so a chain that has already picked a winner
//     shapes its tools for that winner instead of for candidate[0].
//
// Applying every candidate's rules in turn was tried first and is WRONG: the providers genuinely
// contradict each other. `openaiStrict` SETS `additionalProperties: false` (its strict mode requires
// it) and the gemini rule DELETES it (Gemini rejects the keyword), so composing them leaves whichever
// ran last in place and hands the other exactly what its own rule exists to prevent. Measured:
//
//   chain [gemini, openai] → gemini was handed `additionalProperties: false`
//   chain [openai, gemini] → OpenAI was handed no `additionalProperties` at all
//
// There is no one schema for such a chain, so the framework shapes for the model that will serve and
// says so out loud when the chain cannot be satisfied at once.
import { describe, it, expect, vi } from 'vitest';
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

describe('tool-schema compat and a fallback chain', () => {
  /** The schema a lone model of this provider would be sent — the reference to match. */
  async function schemaFor(provider: string, modelId: string): Promise<any> {
    let seen: any;
    const journal = new InMemoryJournal();
    await runDurable({
      runId: `ref-${provider}`, journal, model: mkModel(provider, modelId, { seen: (s) => { seen = s; } }),
      tools: { fetchIt: mixedTool() }, prompt: 'go', schemaCompat: true, stopWhen: stepCountIs(3),
    } as never);
    return seen;
  }

  it('a chain that has already frozen its winner shapes tools for THAT model', async () => {
    // The steady state: after the first success the choice lives in the journal, so this is what
    // every resume and every later run does. Before the fix the frozen winner was not read until
    // doGenerate — after run.ts had already built the tools — so compat always saw candidate[0].
    let seen: any;
    const journal = new InMemoryJournal();
    await journal.put('frozen-1:cfg:model', { spec: 'openai/gpt-4o' });

    await runDurable({
      runId: 'frozen-1', journal, tools: { fetchIt: mixedTool() }, prompt: 'go',
      schemaCompat: true, stopWhen: stepCountIs(3),
      model: withModelFallback([
        { spec: 'anthropic/claude-x', model: mkModel('anthropic', 'claude-x') },
        { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o', { seen: (s) => { seen = s; } }) },
      ], journal, 'frozen-1'),
    } as never);

    // Compared against what a LONE openai model would have been sent, so the assertion is "the chain
    // shaped for its winner" rather than a hand-copied schema that drifts when the rules change.
    const reference = await schemaFor('openai', 'gpt-4o');
    expect(seen, 'the frozen winner got tools shaped for a different candidate').toEqual(reference);
    // Named explicitly too, so a reader can see WHAT differs: anthropic leaves `note` optional.
    expect(seen.required).toEqual(['url', 'note']);
  });

  it('warns when the chain contains providers whose rules contradict', async () => {
    // openaiStrict sets `additionalProperties: false`; gemini deletes it. Nothing can satisfy both,
    // and the tools are converted once, before the call — so the fallback WILL receive a schema its
    // own rule exists to prevent. Saying that once is the only honest option available.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      await runDurable({
        runId: 'clash-1', journal, tools: { fetchIt: mixedTool() }, prompt: 'go',
        schemaCompat: true, stopWhen: stepCountIs(3),
        model: withModelFallback([
          { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o') },
          { spec: 'google/gemini-2', model: mkModel('google', 'gemini-2') },
        ], journal, 'clash-1'),
      } as never);

      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said, 'a chain that cannot be satisfied at once said nothing').toContain('schema rules disagree');
      expect(said, 'the warning must name the candidate that will be sent the wrong shape').toContain('google/gemini-2');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when the chain\'s providers agree', async () => {
    // groq is served by openaiStrict too (its own API is OpenAI-compatible), so this chain has one
    // contract and nothing to report. A warning here would be noise on a perfectly good setup.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      await runDurable({
        runId: 'agree-1', journal, tools: { fetchIt: mixedTool() }, prompt: 'go',
        schemaCompat: true, stopWhen: stepCountIs(3),
        model: withModelFallback([
          { spec: 'openai/gpt-4o', model: mkModel('openai', 'gpt-4o') },
          { spec: 'groq/llama-3', model: mkModel('groq', 'llama-3') },
        ], journal, 'agree-1'),
      } as never);

      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said, 'a chain whose rules agree was warned about anyway').not.toContain('schema rules disagree');
    } finally {
      warn.mockRestore();
    }
  });

  it('a single model is never warned about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      await runDurable({
        runId: 'solo-1', journal, tools: { fetchIt: mixedTool() }, prompt: 'go',
        schemaCompat: true, stopWhen: stepCountIs(3),
        model: mkModel('openai', 'gpt-4o'),
      } as never);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('schema rules disagree');
    } finally {
      warn.mockRestore();
    }
  });
});
