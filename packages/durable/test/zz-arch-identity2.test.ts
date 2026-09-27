import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage, BasicMemory } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { stepCountIs } from 'ai';

const embed = async () => [1, 0, 0];
async function kb() {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'ayse-invoice', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'mehmet-invoice', text: 'MEHMET invoice', owner: 'mehmet' },
  ]);
  return store;
}

describe('zz-arch identity channel 2', () => {
  it('S6 runNetwork(ayse) -> sub-agent rag tool narrows', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    let r = 0;
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { a: { model: createMockModel(async ({ prompt }: any) => {
        if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
        seen = JSON.stringify(prompt); return finalTextResult('alt');
      }), tools: { kb: rag }, maxSteps: 4 } },
      networks: { n: { router: createMockModel(async () => finalTextResult(r++ === 0 ? JSON.stringify({ action: 'route', agent: 'a', task: 'find' }) : JSON.stringify({ action: 'final', answer: 'ok' }))), agents: ['a'] } },
    } as never);
    await gnl.runNetwork('n', { runId: 'nw-s6', task: 'x', resourceId: 'ayse' } as never);
    console.log('S6 network sub-agent sees MEHMET?', seen.includes('MEHMET invoice'), 'sees AYSE?', seen.includes('AYSE invoice'));
    expect(seen).toContain('AYSE invoice');
    expect(seen).not.toContain('MEHMET invoice');
  });

  it('S7 engine-level thread window: mallory on ayse thread via runDurable directly', async () => {
    const journal = new InMemoryJournal();
    let runs = 0;
    const t = { idempotencyWindow: 'thread', sideEffect: true, recover: async () => ({ done: false }), execute: async ({ q }: any, o: any) => { runs++; return { q, secretFor: o?.resourceId }; } };
    const mk = () => createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('t', 'c1', { q: 'pin' });
      const s = JSON.stringify(prompt);
      return finalTextResult(s.includes('secretFor') ? (s.match(/secretFor[^,}]*/)?.[0] ?? 'x') : 'none');
    });
    await runDurable({ runId: 'ra', journal, model: mk(), tools: { t }, prompt: 'x', threadId: 'th1', resourceId: 'ayse', stopWhen: stepCountIs(4) } as never);
    let res: any; let err: any;
    try { res = await runDurable({ runId: 'rm', journal, model: mk(), tools: { t }, prompt: 'x', threadId: 'th1', resourceId: 'mallory', stopWhen: stepCountIs(4) } as never); } catch (e) { err = e; }
    console.log('S7 mallory text=', res?.text, '| err=', err?.name, '| executions=', runs);
    expect(res?.text ?? '').not.toContain('ayse');
  });

  it('S8 resume of ayse run by mallory through createGnl (approval)', async () => {
    const storage = new InMemoryStorage();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
      seen = JSON.stringify(prompt); return finalTextResult('done');
    });
    const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model, tools: { kb: rag }, guard: async () => ({ action: 'require-approval' }), maxSteps: 4 } } } as never);
    const r1: any = await gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'ayse' } as never);
    let err: any;
    let r2: any; try { r2 = await gnl.run('a', { runId: 'r-s8', prompt: 'x', resourceId: 'mallory', approvals: { c1: true } } as never); } catch (e) { err = e; }
    console.log('S8 r1 interrupts', JSON.stringify(r1.interrupts), 'r2', JSON.stringify({ text: r2?.text, i: r2?.interrupts }), 'input', JSON.stringify(await storage.runs.get('r-s8:input' as never)));
    console.log('S8 seen tail', seen.slice(-500));
    console.log('S8 first interrupts=', (r1.interrupts ?? []).length, '| mallory resume err=', err?.name ?? 'none', '| sees AYSE?', seen.includes('AYSE invoice'), 'sees MEHMET?', seen.includes('MEHMET invoice'));
    expect(err ?? (seen.includes('AYSE invoice') ? null : 'ok')).toBeTruthy();
  });
});
