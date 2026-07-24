// gnl-demo — a self-verifying showcase that runs ALL 14 packages like a real consumer
// (file: import). NO API key required. Writes to `gnl-demo.db` → inspect visually with `pnpm studio`.
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { runDurable, resumeRun, getRunCost, forkRun, reconstructState, toJournal, createGnl, rolloverRun } from '@gnl/durable';
import { SqliteStorage } from '@gnl/durable/sqlite';
import { createAgentTool } from '@gnl/durable';
import { AgentMemory } from '@gnl/memory';
import { InMemoryVectorStore, indexDocuments, createRagTool, llmReranker, chunkDocuments, GraphRag } from '@gnl/rag';
import { workflow, waitFor, retry, step } from '@gnl/workflow';
import { piiRedactor, promptInjectionDetector, toolSearch } from '@gnl/processors';
import { scoreRun, evalDataset, contains, toxicity, createDatasetsManager } from '@gnl/evals';
import { createMcpTools, createMcpServer } from '@gnl/mcp';
import { createRestApi } from '@gnl/server';
import { exportRun } from '@gnl/otel';
import { enqueue, createWorker } from '@gnl/queue';
import { emit, createConsumer } from '@gnl/events';
import { createA2ATool } from '@gnl/a2a';
import { createCache } from '@gnl/cache';
import { createStudioApp } from '@gnl/studio';
import { agentModel, finalText, toolCall, countToolResults, mkModel, embed, fakeMcpClient } from './mock.js';

const assert = (cond: any, msg: string) => { if (!cond) throw new Error(msg); };
let pass = 0, fail = 0;
async function section(name: string, fn: () => Promise<string>) {
  try { console.log(`✓ ${name} — ${await fn()}`); pass++; }
  catch (e) { console.log(`✗ ${name} — ${(e as Error).message}`); fail++; }
}

rmSync('gnl-demo.db', { force: true });
const storage = new SqliteStorage('gnl-demo.db'); // all store ports (run+memory+cache+work)
const journal = storage.runs; // low-level RunJournal (durable run/inspection)

console.log('\n=== gnl-demo: 14 packages, no API key, durable showcase ===\n');

await section('@gnl/durable — exactly-once (charge→crash→resume)', async () => {
  const charges = { n: 0 };
  const crash = { active: true };
  const tools = () => ({ charge: { execute: async () => ({ charged: (charges.n++, 20) }) } });
  const model = () => mkModel(async ({ prompt }: any) => {
    const d = countToolResults(prompt);
    if (d === 0) return toolCall('charge', 'c', { amount: 20 });
    if (crash.active && d === 1) throw new Error('CRASH');
    return finalText('Charged.');
  });
  await runDurable({ runId: 'order-1', journal, model: model(), tools: tools(), prompt: 'collect payment' }).catch(() => {});
  crash.active = false;
  await runDurable({ runId: 'order-1', journal, model: model(), tools: tools(), prompt: 'collect payment' });
  assert(charges.n === 1, `charge should be 1, got ${charges.n}`);
  return `charge = ${charges.n} despite the crash`;
});

await section('@gnl/processors — PII redaction (masked in the journal)', async () => {
  await runDurable({ runId: 'pii-1', journal, model: mkModel(async () => finalText('ok')), processors: [piiRedactor(), promptInjectionDetector()], prompt: 'mail: ada@x.com' });
  const input = await journal.get<any>('pii-1:input');
  assert(!JSON.stringify(input).includes('ada@x.com'), 'raw email remained in the journal');
  return 'raw email was not written to the journal';
});

await section('@gnl/memory — schema working memory + tool', async () => {
  const mem = new AgentMemory({ storage, embed, workingMemory: { schema: z.object({ name: z.string().optional() }) } });
  const m = () => agentModel('updateWorkingMemory', 'wm1', { name: 'Ada' }, 'saved');
  await runDurable({ runId: 'mem-1', journal, model: m(), memory: mem, threadId: 'cust-7', prompt: 'save my name' });
  const wm = await storage.memory!.getWorkingMemory('cust-7') as any;
  assert(wm?.name === 'Ada', 'WM was not written');
  return `working memory = ${JSON.stringify(wm)}`;
});

await section('@gnl/rag — retrieval + LLM reranker', async () => {
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: '1', text: 'refund policy: 14 days' }, { id: '2', text: 'shipping time: 3 days' }, { id: '3', text: 'refund and shipping' },
  ]);
  const tool = createRagTool({ store, embed, topK: 3, rerank: llmReranker({ model: mkModel(async () => finalText('0,2,1')) }), rerankTopK: 2 });
  const res: any = await tool.execute!({ query: 'refund' }, { toolCallId: 'r' });
  assert(res.length === 2, 'rerankTopK was not applied');
  return `${res.length} documents after rerank`;
});

await section('@gnl/mcp — client durable + server-side exactly-once', async () => {
  const counter = { calls: 0 };
  const tools = await createMcpTools(fakeMcpClient(counter));
  await runDurable({ runId: 'mcp-1', journal, model: agentModel('lookup', 'l', { id: '42' }), tools, prompt: 'search' });
  await runDurable({ runId: 'mcp-1', journal, model: agentModel('lookup', 'l', { id: '42' }), tools, prompt: 'search' }); // resume
  assert(counter.calls === 1, `MCP client call count ${counter.calls}`);
  const srv = createMcpServer({ journal, tools: { pay: { execute: async () => (counter.calls++, 'ok') } } });
  await srv.callTool({ name: 'pay', arguments: {}, idempotencyKey: 'k' });
  await srv.callTool({ name: 'pay', arguments: {}, idempotencyKey: 'k' });
  return `client+server exactly-once (total exec=${counter.calls})`;
});

await section('@gnl/durable — multi-agent (createAgentTool)', async () => {
  let sub = 0;
  const expert = createAgentTool({ journal, model: mkModel(async () => (sub++, finalText('expert: 42'))) }, { description: 'expert' });
  const m = () => agentModel('askExpert', 'ax', { task: '6x7' }, 'Result ready');
  await runDurable({ runId: 'router-1', journal, model: m(), tools: { askExpert: expert }, prompt: 'calculate' });
  const c1 = sub;
  await runDurable({ runId: 'router-1', journal, model: m(), tools: { askExpert: expert }, prompt: 'calculate' }); // resume
  assert(sub === c1, 'sub-agent ran again on resume');
  return `sub-agent was skipped on resume (calls=${sub})`;
});

await section('@gnl/durable — suspend/resume (human approval)', async () => {
  const charges = { n: 0 };
  const guard = ({ args }: any) => ((args as any).amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const });
  const tools = () => ({ charge: { execute: async () => ({ charged: (charges.n++, 5000) }) } });
  const model = () => agentModel('charge', 'big', { amount: 5000 }, 'Done.');
  const r1 = await runDurable({ runId: 'appr-1', journal, model: model(), tools: tools(), guard, prompt: 'large charge' });
  assert(r1.interrupts.length === 1 && charges.n === 0, 'was not suspended');
  await resumeRun('appr-1', { journal, model: model(), tools: tools(), guard, approvals: { big: true } });
  assert(charges.n === 1, 'did not run after approval');
  return 'suspended → approved → exactly 1 charge';
});

await section('@gnl/workflow — evented (waitFor suspend/resume)', async () => {
  const bus = { ok: false };
  const wf = workflow<{ id: string }>().then({ id: 'prep', run: async (i: any) => i }).then(waitFor('approval', async () => (bus.ok ? { done: true } : null)) as any);
  const r1 = await wf.runResumable({ id: 'x' }, { runId: 'wf-1', journal });
  assert(r1.status === 'suspended', 'workflow was not suspended');
  bus.ok = true;
  const r2 = await wf.runResumable({ id: 'x' }, { runId: 'wf-1', journal });
  assert(r2.status === 'completed', 'did not complete after the event');
  return 'waited for event → arrived → completed';
});

await section('@gnl/queue — durable job (worker)', async () => {
  const log: string[] = [];
  await enqueue(storage.work!, 'notify', { to: 'ada' }, { id: 'job-1' });
  const worker = createWorker(storage, { notify: async (p: any) => void log.push(p.to) });
  await worker.drain();
  assert(log.length === 1, 'job did not run');
  return `job ran on the worker (${log[0]})`;
});

await section('@gnl/events — event bus (exactly-once marking + at-least-once delivery) + fan-out', async () => {
  const a: string[] = [], b: string[] = [];
  await emit(storage.work!, 'orders', { id: 'o1' }, { id: 'o1' });
  await createConsumer(storage.work!, 'orders', (p: any) => void a.push(p.id), { name: 'A' }).poll();
  await createConsumer(storage.work!, 'orders', (p: any) => void b.push(p.id), { name: 'B' }).poll();
  assert(a.length === 1 && b.length === 1, 'fan-out incorrect');
  return 'each consumer received the event once (fan-out)';
});

await section('@gnl/a2a + @gnl/server — remote agent (cross-network exactly-once)', async () => {
  const remote = { charges: 0 };
  const app = createRestApi({ journal: new (await import('@gnl/durable')).InMemoryJournal(), agents: { billing: { model: agentModel('charge', 'rc', { amt: 20 }, 'charged'), tools: { charge: { execute: async () => (remote.charges++, { ok: true }) } }, maxSteps: 6 } } });
  const fetchImpl = ((u: any, i: any) => app.request(String(u), i)) as any;
  const t = createA2ATool({ endpoint: 'http://x', agentName: 'billing', fetchImpl });
  await t.execute!({ task: 'charge' }, { toolCallId: 'a1' } as any);
  await t.execute!({ task: 'charge' }, { toolCallId: 'a1' } as any); // same toolCallId → idempotent remotely
  assert(remote.charges === 1, `remote charge ${remote.charges}`);
  return `remote agent idempotent (charge=${remote.charges})`;
});

await section('@gnl/cache — cross-run cache', async () => {
  const cache = createCache(storage.cache!, 'embeds');
  let calls = 0;
  await cache.getOrCompute('refund', () => (calls++, [1, 0]));
  await createCache(storage.cache!, 'embeds').getOrCompute('refund', () => (calls++, [9, 9])); // different instance, same store
  assert(calls === 1, 'cache miss');
  return `computed once (cross-run hit)`;
});

await section('@gnl/evals — scoreRun + dataset bulk', async () => {
  const s = await scoreRun(journal, 'order-1', [contains('Charged')]);
  assert(s.scores['contains'].score === 1, 'scoreRun incorrect');
  const ds = await evalDataset({ dataset: { id: 'd', cases: [{ id: 'c1', input: 'x', expected: 'echo:x' }] }, run: async (i) => `echo:${i}`, scorers: [contains('echo')], journal });
  assert(ds.aggregate['contains'] === 1, 'dataset eval incorrect');
  return `scoreRun + evalDataset (aggregate=${ds.aggregate['contains']})`;
});

await section('@gnl/otel — trace export (waterfall)', async () => {
  const { traceId, spans, exporter } = await exportRun(journal, 'order-1', { serviceName: 'demo' });
  const fin = (exporter as any).getFinishedSpans();
  const cost = await getRunCost(journal, 'order-1');
  const wf = fin.map((s: any) => `${s.name}(${(s.duration[0] * 1000 + s.duration[1] / 1e6).toFixed(1)}ms)`).join(' → ');
  assert(spans >= 2, 'no spans');
  return `traceId=${traceId.slice(0, 8)}… ${spans} span · $${cost.costUsd.toFixed(4)}\n     ${wf}`;
});

await section('@gnl/durable — time-travel + fork', async () => {
  const entries = await journal.readRun('order-1');
  const state = reconstructState(entries, 1);
  assert(state.messages.length >= 1, 'no state reconstruct');
  const fork = await forkRun(journal, 'order-1', 1, 'order-1-fork');
  assert(fork.copiedModel >= 1, 'fork did not copy');
  return `step-1 state + fork (${fork.copiedModel} model, ${fork.copiedTool} tool copied)`;
});

await section('@gnl/studio — state endpoint + fork (app.request)', async () => {
  const app = createStudioApp({ reader: toJournal(journal), resume: async () => ({ text: 'ok' }) });
  const caps = await (await app.request('/api/capabilities')).json();
  assert(caps.fork === true, 'fork capability disabled');
  const st = await (await app.request('/api/runs/order-1/state?step=1')).json();
  assert(st.step === 1, 'state endpoint incorrect');
  return `studio: fork enabled + state reconstruction works`;
});

// ── Features added in recent weeks (same pattern, mock model, no API key) ──────────────────────

await section('@gnl/durable — dynamic agent network (createGnl networks + runNetwork)', async () => {
  // Scripted router: returns the given JSON decisions in order + counts how many times it was called
  // (the scriptedRouter pattern from network.test.ts). Determinism: the decision freezes into the
  // journal → the router is NOT CALLED AGAIN on resume (proven below with the call counter).
  const route = (agent: string, task: string) => JSON.stringify({ action: 'route', agent, task });
  const done = (answer: string) => JSON.stringify({ action: 'final', answer });
  const routerCalls = { n: 0 };
  const scriptedRouter = (answers: string[]) => {
    let i = 0;
    return mkModel(async () => { routerCalls.n++; const text = answers[Math.min(i, answers.length - 1)] ?? ''; i++; return finalText(text); });
  };
  const router = scriptedRouter([route('research', 'find sources'), route('write', 'summarize'), done('report: summary from 2 sources')]);
  const gnl = createGnl({
    journal,
    agents: {
      research: { model: mkModel(async () => finalText('3 sources found')), description: 'searches for sources' },
      write: { model: mkModel(async () => finalText('summary written')), description: 'writes a summary' },
    },
    networks: { team: { router, agents: ['research', 'write'] } },
  });
  const r1 = await gnl.runNetwork('team', { runId: 'net-1', task: 'research the topic and summarize' });
  assert(r1.text === 'report: summary from 2 sources', 'router final answer incorrect');
  assert(r1.steps.map((s) => s.agent).join(',') === 'research,write', 'route order incorrect');
  const c1 = routerCalls.n; // 3 decisions (route + route + final)
  const r2 = await gnl.runNetwork('team', { runId: 'net-1', task: 'research the topic and summarize' }); // resume
  assert(routerCalls.n === c1, `router was called again on resume (${routerCalls.n} ≠ ${c1})`);
  assert(r2.text === r1.text, 'resume did not give the same result');
  return `route→route→final (router calls=${c1}), router called 0 times on resume`;
});

await section('@gnl/workflow — retry(attempts) (fails twice → succeeds on the 3rd)', async () => {
  const tries = { n: 0 };
  const flaky = step('charge', async () => {
    tries.n++;
    if (tries.n < 3) throw new Error('temporary error');
    return { ok: true, at: tries.n };
  });
  const wf = workflow<{}>().then(retry(flaky, { attempts: 3 }));
  const out: any = await wf.run({}, { runId: 'retry-1', journal });
  assert(out.ok === true && tries.n === 3, `did not succeed on the 3rd attempt (tries=${tries.n})`);
  // Journal proof of the counter: 2 failed attempts were counted (a successful attempt doesn't increment it).
  const used = await journal.get<number>('retry-1:wf:charge:attempts');
  assert(used === 2, `attempts counter is ${used}, should be 2`);
  return `2 failed attempts (journal attempts=${used}) → 3rd attempt succeeded`;
});

await section('@gnl/rag — chunkDocuments (markdown) → GraphRag indirect-relevance contrast', async () => {
  const md = ['# Refunds', 'refund policy 14 days', '## Shipping', 'refund shipping form', '# Security', 'password reset', '## Compensation', 'shipping delay compensation'].join('\n');
  const chunks = chunkDocuments([{ id: 'kb', text: md }], { strategy: 'markdown' });
  assert(chunks.some((c) => c.metadata?.heading === 'Refunds > Shipping'), 'no markdown breadcrumb metadata');
  // Index the same chunks into both the flat store and GraphRag.
  const flat = new InMemoryVectorStore();
  const graph = new GraphRag({ threshold: 0.7 });
  await indexDocuments(flat, embed, chunks);
  await indexDocuments(graph, embed, chunks);
  const flatTool = createRagTool({ store: flat, embed, topK: 3 });
  const graphTool = createRagTool({ store: graph, embed, topK: 3 });
  const flatRes: any = await flatTool.execute!({ query: 'refund' }, { toolCallId: 'f' });
  const graphRes: any = await graphTool.execute!({ query: 'refund' }, { toolCallId: 'g' });
  // "shipping delay compensation": not directly similar to the query (doesn't show up in flat search)
  // but is strongly linked to 'refund shipping form' → GraphRag surfaces it via neighbor expansion.
  assert(!flatRes.some((r: any) => r.text.includes('compensation')), 'flat search returned the indirect chunk');
  assert(graphRes.some((r: any) => r.text.includes('compensation')), 'GraphRag did not return the indirect chunk');
  return `${chunks.length} chunks (with breadcrumbs); the indirect chunk only showed up in GraphRag`;
});

await section('@gnl/processors — toolSearch (4 tools → 1 selection, journal replay)', async () => {
  const embedCalls = { n: 0 };
  const cEmbed = async (t: string) => (embedCalls.n++, embed(t));
  const tools = {
    refund: { description: 'refund and reimbursement operations', execute: async () => ({ ok: true }) },
    shipping: { description: 'shipping tracking status', execute: async () => ({}) },
    invoice: { description: 'invoice generation', execute: async () => ({}) },
    password: { description: 'password reset', execute: async () => ({}) },
  };
  const opts = () => ({ runId: 'ts-1', journal, model: agentModel('refund', 'tr', {}), tools, processors: [toolSearch({ embed: cEmbed, topK: 1 })], prompt: 'I want my refund back' });
  await runDurable(opts() as any);
  const sel = await journal.get<{ v: string[] }>('ts-1:proc:tool-search');
  assert(JSON.stringify(sel?.v) === JSON.stringify(['refund']), `wrong tool selected: ${JSON.stringify(sel?.v)}`);
  const c1 = embedCalls.n; // 1 query + 4 tool descriptions
  await runDurable(opts() as any); // resume
  assert(embedCalls.n === c1, `embed was called again on resume (${embedCalls.n} ≠ ${c1})`);
  return `'refund' was selected out of 4 tools (embed=${c1}) · selection replayed from the journal on resume`;
});

await section('@gnl/durable — rolloverRun (period rollover → context moved to the new period)', async () => {
  // Period 1: a 2-step run (tool call + final).
  await runDurable({ runId: 'ro-1', journal, model: agentModel('note', 'n1', { text: 'Ada' }, 'Note taken.'), tools: { note: { execute: async (a: any) => ({ saved: a.text }) } }, prompt: 'my name is Ada, take a note' });
  // Rollover: the old run's final state is carried into the new period's :input seed (nothing is deleted).
  const rr = await rolloverRun(journal, 'ro-1');
  assert(rr.newRunId === 'ro-1@2' && rr.seededMessages >= 2, `rollover seed is empty (${rr.seededMessages})`);
  // Period 2: the new period's model MUST see the carried-over context.
  let captured = '';
  const p2 = mkModel(async ({ prompt }: any) => { captured = JSON.stringify(prompt); return finalText('Continuing.'); });
  await resumeRun(rr.newRunId, { journal, model: p2, tools: { note: { execute: async () => ({}) } } });
  assert(captured.includes('Ada'), 'the carried-over context did not reach the model');
  return `${rr.seededMessages} messages carried to ${rr.newRunId}, the new period's model saw the context`;
});

await section('@gnl/evals — toxicity(sampleFields=[]) + DatasetsManager compare (regression)', async () => {
  // 1) toxicity: sampleFields=[] → input/context (toxic words) are NOT ADDED to the prompt, only the
  //    output is evaluated. Since the judge prompt never sees the toxic context, it returns a clean score.
  let judgePrompt = '';
  const judge = mkModel(async ({ prompt }: any) => {
    judgePrompt = JSON.stringify(prompt);
    return finalText(/stupid|idiot/.test(judgePrompt) ? 'SCORE: 0.1\nREASON: toxic' : 'SCORE: 0.95\nREASON: clean');
  });
  const tox = toxicity({ model: judge });
  const res = await tox.score({ output: 'I am happy to help.', input: 'stupid', context: ['idiot moron'] });
  assert(!/stupid|idiot/.test(judgePrompt), 'toxic context leaked into the prompt despite sampleFields=[]');
  assert(res.score >= 0.9, `clean output got a low score (${res.score})`);

  // 2) DatasetsManager compare: 2 experiments, one has a regression in 1 case.
  const dm = createDatasetsManager(journal);
  const ds = { id: 'greet', cases: [{ id: 'c1', input: 'x', expected: 'good' }, { id: 'c2', input: 'y', expected: 'good' }] };
  await dm.runExperiment({ dataset: ds, experimentId: 'base', run: async () => 'good answer', scorers: [contains()], now: 1 });
  await dm.runExperiment({ dataset: ds, experimentId: 'cand', run: async (i: any) => (i === 'x' ? 'good answer' : 'bad answer'), scorers: [contains()], now: 2 });
  const diff = await dm.compare('greet', 'base', 'cand');
  assert(diff.regressions === 1 && diff.improvements === 0, `regression count incorrect (${diff.regressions})`);
  return `toxicity clean=${res.score} (toxic context did not leak) · compare: ${diff.regressions} regression(s) caught`;
});

await storage.close();
console.log(`\n=== ${pass}/${pass + fail} features ✓ ${fail ? `(${fail} FAILED)` : '(all passed)'} ===`);
console.log('Inspect visually: pnpm studio  → http://localhost:4321\n');
process.exit(fail ? 1 : 0);
