// A host's own model provider, by prefix (model-router).
//
// Four built-in packages used to be the whole world, and that made the same string mean two
// different things depending on where it was typed. An app wired to an OpenAI-compatible endpoint
// could resolve `nvidia/…` in the lab — which already had a resolver hook — and could not resolve
// it anywhere near an agent run, which goes through the router. Reported from the Playground: the
// agent's own model reads as "custom", and no string a user can type reproduces it.
import { describe, it, expect } from 'vitest';
import { resolveModel, registerModelProvider, knownModelProviders } from '../src/index.js';

describe('a host provider', () => {
  it('makes the prefix resolve like any built-in', async () => {
    const marker = { id: 'stepfun' };
    const off = registerModelProvider('nvidia', (modelId) => ({ ...marker, modelId }));
    try {
      expect(await resolveModel('nvidia/stepfun-ai/step-3.7-flash')).toEqual({
        id: 'stepfun', modelId: 'stepfun-ai/step-3.7-flash',
      });
    } finally {
      off();
    }
  });

  it('is removable, so one test cannot explain another test\'s failure', async () => {
    const off = registerModelProvider('gateway', () => ({}));
    expect(knownModelProviders()).toContain('gateway');
    off();
    expect(knownModelProviders()).not.toContain('gateway');
  });

  it('refuses to shadow a built-in', () => {
    // Silently taking over 'openai' would make every other model string in the process mean
    // something the person reading it cannot see.
    expect(() => registerModelProvider('openai', () => ({}))).toThrow(/built-in/);
  });

  it('refuses a prefix that is not one', () => {
    expect(() => registerModelProvider('', () => ({}))).toThrow(/usable prefix/);
    expect(() => registerModelProvider('a/b', () => ({}))).toThrow(/usable prefix/);
  });
});

describe('the error when nothing matches', () => {
  it('lists what IS known and says how to add one', async () => {
    // The old message named four providers and stopped there, so a user whose string worked on one
    // screen and failed on another had nothing to go on.
    await expect(resolveModel('nope/x')).rejects.toThrow(/Known: openai, anthropic, google, mistral/);
    await expect(resolveModel('nope/x')).rejects.toThrow(/registerModelProvider/);
  });

  it('still refuses a spec with no provider at all', async () => {
    await expect(resolveModel('bare-model')).rejects.toThrow(/expected 'provider\/model'/);
  });
});
