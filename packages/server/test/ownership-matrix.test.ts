// A conformance table GENERATED from two lists a maintainer keeps (ADR-0002 point 7, first rows):
//   BIRTHS — every way a run/thread comes to exist, including the record states that used to leak
//            (ownerless, record missing with rows present, owner record unreadable);
//   SITES  — every door operation that decides "is this the caller's" — REST routes, and the
//            STANDALONE chat-adapter, which has no server gate in front of the engine.
// Invariant, for every BIRTH x SITE: another end user neither reads a secret nor changes foreign
// state. No finding is encoded here; the lists are the whole input. At 15e10409 nine cells leaked
// (SECRET-2 through the standalone chat door, the legacy-run takeover D2, the read-error policy).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { createChatRoute } from '../../chat-adapter/src/chat-route.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
const userText = (prompt: any[]) => (prompt ?? []).filter((m) => m.role === 'user')
  .map((m) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : String(m.content))).join('|');
const echo: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'echo', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: `echo:${userText(prompt)}` }], finishReason: stop, usage, warnings: [] }),
  doStream: async ({ prompt }: any) => ({
    stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
      c.enqueue({ type: 'text-delta', id: 't', delta: `echo:${userText(prompt)}` }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: stop, usage }); c.close();
    } }),
  }),
};
const PRINCIPALS: Record<string, unknown> = {
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] },
  mallory: { kind: 'subject', id: 'u-mallory', roles: ['admin'] },
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
};
const auth = { authenticate: (r: Request) => PRINCIPALS[r.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null, authorize: () => ({ allow: true }) };

function world() {
  const storage = new InMemoryStorage();
  const runs = storage.runs as any;
  const fail = new Set<string>();
  const g = runs.get.bind(runs);
  runs.get = async (k: string) => { if (fail.has(k)) throw new Error('EIO (injected)'); return g(k); };
  const config = { storage, memory: new BasicMemory(storage.runs), agents: { a: { model: echo } },
    workflows: { w: workflow<any>().then(step('draft', async () => 'WF-DRAFT')).then(waitForResume<{ ok: boolean }>('approve')) } } as any;
  const api = createRestApi(config, { auth: auth as never, protectionsBanner: false }) as (r: Request) => Promise<Response>;
  // The standalone chat door: the engine behind it, NO server gate in front.
  const chat = createChatRoute({ gnl: createGnl(config) } as never, { identity: () => ({ resourceId: 'u-mallory' }) } as never) as any;
  const settle = (p: Promise<string>) => Promise.race([p, new Promise<string>((res) => setTimeout(() => res('<<stream>>'), 1500))]);
  const rest = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await api(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: await settle(r.text()) };
  };
  return { runs, fail, rest, chat, settle };
}
type W = ReturnType<typeof world>;
type Born = { runId: string; threadId?: string };

const BIRTHS: Record<string, (w: W) => Promise<Born>> = {
  'user agent run': async (w) => { await w.rest('ayse', 'POST', '/agents/a/run', { runId: 'R', prompt: 'SECRET-1', threadId: 'T' }); return { runId: 'R', threadId: 'T' }; },
  'staff agent run (ownerless)': async (w) => { await w.rest('ops', 'POST', '/agents/a/run', { runId: 'R', prompt: 'SECRET-2', threadId: 'T' }); return { runId: 'R', threadId: 'T' }; },
  'user workflow run': async (w) => { await w.rest('ayse', 'POST', '/workflows/w/run', { runId: 'R', input: { s: 'SECRET-3' } }); return { runId: 'R' }; },
  'staff workflow run (ownerless)': async (w) => { await w.rest('ops', 'POST', '/workflows/w/run', { runId: 'R', input: { s: 'SECRET-4' } }); return { runId: 'R' }; },
  'legacy staff agent run (record missing, rows present)': async (w) => { await w.rest('ops', 'POST', '/agents/a/run', { runId: 'R', prompt: 'SECRET-5', threadId: 'T' }); await w.runs.deletePrefix('R:input'); return { runId: 'R', threadId: 'T' }; },
  'legacy staff workflow run (record missing, rows present)': async (w) => { await w.rest('ops', 'POST', '/workflows/w/run', { runId: 'R', input: { s: 'SECRET-6' } }); await w.runs.deletePrefix('R:input'); return { runId: 'R' }; },
  'user agent run, owner record unreadable': async (w) => { await w.rest('ayse', 'POST', '/agents/a/run', { runId: 'R', prompt: 'SECRET-7', threadId: 'T' }); w.fail.add('R:input'); return { runId: 'R', threadId: 'T' }; },
};

const SITES: Record<string, (w: W, b: Born) => Promise<{ status: number; body: string } | undefined>> = {
  'REST replay/start agent run': (w, b) => w.rest('mallory', 'POST', '/agents/a/run', { runId: b.runId, prompt: 'x' }),
  'REST read run': (w, b) => w.rest('mallory', 'GET', `/runs/${b.runId}`),
  'REST list runs': (w) => w.rest('mallory', 'GET', '/runs'),
  'REST cancel run': (w, b) => w.rest('mallory', 'POST', `/runs/${b.runId}/cancel?durable=true`, {}),
  'REST workflow run/resume': (w, b) => w.rest('mallory', 'POST', '/workflows/w/run', { runId: b.runId, resume: { approve: { ok: true } } }),
  'REST workflow cancel': (w, b) => w.rest('mallory', 'POST', `/workflows/runs/${b.runId}/cancel`, {}),
  'REST new run on the thread': async (w, b) => (b.threadId ? w.rest('mallory', 'POST', '/agents/a/run', { runId: 'M1', prompt: 'x', threadId: b.threadId }) : undefined),
  'REST read thread': async (w, b) => (b.threadId ? w.rest('mallory', 'GET', `/threads/${b.threadId}/messages`) : undefined),
  'standalone chat-adapter: new turn on the thread': async (w, b) => {
    if (!b.threadId) return undefined;
    const r = await w.chat.request('/agents/a/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: b.threadId, runId: 'M2', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
    return { status: r.status, body: await w.settle(r.text()) };
  },
};

async function foreignState(w: W, b: Born) {
  const saved = [...w.fail]; w.fail.clear();
  const out: Record<string, string> = {};
  for (const k of (await w.runs.listKeys('')).sort()) if (k.startsWith(`${b.runId}:`) || k.includes(`:${b.runId}`) || (b.threadId && k.includes(b.threadId))) out[k] = JSON.stringify(await w.runs.get(k));
  saved.forEach((k) => w.fail.add(k));
  return out;
}

describe('ownership matrix: births x sites (REST and the standalone chat door)', () => {
  it('no stranger reads or changes anything, in any cell', async () => {
    const findings: string[] = [];
    let cells = 0;
    for (const [birth, born] of Object.entries(BIRTHS)) {
      for (const [site, act] of Object.entries(SITES)) {
        const w = world();
        const b = await born(w);
        const before = await foreignState(w, b);
        const res = await act(w, b).catch((e) => ({ status: -1, body: `THREW ${(e as Error).message}` }));
        if (!res) continue;
        cells++;
        await new Promise((r) => setTimeout(r, 5));
        const after = await foreignState(w, b);
        // M1/M2 are the stranger's OWN new runs; everything else must be untouched.
        const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k] && !k.startsWith('M1:') && !k.startsWith('M2:'));
        if (/SECRET-\d/.test(res.body)) findings.push(`${birth} | ${site} | ${res.status} | body has ${res.body.match(/SECRET-\d/)![0]}`);
        if (changed.length) findings.push(`${birth} | ${site} | ${res.status} | changed ${changed.slice(0, 3).join(',')}`);
      }
    }
    expect(cells).toBe(54);
    expect(findings).toEqual([]);
  }, 300_000);
});
