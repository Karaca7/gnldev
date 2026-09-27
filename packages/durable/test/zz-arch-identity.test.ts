// zz-arch probes: does the caller's identity reach tools and child runs on every path?
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { stepCountIs } from 'ai';
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { createBatch } from '../src/batch.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];
async function kb() {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'handbook', text: 'GENERAL handbook', shared: true },
    { id: 'ayse-invoice', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'mehmet-invoice', text: 'MEHMET invoice', owner: 'mehmet' },
  ]);
  return store;
}
const texts = (hits: any) => JSON.stringify(hits);

describe('zz-arch identity channel', () => {
  it('S0 control: runDurable(resourceId) -> rag tool narrows', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
      seen = JSON.stringify(prompt); return finalTextResult('done');
    });
    await runDurable({ runId: 'r0', journal: new InMemoryJournal(), model, tools: { kb: rag }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' } as never);
    console.log('S0 sees MEHMET?', seen.includes('MEHMET invoice'));
    expect(seen).not.toContain('MEHMET invoice');
  });

  it('S1 workflow step (run as ayse) invoking a rag tool', async () => {
    const journal = new InMemoryJournal();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let ctxKeys: string[] = []; let out = '';
    const wf = workflow<any>().then(step('lookup', async (_i: any, ctx: StepCtx) => {
      ctxKeys = Object.keys(ctx);
      // The step author has nothing in ctx to forward; forwards what the ctx carries.
      out = texts(await (rag.execute as any)({ query: 'invoice' }, { toolCallId: 's', ...(ctx as any).resourceId ? { resourceId: (ctx as any).resourceId } : {} }));
      return { ok: true };
    }));
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-s1', resourceId: 'ayse', actor: 'ayse' } as never);
    console.log('S1 StepCtx keys:', ctxKeys.join(','), '| sees MEHMET?', out.includes('MEHMET invoice'));
    expect(out, 'ayse workflow must not see mehmet').not.toContain('MEHMET invoice');
  });

  it('S2 agent-as-workflow-step (documented pattern) run as ayse', async () => {
    const journal = new InMemoryJournal();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let seen = '';
    const wf = workflow<any>().then(step('agent', async (_i: any, ctx: StepCtx) => {
      const model = createMockModel(async ({ prompt }: any) => {
        if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
        seen = JSON.stringify(prompt); return finalTextResult('done');
      });
      await runDurable({ runId: `${ctx.runId}:agent`, journal: ctx.journal as never, model, tools: { kb: rag }, prompt: 'x', stopWhen: stepCountIs(4),
        ...((ctx as any).resourceId ? { resourceId: (ctx as any).resourceId } : {}) } as never);
      return { ok: true };
    }));
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-s2', resourceId: 'ayse', actor: 'ayse' } as never);
    console.log('S2 child agent sees MEHMET?', seen.includes('MEHMET invoice'), '| child :input =', JSON.stringify(await journal.get('wf-s2:agent:input')));
    expect(seen).not.toContain('MEHMET invoice');
  });

  it('S3 withIdempotency (cross-run default): mallory names ayse order', async () => {
    const journal = new InMemoryJournal();
    let runs = 0;
    const tools = withIdempotency({
      address: tool({ description: 'd', inputSchema: z.object({ orderId: z.string() }), execute: async ({ orderId }, o: any) => { runs++; return { orderId, address: `addr-of-${o?.resourceId ?? 'nobody'}` }; } }),
    }, { journal } as never);
    const a = await (tools.address.execute as any)({ orderId: 'o1' }, { toolCallId: 'a', resourceId: 'ayse' });
    let b: any; let err: any;
    try { b = await (tools.address.execute as any)({ orderId: 'o1' }, { toolCallId: 'b', resourceId: 'mallory' }); } catch (e) { err = e; }
    console.log('S3 ayse=', JSON.stringify(a), '| mallory=', JSON.stringify(b), '| err=', err?.name, '| executions=', runs, '| owner rec=', JSON.stringify(await journal.get([...(await (journal as any).listKeys('xrun:'))].find((k: string) => k.startsWith('xrun:owner'))!)));
    expect(b, 'mallory must not get ayse result').toBeUndefined();
  });

  it('S4 batch with resourceId -> tool receives it', async () => {
    const journal = new InMemoryJournal();
    const got: any[] = [];
    const t = Object.assign(tool({ description: 'd', inputSchema: z.object({ id: z.string() }), execute: async (i: any, o: any) => { got.push(o?.resourceId); return { ok: i.id }; } }), { idempotent: true });
    const b = createBatch(journal as never, { tool: t, toolName: 'echo', itemKey: (i: any) => i.id, resourceId: 'ayse', onDuplicate: 'skip' } as never);
    const plan = await b.preflight('b1', [{ id: 'x' }]);
    await b.run('b1', [{ id: 'x' }], { planToken: plan.token });
    console.log('S4 tool saw resourceId =', got);
    expect(got).toEqual(['ayse']);
  });

  it('S5 tool composing another tool by hand inside an ayse run', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let inner = '';
    const outer = Object.assign(tool({ description: 'd', inputSchema: z.object({ q: z.string() }), execute: async ({ q }: any, o: any) => {
      inner = texts(await (rag.execute as any)({ query: q }, { toolCallId: o.toolCallId })); // forgets resourceId
      return 'ok';
    } }), { idempotent: true });
    const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('outer', 'c1', { q: 'invoice' }) : finalTextResult('done'));
    await runDurable({ runId: 'r5', journal: new InMemoryJournal(), model, tools: { outer }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' } as never);
    console.log('S5 inner rag sees MEHMET?', inner.includes('MEHMET invoice'));
    expect(inner).not.toContain('MEHMET invoice');
  });
});
