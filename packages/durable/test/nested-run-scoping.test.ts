// A sub-agent gets its own runId, and that id has to name its PARENT.
//
// `agent:${toolCallId}` did not. A toolCallId is unique within one completion, not across runs, so
// two unrelated parents whose provider happened to mint the same id shared a single nested run — and
// the second parent read the first one's answer as its own, from the journal, without the sub-agent
// running at all.
//
// The rest of the codebase already knew this: network.ts keys on `net:${runId}:${i}`, and a2a keys
// on the idempotencyKey precisely because it carries the parent. This aligns the last two sites.
//
// Honest bound: mainstream providers mint random ids, so this is a latent hazard rather than a
// routine one — it bites on OSS endpoints, proxies, replayed fixtures, and any test harness that
// hands out stable ids. Which is to say: it bites where it is hardest to notice.
import { describe, it, expect } from 'vitest';
import { runDurable, createAgentTool, InMemoryStorage } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Every completion returns the SAME toolCallId — a proxy or a fixture-backed endpoint. */
function parentModel(answerFor: string) {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'parent', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0)
        return { content: [{ type: 'tool-call', toolCallId: 'stable-id', toolName: 'ask', input: JSON.stringify({ task: answerFor }) }], finishReason: 'tool-calls', usage, warnings: [] };
      const last = (prompt ?? []).filter((m: any) => m.role === 'tool').at(-1);
      const text = JSON.stringify(last?.content?.[0]?.output ?? '');
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('generate-only'); },
  } as any;
}

/** The sub-agent answers with whatever it was asked, so a leaked answer is visible. */
function subModel() {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'sub', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const asked = JSON.stringify(prompt).includes('acme') ? 'acme-answer' : 'globex-answer';
      return { content: [{ type: 'text', text: asked }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('generate-only'); },
  } as any;
}

describe('a nested run is scoped to its parent', () => {
  it('two runs whose provider reuses one toolCallId do not share a sub-agent run', async () => {
    const journal = new InMemoryStorage().runs;
    const ask = createAgentTool({ journal, model: subModel() } as any);

    const a = await runDurable({
      runId: 'tenant-a', journal, model: parentModel('acme'), tools: { ask } as any, prompt: 'ask',
    });
    const b = await runDurable({
      runId: 'tenant-b', journal, model: parentModel('globex'), tools: { ask } as any, prompt: 'ask',
    });

    expect(a.text).toContain('acme');
    // Before this was scoped, tenant-b replayed tenant-a's nested run and answered 'acme-answer'.
    expect(b.text, "tenant-b must not receive tenant-a's sub-agent answer").toContain('globex');
  });

  it('the same run replays its own sub-agent rather than re-running it', async () => {
    const journal = new InMemoryStorage().runs;
    let subCalls = 0;
    const base = subModel();
    const counting = { ...base, doGenerate: async (o: any) => { subCalls++; return base.doGenerate(o); } };
    const ask = createAgentTool({ journal, model: counting } as any);

    const opts = { runId: 'same-run', journal, model: parentModel('acme'), tools: { ask } as any, prompt: 'ask' };
    const first = await runDurable(opts);
    const again = await runDurable(opts);

    expect(again.text).toEqual(first.text);
    expect(subCalls, 'the resume replays the nested run from the journal').toBe(1);
  });
});
