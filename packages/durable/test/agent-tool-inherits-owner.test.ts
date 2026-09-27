// A sub-agent built with `createAgentTool` is part of its parent's request: its run belongs to the
// parent's user, and its tools serve that user. The tool is usually built once at startup, so it has
// no `resourceId` of its own — it read only its config, and the child ran as nobody: born ownerless
// (the user could not see it) and searching the knowledge base unfiltered (Ayşe's invoice for Mehmet).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createAgentTool } from '../src/agent-tool.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];

async function delegate(parentResourceId: string | undefined, configResourceId?: string) {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'h', text: 'GENERAL handbook', shared: true },
    { id: 'a', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'm', text: 'MEHMET invoice', owner: 'mehmet' },
  ]);
  const journal = new InMemoryJournal();
  let childSaw = '';
  const childModel = createMockModel(async ({ prompt }: any) => {
    if (countToolResults(prompt) === 0) return toolCallResult('kb', 'k1', { query: 'invoice' });
    childSaw = JSON.stringify(prompt);
    return finalTextResult('child done');
  });
  const expert = createAgentTool({ journal, model: childModel, tools: { kb: createRagTool({ store, embed, topK: 10 }) }, ...(configResourceId ? { resourceId: configResourceId } : {}) } as never);
  const parentModel = createMockModel(async ({ prompt }: any) => {
    if (countToolResults(prompt) === 0) return toolCallResult('expert', 'p1', { task: 'find my invoices' });
    return finalTextResult('parent done');
  });
  await runDurable({ runId: 'rp', journal, model: parentModel, tools: { expert }, prompt: 'x', stopWhen: stepCountIs(4), ...(parentResourceId ? { resourceId: parentResourceId } : {}) } as never);
  const childInput = await journal.get<{ resourceId?: string }>('agent:rp:p1:input');
  return { childSaw, childOwner: childInput?.resourceId };
}

describe('createAgentTool: the child runs as the parent\'s user', () => {
  it('its run is theirs, and its tools serve them', async () => {
    const { childSaw, childOwner } = await delegate('mehmet');
    expect(childOwner).toBe('mehmet');
    expect(childSaw).toContain('MEHMET invoice');
    expect(childSaw).not.toContain('AYSE invoice');
  });

  it('the parent\'s user outranks a static one in the config', async () => {
    const { childOwner } = await delegate('mehmet', 'someone-else');
    expect(childOwner).toBe('mehmet');
  });

  it('a parent with no user leaves the config\'s, as before', async () => {
    expect((await delegate(undefined, 'svc')).childOwner).toBe('svc');
    expect((await delegate(undefined)).childOwner).toBeUndefined();
  });
});
