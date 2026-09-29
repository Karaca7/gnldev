// Re-emission measurement — the duplicate layer on the REAL engine, with realistic conversation traffic.
//
// Nothing here writes tool arguments by hand: a real model reads each user message and produces the
// tool call itself, a real embedder vectorises it, the real rule ladder and judge decide, and every
// step is journaled to a real Postgres. Paraphrase comes from the model, not from us.
//
// What it measures, and what it does not:
//   MEASURES      → did the layer ask when it should have, and stay silent when it should have
//                   (ground truth is the scenario's intent label), which rung asked, how often the judge ran
//   DOES NOT      → precision@suspend. That metric is what a REAL human answered; approvals here are
//                   simulated and cannot imitate a tired operator or domain knowledge.
//
// The system prompt and tool descriptions are Turkish on purpose: they are the exact inputs of the
// 2026-09-08 run whose results are in results/re-emission/. Translating them would change the experiment.
//
// Requires: NVIDIA_API_KEY (build.nvidia.com) and DATABASE_URL (any Postgres). Run: pnpm re-emission
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { toJournal, runDurable, readIncidents, registerModelProvider } from '@gnldev/durable';
import type { JudgeCert } from '@gnldev/durable';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema } from 'ai';

const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const KEY = process.env.NVIDIA_API_KEY ?? '';
if (!KEY) console.warn('NVIDIA_API_KEY is empty — every model call will return 401.');
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set — falling back to a local Postgres on 127.0.0.1:5544.');
registerModelProvider('nvidia', (id) => createOpenAI({ baseURL: BASE_URL, apiKey: KEY }).chat(id));

const EMBED_MODEL = 'nvidia/nemotron-3-embed-1b';
const EMBED_MODEL_ID = `nvidia:${EMBED_MODEL}`;
async function nvidiaEmbed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    // input_type is required by NVIDIA retrieval embedders; canonical dedup sentences are short, query-like.
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: 'float', input_type: 'query' }),
  });
  if (!res.ok) throw new Error(`NIM embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
interface Turn { n: number; user: string; intent: string; note?: string }
interface Scenario { id: string; persona: string; turns: Turn[] }
const { scenarios } = JSON.parse(readFileSync(here('../../data/re-emission/scenarios.json'), 'utf8')) as { scenarios: Scenario[] };

const storage = new PostgresStorage({ connectionString: process.env.DATABASE_URL ?? 'postgres://gnl:gnl@127.0.0.1:5544/gnl' });
const journal = toJournal(storage.runs);
const RUN = Date.now().toString(36);

// The judge certificate is HAND-FILLED with the scores this judge configuration had when the run was
// recorded (fixtureSetId is the hash of packages/semantic-qualify/fixtures/pairs-calibration.json).
// The qualification output itself is not committed. For a real certificate, qualify your own judge:
//   npx gnl-semantic-qualify --judge ./my-judge.mjs --model <judge-model>
let judgeCalls = 0;
const judgeCert: JudgeCert = {
  v: 1, fixtureSetId: '7fe686bc058884cf', judgeModelId: 'openai/gpt-oss-20b', judgePromptVersion: '1',
  paraphraseRecall: 0.933, nearMissFp: 0.04, passedAt: Date.now(),
};
const judgeComplete = async ({ system, user }: { system: string; user: string }): Promise<string> => {
  judgeCalls++;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    // A generous budget: a reasoning model emits reasoning BEFORE its one-word answer; a tight budget
    // swallows the answer and the layer silently fails open.
    body: JSON.stringify({ model: 'openai/gpt-oss-20b', temperature: 0, max_tokens: 800,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) return '';
  const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return j.choices[0]?.message.content ?? '';
};

const limits = {
  sideEffectDuplicates: {
    action: 'suspend' as const, scope: 'thread' as const,
    semantic: {
      embed: nvidiaEmbed, embedModelId: EMBED_MODEL_ID, rules: true as const,
      judge: { complete: judgeComplete, judgeModelId: 'openai/gpt-oss-20b', qualification: judgeCert, maxCallsPerRun: 5, timeoutMs: 60_000 },
    },
  },
};

// Tools: side-effecting, identity-declared, and deliberately WITHOUT `confirm` — a confirm gate asks
// on every first call and would drown the measurement in questions the dedup layer never asked.
let executions = 0;
const ex = (name: string) => { executions++; return { ok: true, tool: name }; };
const tool = (description: string, props: Record<string, unknown>, required: string[], id: Record<string, unknown>) => ({
  description, sideEffect: true as const, recover: async () => ({ done: false as const }),
  // The jsonSchema() wrapper is required: the AI SDK rejects a raw object ('schema is not a function').
  inputSchema: jsonSchema({ type: 'object', properties: props, required } as never),
  semanticIdentity: id,
  execute: async () => ex(description),
});
const S = { type: 'string' }, N = { type: 'number' };
const tools = {
  createOrder: tool('Yeni sipariş oluşturur', { sku: S, qty: N, amount: N }, ['sku'], { keys: ['sku'], amountFields: ['amount'] }),
  payInvoice: tool('Fatura öder', { ref: S, amount: N }, ['ref'], { keys: ['ref'], amountFields: ['amount'] }),
  refund: tool('İade başlatır', { orderId: S, reason: S }, ['orderId'], { keys: ['orderId'] }),
  sendMail: tool('E-posta gönderir', { to: S, subject: S }, ['to'], { keys: ['to', 'subject'] }),
  adjustStock: tool('Stok hareketi yazar', { code: S, warehouse: S, delta: N }, ['code'], { keys: ['code', 'warehouse'], amountFields: ['delta'] }),
};

const SYSTEM = [
  'Sen bir e-ticaret operasyon asistanısın. Kullanıcının isteğini uygun ARACA çevirirsin.',
  'Kullanıcı bir iş istiyorsa MUTLAKA ilgili aracı çağır — sadece konuşma yapma.',
  'Argümanları kullanıcının cümlesinden çıkar; eksik sayısal alanları makul biçimde doldur.',
  'Araç sonucundan sonra tek cümlelik kısa bir Türkçe onay yaz.',
].join(' ');
const MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';

interface Row { scenario: string; turn: number; intent: string; asked: boolean; origin?: string; executed: boolean; tombstoned: boolean; judged: number }
const rows: Row[] = [];
let turnsRun = 0, toolTurns = 0;

async function runTurn(sc: Scenario, t: Turn, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<void> {
  const runId = `sim-${RUN}-${sc.id}-${t.n}`;
  const before = executions;
  const judgedBefore = judgeCalls;
  let asked = false, origin: string | undefined;
  try {
    const r = await runDurable({
      runId, journal, model: MODEL as never,
      tools: tools as never, threadId: `sim-${RUN}-${sc.id}`, limits, system: SYSTEM,
      messages: [...history, { role: 'user', content: t.user }] as never,
      stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 4) as never,
    } as never) as { interrupts?: unknown[]; text?: string };
    asked = (r.interrupts?.length ?? 0) > 0;
    if (asked) {
      const inc = (await readIncidents(journal, runId)).find((i) => i.action === 'suspend');
      origin = inc?.source === 'semantic-judge' ? 'judge' : ((inc?.detail as { origin?: string } | undefined)?.origin ?? (inc?.source === 'duplicate-guard' ? 'exact' : 'other'));
      // Simulated approval: we measure WHETHER it asked, not the answer. Approving leaves a "previous
      // job" for later turns to build on — a rejection would never run it and the rest of the scenario
      // would lose its meaning.
      const approvals = Object.fromEntries((r.interrupts as Array<{ toolCallId: string }>).map((i) => [i.toolCallId, true]));
      await runDurable({ runId, journal, model: MODEL as never,
        tools: tools as never, threadId: `sim-${RUN}-${sc.id}`, limits, system: SYSTEM,
        messages: [...history, { role: 'user', content: t.user }] as never, approvals,
        stopWhen: (({ steps }: { steps: unknown[] }) => steps.length >= 4) as never } as never);
    }
    history.push({ role: 'user', content: t.user }, { role: 'assistant', content: r.text ?? 'tamam' });
  } catch (err) {
    process.stdout.write(`\n  ! ${sc.id}/${t.n} error: ${(err as Error).message.slice(0, 80)}`);
  }
  const executed = executions > before;
  if (executed || asked) toolTurns++;
  turnsRun++;
  rows.push({ scenario: sc.id, turn: t.n, intent: t.intent, asked, origin, executed, tombstoned: false, judged: judgeCalls - judgedBefore });
}

console.log(`\n— RE-EMISSION RUN — ${scenarios.length} scenarios, real engine + real model + real Postgres —\n`);
for (const [i, sc] of scenarios.entries()) {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const t of sc.turns) await runTurn(sc, t, history);
  process.stdout.write(`\r  scenario ${i + 1}/${scenarios.length} (turns ${turnsRun}, tool turns ${toolTurns}, judge ${judgeCalls})`);
}
console.log('\n');

const outDir = here('../../results/re-emission');
mkdirSync(outDir, { recursive: true });
const out = `${outDir}/traffic-report.${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify({ v: 1, runId: RUN, rows, judgeCalls, executions }, null, 1));
console.log(`Wrote ${out}. Classify it with: pnpm re-emission:tally ${out}`);
console.log('Approvals in this run are SIMULATED: it measures whether the layer asked the right question');
console.log('and its cost profile; precision@suspend (a real human decision) still needs live use.');
await (storage as { close?: () => Promise<void> }).close?.();
