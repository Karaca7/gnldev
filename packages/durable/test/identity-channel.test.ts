// ADR-0002 point 5: identity reaches tools, workflow steps and child runs through ONE typed channel
// (`options.gnl`, read with `identityOf`; `StepCtx.identity`; `caller: ctx.identity` for a child run),
// sourced from the same value as the owner record, and `unknown` is closed. The old `options.resourceId`
// is gone, and reading it THROWS — a type error alone did not stop a tool from reading it.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { createBatch } from '../src/batch.js';
import { createAgentTool } from '../src/agent-tool.js';
import { identityOf, userIdOf, toolContextFor, runIdentity, user, STAFF, type RunIdentity } from '../src/run-identity.js';
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
const J = (v: unknown) => JSON.stringify(v);
/** A model that calls `name` once, then records what it saw and finishes. */
function callsOnce(name: string, args: unknown, seen: { text: string }) {
  return createMockModel(async ({ prompt }: any) => {
    if (countToolResults(prompt) === 0) return toolCallResult(name, 'c1', args);
    seen.text = J(prompt);
    return finalTextResult('done');
  });
}

describe('workflow steps (R1, R2)', () => {
  it('R1 a step forwards ctx.identity to a tool: the user\'s shelf; a step that forgets is closed', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let fwd = ''; let forgot = '';
    const wf = workflow<any>().then(step('lookup', async (_i: any, ctx: StepCtx) => {
      fwd = J(await rag.execute!({ query: 'invoice' }, { toolCallId: 's', messages: [], gnl: toolContextFor(ctx.identity as RunIdentity) } as never));
      forgot = J(await rag.execute!({ query: 'invoice' }, { toolCallId: 's2', messages: [] }));
      return { ok: true };
    }));
    await createGnl({ journal: new InMemoryJournal(), workflows: { w: wf } } as never).runWorkflow!('w', {}, { runId: 'wf-1', resourceId: 'ayse' } as never);
    expect(fwd).toContain('AYSE invoice');
    expect(fwd).not.toContain('MEHMET invoice');
    expect(forgot).toContain('GENERAL handbook');
    expect(forgot).not.toContain('AYSE invoice');
  });

  it('R1 sibling: a staff workflow\'s step sees staff; a workflow started with no caller sees unknown', async () => {
    const kinds: string[] = [];
    const wf = workflow<any>().then(step('who', async (_i: any, ctx: StepCtx) => { kinds.push(ctx.identity.kind); return 1; }));
    const gnl = createGnl({ journal: new InMemoryJournal(), workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-staff', caller: STAFF } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-nobody' } as never);
    expect(kinds).toEqual(['staff', 'unknown']);
  });

  it('R2 agent-as-workflow-step: runDurable({ caller: ctx.identity }) runs as the user and is born owned', async () => {
    const journal = new InMemoryJournal();
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    const seen = { text: '' };
    const wf = workflow<any>().then(step('agent', async (_i: any, ctx: StepCtx) => {
      await runDurable({ runId: `${ctx.runId}:agent`, journal: ctx.journal as never, model: callsOnce('kb', { query: 'invoice' }, seen), tools: { kb: rag }, prompt: 'x', stopWhen: stepCountIs(4), caller: ctx.identity as RunIdentity });
      return { ok: true };
    }));
    await createGnl({ journal, workflows: { w: wf } } as never).runWorkflow!('w', {}, { runId: 'wf-2', resourceId: 'ayse' } as never);
    expect(seen.text).toContain('AYSE invoice');
    expect(seen.text).not.toContain('MEHMET invoice');
    expect((await journal.get<{ resourceId?: string }>('wf-2:agent:input'))?.resourceId).toBe('ayse');
  });

  it('R2 sibling: the child run records its parent (the step\'s run) and cannot be taken by another user', async () => {
    const journal = new InMemoryJournal();
    let child: RunIdentity | undefined;
    const probe = tool({ description: 'p', inputSchema: z.object({}), execute: async (_a, o) => { child = identityOf(o); return 'ok'; } });
    const wf = workflow<any>().then(step('agent', async (_i: any, ctx: StepCtx) => {
      await runDurable({ runId: `${ctx.runId}:agent`, journal: ctx.journal as never, model: callsOnce('probe', {}, { text: '' }), tools: { probe }, prompt: 'x', stopWhen: stepCountIs(4), caller: ctx.identity as RunIdentity });
      return 1;
    }));
    await createGnl({ journal, workflows: { w: wf } } as never).runWorkflow!('w', {}, { runId: 'wf-3', resourceId: 'ayse' } as never);
    expect(child).toMatchObject({ kind: 'user', id: 'ayse', runId: 'wf-3:agent', parentRunId: 'wf-3' });
    await expect(runDurable({ runId: 'wf-3:agent', journal, model: createMockModel(async () => finalTextResult('mine')), prompt: 'y', resourceId: 'mallory' }))
      .rejects.toMatchObject({ name: 'RunOwnerMismatchError' });
  });
});

describe('withIdempotency (R3)', () => {
  const addressTool = (runs: { n: number }, sawAs: Array<string | undefined>) => tool({
    description: 'd', inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }, o) => { runs.n++; sawAs.push(userIdOf(identityOf(o))); return { orderId, address: `addr-of-${userIdOf(identityOf(o))}` }; },
  });
  const as = (who: string) => ({ toolCallId: who, messages: [], gnl: toolContextFor(runIdentity(user(who), `r-${who}`)) });

  it('the owner record and the identity the tool sees are one value; another user is refused the result', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 }; const sawAs: Array<string | undefined> = [];
    const tools = withIdempotency({ address: addressTool(runs, sawAs) }, { journal });
    expect(J(await tools.address.execute!({ orderId: 'o1' }, as('ayse') as never))).toContain('addr-of-ayse');
    await expect(tools.address.execute!({ orderId: 'o1' }, as('mallory') as never)).rejects.toMatchObject({ name: 'IdempotencyOwnerMismatchError' });
    expect(runs.n).toBe(1);
    expect(sawAs).toEqual(['ayse']);
    const ownerKey = (await journal.listKeys('xrun:')).find((k) => k.startsWith('xrun:owner'))!;
    expect((await journal.get<{ resourceId?: string }>(ownerKey))?.resourceId).toBe('ayse');
  });

  it('sibling: a call with no engine context is unknown — it reuses nothing a user made', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 }; const sawAs: Array<string | undefined> = [];
    const tools = withIdempotency({ address: addressTool(runs, sawAs) }, { journal });
    await tools.address.execute!({ orderId: 'o2' }, as('ayse') as never);
    await expect(tools.address.execute!({ orderId: 'o2' }, { toolCallId: 'x', messages: [] })).rejects.toMatchObject({ name: 'IdempotencyOwnerMismatchError' });
    expect(runs.n).toBe(1);
  });

  it('sibling: the configured caller (`caller: STAFF`) reaches every record, as staff always did', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 }; const sawAs: Array<string | undefined> = [];
    const mine = withIdempotency({ address: addressTool(runs, sawAs) }, { journal });
    const ops = withIdempotency({ address: addressTool(runs, sawAs) }, { journal, caller: STAFF });
    await mine.address.execute!({ orderId: 'o3' }, as('ayse') as never);
    expect(J(await ops.address.execute!({ orderId: 'o3' }, { toolCallId: 'y', messages: [] }))).toContain('addr-of-ayse');
    expect(runs.n).toBe(1);
  });
});

describe('tools calling tools, batch, sub-agents (R4)', () => {
  it('R4 a tool composing another: forwarding options → the user; forgetting → closed (general shelf only)', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    let fwd = ''; let forgot = '';
    const outer = Object.assign(tool({ description: 'd', inputSchema: z.object({ q: z.string() }), execute: async ({ q }, o) => {
      fwd = J(await rag.execute!({ query: q }, o));
      forgot = J(await rag.execute!({ query: q }, { toolCallId: o.toolCallId, messages: [] }));
      return 'ok';
    } }), { idempotent: true });
    await runDurable({ runId: 'r4', journal: new InMemoryJournal(), model: callsOnce('outer', { q: 'invoice' }, { text: '' }), tools: { outer }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(fwd).toContain('AYSE invoice');
    expect(fwd).not.toContain('MEHMET invoice');
    expect(forgot).toContain('GENERAL handbook');
    expect(forgot).not.toContain('MEHMET invoice');
    expect(forgot).not.toContain('AYSE invoice');
  });

  it('R4 sibling: a batch item\'s tool sees the batch caller, and the item run is born owned', async () => {
    const got: unknown[] = [];
    const t = Object.assign(tool({ description: 'd', inputSchema: z.object({ id: z.string() }), execute: async (i, o) => { got.push(userIdOf(identityOf(o))); return { ok: i.id }; } }), { idempotent: true });
    const journal = new InMemoryJournal();
    const b = createBatch(journal, { tool: t as never, toolName: 'echo', itemKey: (i: any) => i.id, resourceId: 'ayse', onDuplicate: 'skip' });
    const plan = await b.preflight('b1', [{ id: 'x' }]);
    await b.run('b1', [{ id: 'x' }], { planToken: plan.token });
    expect(got).toEqual(['ayse']);
    const itemRun = (await journal.listKeys('batch:b1:')).find((k) => k.endsWith(':input'))!;
    expect((await journal.get<{ resourceId?: string }>(itemRun))?.resourceId).toBe('ayse');
  });

  it('R4 sibling: an agent-as-tool child acts for the parent\'s caller', async () => {
    const journal = new InMemoryJournal();
    let childSaw: RunIdentity | undefined;
    const probe = tool({ description: 'p', inputSchema: z.object({}), execute: async (_a, o) => { childSaw = identityOf(o); return 'ok'; } });
    const helper = createAgentTool({ journal, model: callsOnce('probe', {}, { text: '' }), tools: { probe } } as never);
    await runDurable({ runId: 'parent', journal, model: callsOnce('helper', { task: 'go' }, { text: '' }), tools: { helper }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(childSaw).toMatchObject({ kind: 'user', id: 'ayse' });
    const childInput = (await journal.listKeys('')).find((k) => k !== 'parent:input' && k.endsWith(':input'))!;
    expect((await journal.get<{ resourceId?: string }>(childInput))?.resourceId).toBe('ayse');
  });

  it('R4 sibling: a network sub-agent\'s tool sees the network\'s caller', async () => {
    const rag = createRagTool({ store: await kb(), embed, topK: 10 });
    const seen = { text: '' };
    let r = 0;
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { a: { model: callsOnce('kb', { query: 'invoice' }, seen), tools: { kb: rag }, maxSteps: 4 } },
      networks: { n: { router: createMockModel(async () => finalTextResult(r++ === 0 ? J({ action: 'route', agent: 'a', task: 'find' }) : J({ action: 'final', answer: 'ok' }))), agents: ['a'] } },
    } as never);
    await gnl.runNetwork('n', { runId: 'nw', task: 'x', resourceId: 'ayse' } as never);
    expect(seen.text).toContain('AYSE invoice');
    expect(seen.text).not.toContain('MEHMET invoice');
  });
});

describe('the old channel is closed LOUDLY', () => {
  it('a tool reading options.resourceId throws, inside a run', async () => {
    let caught: unknown;
    const legacy = tool({ description: 'l', inputSchema: z.object({}), execute: async (_a, o) => {
      try { return (o as { resourceId?: string }).resourceId ?? 'nobody'; } catch (e) { caught = e; throw e; }
    } });
    await runDurable({ runId: 'legacy', journal: new InMemoryJournal(), model: callsOnce('legacy', {}, { text: '' }), tools: { legacy }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(caught).toBeInstanceOf(TypeError);
    expect(String((caught as Error).message)).toMatch(/identityOf\(options\)/);
  });

  it('sibling: through withIdempotency too', async () => {
    const legacy = tool({ description: 'l', inputSchema: z.object({ k: z.string() }), execute: async (_a, o) => (o as { resourceId?: string }).resourceId ?? 'nobody' });
    const tools = withIdempotency({ legacy }, { journal: new InMemoryJournal() });
    await expect(tools.legacy.execute!({ k: '1' }, { toolCallId: 'x', messages: [] })).rejects.toThrow(/options\.resourceId/);
  });

  it('sibling: forwarding or serializing the options does not trip it — only reading does', async () => {
    let forwarded: Record<string, unknown> = {}; let json = '';
    const fwd = tool({ description: 'f', inputSchema: z.object({}), execute: async (_a, o) => {
      forwarded = { ...(o as object) };
      json = JSON.stringify({ toolCallId: o.toolCallId, gnl: (o as { gnl?: unknown }).gnl });
      return 'ok';
    } });
    await runDurable({ runId: 'fwd', journal: new InMemoryJournal(), model: callsOnce('fwd', {}, { text: '' }), tools: { fwd }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect('resourceId' in forwarded).toBe(false);
    expect(identityOf(forwarded)).toMatchObject({ kind: 'user', id: 'ayse' });
    expect(json).toContain('"id":"ayse"');
  });
});
