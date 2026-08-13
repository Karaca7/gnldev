// `ModelInput` is `LanguageModelV2 | string`, and runDurable advertises it. Until this test existed
// only createGnl honoured the string half: a caller who followed the published type and wrote
// `runDurable({ model: 'nvidia/…' })` got past the compiler and then died inside the AI SDK with
// "model.doGenerate is not a function" — an error that names nothing the caller controls.
//
// Found by installing the packed tarballs into a project outside the workspace and using them the
// way the README describes, which is a thing no test in this suite had been doing.
import { describe, it, expect } from 'vitest';
import { runDurable, registerModelProvider, InMemoryStorage } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function scriptedModel(text: string) {
  return {
    specificationVersion: 'v2',
    provider: 'trial',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => {
      throw new Error('generate-only');
    },
  } as any;
}

describe('runDurable accepts the string half of ModelInput', () => {
  it('resolves a registered provider prefix instead of handing the string to the AI SDK', async () => {
    const off = registerModelProvider('trialprov', (modelId: string) => scriptedModel(`hello from ${modelId}`));
    try {
      const res = await runDurable({
        runId: 'string-model-1',
        journal: new InMemoryStorage().runs,
        model: 'trialprov/some-model',
        prompt: 'hi',
      });
      expect(res.text).toBe('hello from some-model');
    } finally {
      off();
    }
  });

  it('reports an unknown prefix in terms of the spec the caller wrote', async () => {
    await expect(
      runDurable({
        runId: 'string-model-2',
        journal: new InMemoryStorage().runs,
        model: 'nosuchprovider/x',
        prompt: 'hi',
      }),
    ).rejects.toThrow(/Unknown provider 'nosuchprovider'/);
  });

  it('still takes a model object, unchanged', async () => {
    const res = await runDurable({
      runId: 'string-model-3',
      journal: new InMemoryStorage().runs,
      model: scriptedModel('object path'),
      prompt: 'hi',
    });
    expect(res.text).toBe('object path');
  });
});
