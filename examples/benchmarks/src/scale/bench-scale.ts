// Scale benchmark — puts numbers (not guesses) on "can a large workload use the duplicate layer?".
// Real Postgres, real key shapes, real vector size (2048, same as nemotron-3-embed-1b). The embed
// closure is fake and deterministic: API latency is a separate line item and must not pollute the
// journal cost being measured here.
//
// Honest scope: findSemanticCandidate is not exported, so recallScan() below reproduces its cost
// profile (listKeys + N gets + N base64-decode + 2048-dim cosine) rather than calling it. The cost is
// journal I/O plus that loop, which is what this measures.
//
// Requires: DATABASE_URL (any Postgres). Run: pnpm scale
import { PostgresStorage } from '@gnldev/durable/postgres';
import { toJournal, semKey } from '@gnldev/durable';

const DIM = 2048;
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set — falling back to a local Postgres on 127.0.0.1:5544.');
const storage = new PostgresStorage({ connectionString: process.env.DATABASE_URL ?? 'postgres://gnl:gnl@127.0.0.1:5544/gnl' });
const journal = toJournal(storage.runs);

function fakeVec(seed: number): number[] {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < 8; i++) v[(seed * 131 + i * 977) % DIM] = 1;
  return v;
}
const b64 = (vec: number[]) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
const fakeEmbed = async (texts: string[]) => texts.map((t) => fakeVec(t.length));

async function timeIt<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const r = await fn();
  return [performance.now() - t0, r];
}

const decodeVec = (x: string) => { const b = Buffer.from(x, 'base64'); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)); };
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
async function recallScan(threadId: string, canonical: string): Promise<{ kind: string; candidates: number }> {
  const prefix = `xthr:${threadId}:sem-createOrder-`;
  const keys = await journal.listKeys!(prefix);
  const [qv] = await fakeEmbed([canonical]);
  const q = new Float32Array(qv!);
  let best = -1; let n = 0;
  for (const k of keys) {
    const rec = await journal.get<{ vecB64?: string }>(k);
    if (!rec?.vecB64) continue;
    n++;
    const s = cosine(q, decodeVec(rec.vecB64));
    if (s > best) best = s;
  }
  return { kind: best >= 0.6 ? 'suspend-candidate' : 'none', candidates: n };
}

async function seedThread(threadId: string, n: number) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await journal.put(semKey(threadId, 'createOrder', `hash-${i}`), {
      v: 1, toolName: 'createOrder', argsHash: `hash-${i}`, embedModelId: 'bench', templateVersion: '1',
      canonical: `createOrder: sku-${i}`, vecB64: b64(fakeVec(i)),
      identity: { sku: `sku-${i}` }, amounts: { amount: i * 10 }, discriminators: {},
      firstToolCallId: `call-${i}`, at: Date.now(),
    });
  }
  return performance.now() - t0;
}

async function benchSem(n: number) {
  const threadId = `bench-sem-${n}-${Date.now().toString(36)}`;
  const seedMs = await seedThread(threadId, n);
  const canonical = `createOrder: sku-${Math.floor(n / 2)}`;
  // cold, then warm (Postgres buffer cache)
  const [cold, v1] = await timeIt(() => recallScan(threadId, canonical));
  const [warm, v2] = await timeIt(() => recallScan(threadId, canonical));
  console.log(`sem  N=${String(n).padStart(5)}  seed=${(seedMs / n).toFixed(1)}ms/record  recall: cold=${cold.toFixed(0)}ms warm=${warm.toFixed(0)}ms  (${v1.candidates} candidates, ${v2.kind})`);
  await journal.deletePrefix!(`xthr:${threadId}:`);
}

async function benchExact(n: number) {
  const threadId = `bench-ex-${Date.now().toString(36)}`;
  for (let i = 0; i < n; i++) await journal.put(`xthr:${threadId}:dup-createOrder-h${i}`, { firstToolCallId: `c${i}`, at: Date.now() });
  const [ms] = await timeIt(async () => {
    for (let i = 0; i < 100; i++) await journal.get(`xthr:${threadId}:dup-createOrder-h${i * Math.floor(n / 100)}`);
  });
  console.log(`exact marker get (100 reads among ${n} records): total=${ms.toFixed(0)}ms → ${(ms / 100).toFixed(2)}ms/read`);
  await journal.deletePrefix!(`xthr:${threadId}:`);
}

async function benchSuggestions(n: number) {
  const pre = `bench-sugg-${Date.now().toString(36)}`;
  for (let i = 0; i < n; i++) {
    await journal.put(`sugg:${pre}-${i}`, {
      v: 1, id: `${pre}-${i}`, type: 'memory-lesson', scope: 'personal', resourceId: `u-${i % 50}`,
      status: 'pending', rule: `rule ${i}`, mechanism: 'because', evidence: [{ runId: `r${i}`, resourceId: `u-${i % 50}`, at: Date.now() }], at: Date.now(),
    });
  }
  const [ms, count] = await timeIt(async () => {
    const ks = await journal.listKeys!(`sugg:${pre}`); // only this run's records, never the database's own
    let c = 0;
    for (const k of ks) { if ((await journal.get(k)) !== undefined) c++; }
    return c;
  });
  console.log(`suggestions list-style full scan (${count} records): ${ms.toFixed(0)}ms → ${(ms / count).toFixed(2)}ms/record`);
  await journal.deletePrefix!(`sugg:${pre}`);
}

console.log(`\n— SCALE BENCH (real Postgres, vector dim=${DIM}) —\n`);
await benchExact(2000);
for (const n of [100, 500, 2000]) await benchSem(n);
await benchSuggestions(2000);
await (storage as { close?: () => Promise<void> }).close?.();
console.log();
