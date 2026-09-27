// SUBJECT-ISOLATION CONFORMANCE — the subject axis walked over the WHOLE route table.
//
// The org axis (cross-org-conformance) and the application axis (client-subject-conformance) walk
// `routeTable`; the subject axis did not — it had hand-written lists of 4-8 routes. A route added
// later that forgot its subject gate stayed green. This file closes that the same way the other two
// did: every route carries an explicit verdict, an unclassified route FAILS, and every route is
// driven by every caller kind against seeded data belonging to someone else.
//
// Two detectors, both independent of how a route decides:
//   1. CONTENT: no attacker response body contains a secret marker of Ayşe's or of an ownerless
//      operator run (and a listing never contains an id the attacker did not type).
//   2. STATE:   no attacker request changes any journal key or thread that belongs to Ayşe or to the
//      operator.
// And one control, so the negatives are not vacuous: the owner, an application naming the owner, and
// an operator DO see the marker on every owned read route.
//
// KNOWN_LEAKS was the measured debt when this walk landed (45 leaks on 6 routes, d611c559), the same
// device as scripts/check-option-docs.mjs's baseline: it may only SHRINK. It is empty since the subject
// view (@gnldev/durable `withSubjectJournal`/`withSubjectMemory`) and the ownerless-record refusal in
// the write gates. A leak fails; so would an entry that stopped leaking.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi, type StreamSurface } from '../src/index.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

type Verdict = 'public' | 'catalog' | 'staff' | 'owned-read' | 'owned-write' | 'undecided';

/** Every route the router reports. A route missing here fails the first test. */
export const VERDICTS: Record<string, { verdict: Verdict; why: string }> = {
  'GET /health': { verdict: 'public', why: 'liveness, no data' },
  'GET /ready': { verdict: 'public', why: 'readiness, no data' },
  'GET /agents': { verdict: 'catalog', why: 'code-defined agent list' },
  'GET /workflows': { verdict: 'catalog', why: 'code-defined workflow list' },
  'GET /openapi.json': { verdict: 'catalog', why: 'schema of the API' },
  'GET /agents/registry': { verdict: 'staff', why: 'deployment governance' },
  'POST /agents/registry/:name/approve': { verdict: 'staff', why: 'deployment governance' },
  'POST /agents/registry/:name/block': { verdict: 'staff', why: 'deployment governance' },
  'GET /usage': { verdict: 'staff', why: 'org-level spend' },
  'GET /runs': { verdict: 'owned-read', why: 'run inventory' },
  'GET /runs/:id': { verdict: 'owned-read', why: 'one run' },
  'GET /threads': { verdict: 'owned-read', why: 'thread inventory' },
  'GET /threads/:id/messages': { verdict: 'owned-read', why: 'a conversation' },
  'GET /workflows/runs': { verdict: 'owned-read', why: 'workflow run inventory' },
  'POST /agents/:name/run': { verdict: 'owned-write', why: 'replays a run / appends to a thread' },
  'POST /agents/:name/stream': { verdict: 'owned-write', why: 'replays a run / appends to a thread' },
  'POST /agents/:name/echo': { verdict: 'owned-write', why: 'a surface: the stream door under another wire format' },
  'POST /agents/:name/resume': { verdict: 'owned-write', why: 'approves a suspended tool call' },
  'POST /runs/:id/cancel': { verdict: 'owned-write', why: 'terminally stops a run' },
  'POST /workflows/:name/run': { verdict: 'owned-write', why: 'replays a workflow run' },
  'POST /workflows/runs/:id/cancel': { verdict: 'owned-write', why: 'terminally stops a workflow run' },
};

/** `<getThreadResource?> | <route> | <caller> | <what>`. Shrinks only — and is empty: keep it so. */
export const KNOWN_LEAKS: readonly string[] = [];

// ── callers: one row per KIND, plus the application in both directions ─────────────────────────
const PRINCIPALS: Record<string, unknown> = {
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] },
  mallory: { kind: 'subject', id: 'u-mallory', roles: ['admin'] },
  nameless: { kind: 'subject', roles: ['admin'] },
  app: { kind: 'application', roles: ['client'] },
  ops: { kind: 'operator', id: 'ops', roles: ['admin', 'platform-admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }), // every role allowed: only the KIND can explain a difference
};
/** `as` = credential, `names` = the subject an application states (query + body). */
type Caller = { label: string; as: string; names?: string };
const ATTACKERS: Caller[] = [
  { label: 'mallory', as: 'mallory' },
  { label: 'mallory+names-ayse', as: 'mallory', names: 'u-ayse' },
  { label: 'nameless', as: 'nameless' },
  { label: 'nameless+names-ayse', as: 'nameless', names: 'u-ayse' },
  { label: 'app-for-mallory', as: 'app', names: 'u-mallory' },
];
const CONTROLS: Caller[] = [
  { label: 'ayse', as: 'ayse' },
  { label: 'app-for-ayse', as: 'app', names: 'u-ayse' },
  { label: 'ops', as: 'ops' },
];

// ── fixture ────────────────────────────────────────────────────────────────────────────────────
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
/** Echoes EVERY user message it was shown, so history handed to the wrong caller surfaces in the body. */
const userText = (prompt: any[]) => (prompt ?? []).filter((m) => m.role === 'user')
  .map((m) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : String(m.content))).join('|');
const echo: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'echo', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: `echo:${userText(prompt)}` }], finishReason: stop, usage, warnings: [] }),
  doStream: async ({ prompt }: any) => ({
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'text-start', id: 't' });
        c.enqueue({ type: 'text-delta', id: 't', delta: `echo:${userText(prompt)}` });
        c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: stop, usage });
        c.close();
      },
    }),
  }),
};
/** Suspends on a tool call the guard sends to a human; answers with the echo once approved. */
const gated: any = {
  ...echo,
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? echo.doGenerate({ prompt })
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: JSON.stringify({ note: userText(prompt) }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] }),
};

function fakeMemory(withOwnerLookup: boolean) {
  const threads = new Map<string, { owner?: string; messages: unknown[] }>();
  const t = (id: string) => threads.get(id) ?? threads.set(id, { messages: [] }).get(id)!;
  const memory: Record<string, unknown> = {
    loadContext: async (id: string, o?: { resourceId?: string }) => { const th = t(id); if (o?.resourceId && !th.owner) th.owner = o.resourceId; return { messages: th.messages }; },
    append: async (id: string, msgs: unknown[]) => { t(id).messages.push(...msgs); },
    getMessages: async (id: string) => threads.get(id)?.messages ?? [],
    listThreads: async (o: { resourceId: string }) => [...threads].filter(([, v]) => v.owner === o.resourceId).map(([id, v]) => ({ id, resourceId: v.owner })),
    listAllThreads: async () => [...threads].map(([id, v]) => ({ id, resourceId: v.owner })),
  };
  if (withOwnerLookup) memory.getThreadResource = async (id: string) => threads.get(id)?.owner;
  return { memory, threads };
}

/**
 * A wire format mounted as a surface (as @gnldev/chat-adapter's `chatSurface` is): it passes the body
 * through, so every probe the stream door gets, the surface gets too. A surface that skipped a gate
 * would show up here as a leak on its own route.
 */
const echoSurface: StreamSurface = {
  path: '/agents/:name/echo',
  decode: (b: any) => ({
    prompt: b.prompt ?? 'x',
    ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
    ...(b.runId !== undefined ? { runId: b.runId } : { turnKey: 'conv:1' }),
    ...(b.resourceId !== undefined ? { resourceId: b.resourceId } : {}),
    ...(b.approvals !== undefined ? { approvals: b.approvals } : {}),
  }),
  encode: (result: any) => new Response(result.textStream.pipeThrough(new TextEncoderStream())),
};

export type Fixture = { api: (r: Request) => Promise<Response>; journal: InMemoryJournal; threads: Map<string, { owner?: string; messages: unknown[] }>; ids: Record<string, string> };

export async function seed(opts: { withOwnerLookup?: boolean; extend?: (api: any) => void } = {}): Promise<Fixture> {
  const journal = new InMemoryJournal();
  const { memory, threads } = fakeMemory(opts.withOwnerLookup ?? true);
  const api: any = createRestApi(
    {
      journal,
      memoryFactory: () => memory,
      agents: {
        a: { model: echo },
        g: {
          model: gated,
          tools: { charge: { description: 'charge', inputSchema: z.object({ note: z.string() }), execute: async () => ({ ok: true }) } },
          guard: async () => ({ action: 'require-approval' as const, reason: 'human' }),
        },
      },
      workflows: { w: { build: () => [{ id: 's1' }], run: async (input: unknown) => ({ echo: input }) } },
    } as never,
    { auth: auth as never, protectionsBanner: false, surfaces: [echoSurface] } as never,
  );
  const post = async (who: string, path: string, body: object) => {
    const r: Response = await api(new Request(`http://x${path}`, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const text = await r.text();
    if (r.status >= 300) throw new Error(`seed ${who} ${path} -> ${r.status} ${text}`);
    return JSON.parse(text) as { runId: string };
  };
  // Returned runIds are used, not the requested ones: the identity layer may namespace them.
  const ids: Record<string, string> = {
    run: (await post('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'AYSE-SECRET-run', threadId: 't-ayse' })).runId,
    sus: (await post('ayse', '/agents/g/run', { runId: 'r-ayse-sus', prompt: 'AYSE-SECRET-suspended' })).runId,
    wf: (await post('ayse', '/workflows/w/run', { runId: 'wf-ayse', input: { note: 'AYSE-SECRET-workflow' } })).runId,
    // S1 shape: staff starts work for nobody — ownerless, and not an end user's to read.
    opsRun: (await post('ops', '/agents/a/run', { runId: 'r-ops', prompt: 'OPS-SECRET-run', threadId: 't-ops' })).runId,
    opsSus: (await post('ops', '/agents/g/run', { runId: 'r-ops-sus', prompt: 'OPS-SECRET-suspended' })).runId,
    thread: 't-ayse', opsThread: 't-ops',
  };
  // The workflow run REGISTRY is written by the step engine, not by a `run:` stub; seeded directly (as
  // cross-org-conformance does) so `GET /workflows/runs` and its cancel have a record to differ about.
  await journal.put(`wfrun:${ids.wf}`, { runId: ids.wf, workflowName: 'w', status: 'suspended', at: 1 });
  opts.extend?.(api);
  return { api, journal, threads, ids };
}

// ── probes: every route × every foreign target it can address ────────────────────────────────
type Probe = { path: string; method: string; body?: Record<string, unknown>; supplied: string[] };
function probesFor(method: string, path: string, ids: Record<string, string>): Probe[] {
  const runTargets = [ids.run!, ids.sus!, ids.opsRun!, ids.opsSus!];
  const out: Probe[] = [];
  const add = (p: string, body?: Record<string, unknown>) => out.push({ method, path: p, body, supplied: [p, JSON.stringify(body ?? {})] });
  if (path === '/threads/:id/messages') { for (const t of [ids.thread!, ids.opsThread!]) add(`/threads/${t}/messages`); return out; }
  if (path === '/workflows/runs/:id/cancel') { add(`/workflows/runs/${ids.wf}/cancel`, {}); return out; }
  // `?durable=true` on cancel: without it a cancel of a finished run writes nothing, and the STATE
  // detector would have nothing to see.
  if (path.includes(':id')) { for (const r of runTargets) add(path.replace(':id', r) + (path.endsWith('/cancel') ? '?durable=true' : ''), method === 'GET' ? undefined : {}); return out; }
  if (path === '/agents/:name/resume') { add('/agents/g/resume', { runId: ids.sus, approvals: { c1: true } }); add('/agents/g/resume', { runId: ids.opsSus, approvals: { c1: true } }); return out; }
  if (path === '/agents/:name/run' || path === '/agents/:name/stream' || path === '/agents/:name/echo') {
    const p = path.replace(':name', 'a');
    add(p, { runId: ids.run, prompt: 'x' }); add(p, { runId: ids.opsRun, prompt: 'x' });
    // A FRESH run id: without one the route answers 400 before any thread gate is asked, and this
    // probe measured nothing (found by mutation — removing the ownerless-thread gate stayed green).
    add(p, { runId: 'r-probe-new', prompt: 'x', threadId: ids.thread }); add(p, { runId: 'r-probe-new-2', prompt: 'x', threadId: ids.opsThread });
    return out;
  }
  if (path === '/workflows/:name/run') { add('/workflows/w/run', { runId: ids.wf, input: {} }); return out; }
  add(path.replace(':name', 'a'), method === 'GET' ? undefined : {});
  return out;
}

async function send(f: Fixture, probe: Probe, who: Caller) {
  let url = `http://x${probe.path}`;
  let body = probe.body;
  if (who.names) { url += `${url.includes('?') ? '&' : '?'}resourceId=${who.names}`; if (body) body = { ...body, resourceId: who.names }; }
  const init: RequestInit = { method: probe.method, headers: { authorization: `Bearer ${who.as}`, 'content-type': 'application/json' } };
  if (probe.method !== 'GET') init.body = JSON.stringify(body ?? {});
  const res: Response = await Promise.race([f.api(new Request(url, init)),
    new Promise<Response>((r) => setTimeout(() => r(new Response('<<no response>>', { status: 599 })), 4000))]);
  const text = await Promise.race([res.text().catch(() => '<<unreadable>>'), new Promise<string>((r) => setTimeout(() => r('<<stream>>'), 1500))]);
  return { status: res.status, body: text };
}

/** Everything that belongs to Ayşe or to the operator: journal keys naming their ids, and their threads. */
async function foreignState(f: Fixture) {
  const own = Object.values(f.ids);
  const out: Record<string, string> = {};
  for (const k of (await f.journal.listKeys('')).sort()) if (own.some((id) => k.includes(id))) out[k] = JSON.stringify(await f.journal.get(k));
  for (const t of [f.ids.thread!, f.ids.opsThread!]) out[`thread:${t}`] = JSON.stringify(f.threads.get(t) ?? null);
  return out;
}

const SECRET = /AYSE-SECRET|OPS-SECRET/;
export type Finding = { route: string; caller: string; probe: string; status: number; what: string };

export async function walk(opts: { withOwnerLookup?: boolean; extend?: (api: any) => void } = {}) {
  const inv = await seed(opts);
  const leaks: Finding[] = [];
  const controls: Finding[] = [];
  const grid: Record<string, Record<string, string>> = {};
  for (const r of inv.api.routeTable as { method: string; path: string }[]) {
    const key = `${r.method} ${r.path}`;
    const v = VERDICTS[key]?.verdict ?? 'undecided';
    grid[key] = {};
    for (const who of [...ATTACKERS, ...CONTROLS]) {
      const statuses: number[] = [];
      let sawSecret = false;
      for (const probe of probesFor(r.method, r.path, inv.ids)) {
        const f = await seed(opts); // fresh per probe: a cancel or approval must not poison the next
        const before = await foreignState(f);
        const { status, body } = await send(f, probe, who);
        statuses.push(status);
        await new Promise((r) => setTimeout(r, 5)); // let fire-and-forget journal writes land before comparing
        const after = await foreignState(f);
        const tag = `${probe.method} ${probe.path} ${probe.body ? JSON.stringify(probe.body) : ''}`.trim();
        // "saw" = the secret, or (for listings) one of the seeded ids the probe did not type.
        const unsupplied = Object.values(f.ids).filter((id) => body.includes(id) && !probe.supplied.some((x) => x.includes(id)));
        if (status < 300 && (SECRET.test(body) || unsupplied.length)) sawSecret = true;
        if (!ATTACKERS.includes(who)) continue;
        if (SECRET.test(body)) leaks.push({ route: key, caller: who.label, probe: tag, status, what: `body contains ${body.match(SECRET)![0]}` });
        const namedIds = unsupplied;
        if (status < 300 && namedIds.length) leaks.push({ route: key, caller: who.label, probe: tag, status, what: `body lists ${namedIds.join(',')}` });
        const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
        if (changed.length) leaks.push({ route: key, caller: who.label, probe: tag, status, what: `changed ${changed.slice(0, 3).join(',')}` });
        if (v === 'staff' && who.as !== 'app' && status !== 403) leaks.push({ route: key, caller: who.label, probe: tag, status, what: 'staff route served a subject' });
      }
      grid[key]![who.label] = `${[...new Set(statuses)].join('/')}${sawSecret ? '*' : ''}`;
      // CONTROL: the owner / application-for-owner / operator must see the secret on owned reads.
      if (v === 'owned-read' && CONTROLS.includes(who) && !sawSecret) {
        controls.push({ route: key, caller: who.label, probe: '-', status: statuses[0]!, what: 'control never saw the owner\'s data' });
      }
    }
  }
  return { inv, leaks, controls, grid };
}

export function printGrid(title: string, grid: Record<string, Record<string, string>>) {
  const cols = [...ATTACKERS, ...CONTROLS].map((c) => c.label);
  // eslint-disable-next-line no-console
  console.log(`\n[${title}]  status set per caller, * = body carried a secret marker\n`
    + ['route'.padEnd(36) + cols.map((c) => c.padEnd(20)).join(''),
      ...Object.entries(grid).map(([k, row]) => k.padEnd(36) + cols.map((c) => (row[c] ?? '').padEnd(20)).join(''))].join('\n'));
}

describe('subject-isolation conformance over the whole route table', () => {
  it('every route has a verdict, and no verdict is stale or undecided', async () => {
    const { api } = await seed();
    const inventory = (api as any).routeTable.map((r: { method: string; path: string }) => `${r.method} ${r.path}`);
    expect(inventory.length).toBeGreaterThan(15);
    expect(inventory.filter((k: string) => !(k in VERDICTS)), 'unclassified route: add it to VERDICTS with a reason').toEqual([]);
    expect(Object.keys(VERDICTS).filter((k) => !inventory.includes(k)), 'stale verdict').toEqual([]);
    expect(Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'undecided')).toEqual([]);
  });

  for (const withOwnerLookup of [true, false]) {
    it(`no attacker reaches Ayşe's or the operator's data (Memory ${withOwnerLookup ? 'with' : 'WITHOUT'} getThreadResource)`, async () => {
      const { leaks, controls, grid } = await walk({ withOwnerLookup });
      expect(controls, 'a control never saw the data — the negatives would be vacuous').toEqual([]);
      // A state change is one fact: WHICH key the engine wrote first depends on write order.
      const seen = [...new Set(leaks.map((l) => `${withOwnerLookup} | ${l.route} | ${l.caller} | ${l.what.startsWith('changed ') ? 'changes foreign state' : l.what}`))].sort();
      const known = KNOWN_LEAKS.filter((k) => k.startsWith(`${withOwnerLookup} |`)).slice().sort();
      if (seen.join('\n') !== known.join('\n')) {
        printGrid(`server, getThreadResource=${withOwnerLookup}`, grid);
        // eslint-disable-next-line no-console
        console.log(leaks.map((l) => `LEAK [lookup=${withOwnerLookup}] ${l.route} as ${l.caller}: ${l.probe} -> ${l.status} ${l.what}`).join('\n'));
      }
      expect(seen.filter((k) => !known.includes(k)), 'a NEW leak — not in KNOWN_LEAKS').toEqual([]);
      expect(known.filter((k) => !seen.includes(k)), 'no longer leaks — delete it from KNOWN_LEAKS').toEqual([]);
    }, 300_000);
  }
});
