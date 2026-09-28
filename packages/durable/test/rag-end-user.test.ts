// A knowledge base answers an end user from two shelves: the organization's general documents, and
// that user's own. Never a third person's, and never a document nobody labelled — an unlabelled
// document is a forgotten label, and a forgotten label must read as "not found", not as "everyone's".
//
// Staff (said out loud: `caller: STAFF`) keep the unrestricted view. A run that names nobody is
// `unknown` (candidate B) and reads the general shelf only — closed, not open.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { STAFF } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];

async function kb() {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'handbook', text: 'GENERAL handbook', shared: true },
    { id: 'ayse-invoice', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'mehmet-invoice', text: 'MEHMET invoice', owner: 'mehmet' },
    { id: 'untagged', text: 'UNTAGGED note' },
  ]);
  return store;
}

async function search(resourceId: string | undefined, staff = false): Promise<string> {
  const journal = new InMemoryJournal();
  const tool = createRagTool({ store: await kb(), embed, topK: 10 });
  let seen = '';
  const model = createMockModel(async ({ prompt }: any) => {
    if (countToolResults(prompt) === 0) return toolCallResult('searchKnowledge', 'c1', { query: 'invoice' });
    seen = JSON.stringify(prompt);
    return finalTextResult('done');
  });
  await runDurable({
    runId: `r-${resourceId ?? 'staff'}`, journal, model, tools: { searchKnowledge: tool },
    prompt: 'find my invoices', stopWhen: stepCountIs(4), ...(resourceId ? { resourceId } : {}), ...(staff ? { caller: STAFF } : {}),
  });
  return seen;
}

describe('a knowledge base searched on behalf of an end user', () => {
  it('finds the general documents and the user\'s own, nothing else', async () => {
    const seen = await search('mehmet');
    expect(seen).toContain('GENERAL handbook');
    expect(seen).toContain('MEHMET invoice');
    expect(seen).not.toContain('AYSE invoice');
    expect(seen, 'an unlabelled document is not everyone\'s').not.toContain('UNTAGGED note');
  });

  it('the other user gets the mirror image', async () => {
    const seen = await search('ayse');
    expect(seen).toContain('AYSE invoice');
    expect(seen).not.toContain('MEHMET invoice');
  });

  it('a run that names nobody (unknown) reads the general shelf only', async () => {
    const seen = await search(undefined);
    expect(seen).toContain('GENERAL handbook');
    for (const t of ['AYSE invoice', 'MEHMET invoice', 'UNTAGGED note']) expect(seen).not.toContain(t);
  });

  it('a staff run keeps the whole shelf', async () => {
    const seen = await search(undefined, true);
    for (const t of ['GENERAL handbook', 'AYSE invoice', 'MEHMET invoice', 'UNTAGGED note']) expect(seen).toContain(t);
  });
});
