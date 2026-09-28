// THE CONFORMANCE REGISTRY (ADR-0002 point 7) — a release gate.
//
//   BIRTHS  — every way a run comes to exist (engine starters and the doors that start runs of their own);
//   STATES  — the record states that used to leak: normal, ownerless, record missing with rows present,
//             owner record unreadable;
//   DOORS   — every exported door factory, each driven through ONE small helper, with its operations;
//   CALLERS — owner, another user (also naming the owner), another organization's user and staff, staff,
//             an application naming the owner / naming another user, and an unknown caller (also naming
//             the owner).
//
// Invariant, for every BIRTH x STATE x DOOR-OPERATION x attacking CALLER: no secret of the target run in
// the response, no target id in a listing the attacker did not type it into, and no change to any key
// of the target run or its thread. Controls (the owner and staff on a normal run, staff on an ownerless
// one) are recorded too, so the negatives are not vacuous: every door must let a control see the secret
// at least once, and the REST read routes must let it every time.
//
// COMPLETE AND SELF-CHECKING, like subject-isolation-conformance's "unclassified route FAILS":
//   - every call site of the engine's one start point (claimRunOwner / inheritRunOwner / admitRun) in
//     packages/*/src is mapped to the births that exercise it — a new site FAILS;
//   - every exported run starter of @gnldev/durable and of a createGnl instance is a BIRTH or is named in
//     NOT_A_BIRTH with a reason — an unlisted one FAILS;
//   - every exported door factory (`create*` / `serve*` / `*Surface` / `pipe*Stream` in any package
//     index) is a DOOR here or is named in NOT_A_DOOR with a reason — an unlisted one FAILS.
//
// No finding is encoded in this file; the lists are the whole input.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as durable from '@gnldev/durable';
import {
  InMemoryStorage, createGnl, scopeConfigToOrg, runDurable, streamDurable, createBatch, createAgentTool,
  forkRun, rolloverRun, replayRun, runNetwork, toJournal, runOwnerOf, type Caller,
} from '@gnldev/durable';
import { engineCallerOf, type Principal } from '@gnldev/auth';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { stepCountIs } from 'ai';
import { createRestApi } from '../src/index.js';
import { createChatRoute } from '../../chat-adapter/src/chat-route.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { createStudioApi } from '../../studio/src/server.js';
import { enqueue, createWorker } from '../../queue/src/index.js';
import { emit, createConsumer } from '../../events/src/index.js';
import { scheduleWorkflow, pollScheduler } from '../../scheduler/src/index.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const PACKAGES = join(__dirname, '..', '..');

// ── models ──────────────────────────────────────────────────────────────────────────────────────
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
/** Echoes EVERY user message it was shown, so history handed to the wrong caller surfaces in the body. */
const userText = (prompt: any[]) => (prompt ?? []).filter((m) => m.role === 'user')
  .map((m) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : String(m.content))).join('|');
const echo: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'echo', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: `echo:${userText(prompt)}` }], finishReason: stop, usage, warnings: [] }),
  doStream: async ({ prompt }: any) => ({
    stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
      c.enqueue({ type: 'text-delta', id: 't', delta: `echo:${userText(prompt)}` }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: stop, usage }); c.close();
    } }),
  }),
};
/** Calls the `helper` agent tool once with the user's text, then answers. */
const delegating: any = {
  ...echo,
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? echo.doGenerate({ prompt })
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'helper', input: JSON.stringify({ task: userText(prompt) }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] }),
};
const router: any = { ...echo, doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: JSON.stringify({ action: 'final', answer: `net:${userText(prompt)}` }) }], finishReason: stop, usage, warnings: [] }) };

// ── callers ─────────────────────────────────────────────────────────────────────────────────────
const ORG = 'acme';
const OTHER_ORG = 'globex';
type CallerKey =
  | 'owner' | 'other-user' | 'other-user-naming-owner' | 'other-org-user' | 'staff' | 'other-org-staff'
  | 'app-for-owner' | 'app-for-other' | 'unknown' | 'unknown-naming-owner';
/** A caller is what a door's host decided about a request: a principal, and the user an application names. */
type Who = { principal: Principal; names?: string };
const P = {
  ayse: { kind: 'subject', id: 'u-ayse', orgId: ORG, roles: ['admin'] },
  mallory: { kind: 'subject', id: 'u-mallory', orgId: ORG, roles: ['admin'] },
  eve: { kind: 'subject', id: 'u-eve', orgId: OTHER_ORG, roles: ['admin'] },
  ops: { kind: 'operator', id: 'ops', orgId: ORG, roles: ['admin'] },
  ops2: { kind: 'operator', id: 'ops2', orgId: OTHER_ORG, roles: ['admin'] },
  app: { kind: 'application', id: 'app', orgId: ORG, roles: ['client'] },
  nameless: { kind: 'subject', orgId: ORG, roles: ['admin'] },
} as unknown as Record<string, Principal>;
const CALLERS: Record<CallerKey, Who> = {
  owner: { principal: P.ayse! },
  'other-user': { principal: P.mallory! },
  'other-user-naming-owner': { principal: P.mallory!, names: 'u-ayse' },
  'other-org-user': { principal: P.eve! },
  staff: { principal: P.ops! },
  'other-org-staff': { principal: P.ops2! },
  'app-for-owner': { principal: P.app!, names: 'u-ayse' },
  'app-for-other': { principal: P.app!, names: 'u-mallory' },
  unknown: { principal: P.nameless! },
  'unknown-naming-owner': { principal: P.nameless!, names: 'u-ayse' },
};
const orgOf = (w: Who) => (w.principal as { orgId?: string }).orgId;

// ── states ──────────────────────────────────────────────────────────────────────────────────────
type State = 'normal' | 'ownerless' | 'record-missing-rows-present' | 'unreadable';
const STATES: State[] = ['normal', 'ownerless', 'record-missing-rows-present', 'unreadable'];
/** Who starts the target run in each state. A lost or unreadable record hides whoever that was. */
const BORN_BY: Record<State, CallerKey> = { normal: 'owner', ownerless: 'staff', 'record-missing-rows-present': 'staff', unreadable: 'owner' };
/** Callers that may see the target (checked as controls), per state. Everyone else is an attacker. */
const CONTROLS: Record<State, CallerKey[]> = {
  normal: ['owner', 'app-for-owner', 'staff'],
  ownerless: ['staff'],
  'record-missing-rows-present': ['staff'],
  unreadable: [],
};
/** Callers neither attacking nor controlling: the data is theirs, but an unreadable record may refuse them. */
const UNCHECKED: Record<State, CallerKey[]> = { normal: [], ownerless: [], 'record-missing-rows-present': [], unreadable: ['owner', 'app-for-owner', 'staff'] };

// ── the world ───────────────────────────────────────────────────────────────────────────────────
const SECRET = 'SECRET-OF-THE-TARGET';
function world() {
  const storage = new InMemoryStorage();
  const runs = storage.runs as any;
  const fail = new Set<string>();
  const g = runs.get.bind(runs);
  runs.get = async (k: string) => { if ([...fail].some((f) => k.endsWith(f))) throw new Error('EIO (injected)'); return g(k); };
  const config: any = {
    storage,
    agents: {
      a: { model: echo },
    },
    workflows: {
      w: workflow<any>().then(step('draft', async ({ input }: any) => `draft:${input?.s ?? ''}`)).then(waitForResume<{ ok: boolean }>('approve')),
    },
    networks: { n: { router, agents: ['a'] } },
  };
  const orgs = new Map<string, any>();
  const scoped = (org: string) => {
    let s = orgs.get(org);
    if (!s) orgs.set(org, (s = scopeConfigToOrg(config, org)));
    return s as { config: any; journal: any };
  };
  const gnls = new Map<string, any>();
  const gnlOf = (org: string) => gnls.get(org) ?? gnls.set(org, createGnl(scoped(org).config)).get(org);
  return { storage, runs, fail, config, scoped, gnlOf, lazy: new Map<string, unknown>() };
}
type W = ReturnType<typeof world>;
/** The target a birth produced: its run id, its thread when it has one, and what else belongs to it. */
type Target = { runId: string; threadId?: string; also?: string[] };
/** The same helper everywhere a stream is read: an unfinished stream must not stall the table. */
const settle = (p: Promise<string>) => Promise.race([p, new Promise<string>((res) => setTimeout(() => res('<<stream>>'), 1000))]);
const lazy = <T>(w: W, key: string, make: () => T): T => (w.lazy.has(key) ? w.lazy.get(key) as T : (w.lazy.set(key, make()), w.lazy.get(key) as T));

// ── door helpers: ONE per door. After ADR-0002 phase 2 lands, only these change. ────────────────
type Res = { status: number; body: string };
const asRes = async (r: Response): Promise<Res> => ({ status: r.status, body: await settle(r.text()) });

/** @gnldev/server — `createRestApi(config, { auth })`. The principal is the credential. */
function restDoor(w: W) {
  return lazy(w, 'rest', () => {
    const byToken = new Map<string, Principal>(Object.entries(P));
    const auth = { authenticate: (r: Request) => byToken.get(r.headers.get('authorization')?.replace('Bearer ', '') ?? '') ?? null, authorize: () => ({ allow: true }) };
    const api = createRestApi(w.config, { auth: auth as never, protectionsBanner: false }) as (r: Request) => Promise<Response>;
    const token = (who: Who) => Object.entries(P).find(([, p]) => p === who.principal)![0];
    return async (who: Who, method: string, path: string, body?: Record<string, unknown>): Promise<Res> => {
      let url = path;
      let b = body;
      if (who.names) { url += `${url.includes('?') ? '&' : '?'}resourceId=${who.names}`; if (b) b = { ...b, resourceId: who.names }; }
      return asRes(await api(new Request(`http://x${url}`, { method, headers: { authorization: `Bearer ${token(who)}`, 'content-type': 'application/json' }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) })));
    };
  });
}

/**
 * The identity the standalone doors take TODAY (`GnlIdentity`, `McpCallerIdentity`): a resourceId and an
 * org. It cannot say "staff" — that is ADR-0002 point 1. Used by chatDoor/aguiDoor/mcpDoor only; after
 * agent D lands they take the principal itself (`identify: () => who.principal`).
 */
function legacyIdentity(who: Who): { resourceId?: string; orgId?: string } {
  const c = engineCallerOf(who.principal, who.names);
  return { ...(c.kind === 'user' ? { resourceId: c.id } : {}), ...(orgOf(who) ? { orgId: orgOf(who) } : {}) };
}

/** @gnldev/chat-adapter, standalone — no server gate in front of the engine. */
function chatDoor(w: W, who: Who) {
  const key = `chat:${JSON.stringify(who)}`;
  const app = lazy(w, key, () => createChatRoute(w.config, { identity: () => legacyIdentity(who) } as never) as any);
  return async (body: Record<string, unknown>): Promise<Res> =>
    asRes(await app.request('/agents/a/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

/** @gnldev/agui, standalone. */
function aguiDoor(w: W, who: Who) {
  const key = `agui:${JSON.stringify(who)}`;
  const handler = lazy(w, key, () => createAguiRoute(w.config, { identity: () => legacyIdentity(who) } as never) as (r: Request) => Promise<Response>);
  return async (body: Record<string, unknown>): Promise<Res> =>
    asRes(await handler(new Request('http://x/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
}

/** @gnldev/mcp — `createMcpServer({ tools, journal, identity })`; a tool that returns what it was given. */
const mcpTools = { note: { description: 'n', inputSchema: { type: 'object', properties: { s: { type: 'string' } } }, execute: async (a: any) => ({ noted: a.s }) } };
function mcpDoor(w: W, who: Who | undefined) {
  const key = `mcp:${JSON.stringify(who ?? null)}`;
  const server = lazy(w, key, () => createMcpServer({
    tools: mcpTools as never,
    journal: w.storage.runs as never,
    ...(who ? { identity: () => legacyIdentity(who) } : {}),
  } as never) as any);
  return async (args: Record<string, unknown>, idempotencyKey: string): Promise<Res> => {
    const r = await server.callTool({ name: 'note', arguments: args, idempotencyKey, caller: {} });
    return { status: r?.isError ? 400 : 200, body: JSON.stringify(r) };
  };
}

/** @gnldev/studio — a staff console (`createStudioApi`), over the same storage and engine. */
function studioDoor(w: W) {
  return lazy(w, 'studio', () => {
    const byToken = new Map<string, Principal>(Object.entries(P));
    const auth = { authenticate: (r: Request) => byToken.get(r.headers.get('authorization')?.replace('Bearer ', '') ?? '') ?? null, authorize: (p: unknown) => (p ? { allow: true } : { allow: false, status: 401 }) };
    const api = createStudioApi({ reader: toJournal(w.storage.runs) as never, gnl: createGnl(w.config) as never, auth: auth as never } as never) as unknown as (r: Request) => Promise<Response>;
    const token = (who: Who) => Object.entries(P).find(([, p]) => p === who.principal)![0];
    return async (who: Who, method: string, path: string, body?: unknown): Promise<Res> =>
      asRes(await api(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token(who)}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })));
  });
}

/** The engine called directly (`gnl.run`, `resumeRun`, …) with the Caller a door would have mapped. */
function engineDoor(w: W, who: Who) {
  const org = orgOf(who) ?? ORG;
  return { gnl: w.gnlOf(org), journal: w.scoped(org).journal, caller: engineCallerOf(who.principal, who.names) as Caller };
}

/** @gnldev/queue — a job is enqueued for the owner the host decided; the handler follows the README. */
function queueDoor(w: W) {
  return lazy(w, 'queue', () => {
    const results: unknown[] = [];
    const worker = createWorker(w.storage, {
      // "continue this run in the background": the run named in the payload, for the job's owner.
      cont: async (payload: any, ctx) => { results.push(await runDurable({ runId: payload.runId, journal: ctx.journal as never, model: echo, prompt: payload.prompt, resourceId: ctx.resourceId })); },
      // a job's own run, as the README writes it.
      own: async (payload: any, ctx) => { results.push(await runDurable({ runId: ctx.runId, journal: ctx.journal as never, model: echo, prompt: payload.prompt, resourceId: ctx.resourceId })); },
    }, { maxAttempts: 1 });
    const ownerOf = (who: Who) => { const c = engineCallerOf(who.principal, who.names); return { ...(c.kind === 'user' ? { resourceId: c.id } : {}), ...(orgOf(who) ? { orgId: orgOf(who) } : {}) }; };
    return async (who: Who, type: 'cont' | 'own', payload: unknown, id?: string): Promise<Res> => {
      results.length = 0;
      const jobId = await enqueue(w.storage.work!, type, payload, { ...ownerOf(who), ...(id ? { id } : {}) });
      await worker.drain();
      return { status: 200, body: JSON.stringify({ jobId, results }) };
    };
  });
}

/** @gnldev/events — an event for the owner the host decided; the consumer continues the named run. */
function eventsDoor(w: W) {
  return lazy(w, 'events', () => {
    const results: unknown[] = [];
    const consumer = createConsumer(w.storage.work!, 'topic', async (payload: any, meta: any) => {
      const journal = meta.orgId ? w.scoped(meta.orgId).journal : toJournal(w.storage.runs);
      results.push(await runDurable({ runId: payload.runId, journal, model: echo, prompt: payload.prompt, resourceId: meta.resourceId }));
    }, { name: 'c', maxAttempts: 1 });
    return async (who: Who, payload: unknown): Promise<Res> => {
      results.length = 0;
      const c = engineCallerOf(who.principal, who.names);
      await emit(w.storage.work!, 'topic', payload, { ...(c.kind === 'user' ? { resourceId: c.id } : {}), ...(orgOf(who) ? { orgId: orgOf(who) } : {}) } as never);
      await consumer.poll();
      return { status: 200, body: JSON.stringify(results) };
    };
  });
}

/** @gnldev/scheduler — a trigger for the owner the host decided, fired once. */
function schedulerDoor(w: W) {
  return async (who: Who, id: string, input: unknown): Promise<Res> => {
    const c = engineCallerOf(who.principal, who.names);
    const journal = toJournal(w.storage.runs);
    const tid = await scheduleWorkflow(journal, { id, name: 'w', input, at: 0, ...(c.kind === 'user' ? { resourceId: c.id } : {}), ...(orgOf(who) ? { orgId: orgOf(who) } : {}) });
    const r = await pollScheduler(journal, w.gnlOf(ORG), Date.now(), { runnerForOrg: (org: string) => w.gnlOf(org) } as never);
    return { status: 200, body: JSON.stringify({ tid, r }) };
  };
}

// ── births ──────────────────────────────────────────────────────────────────────────────────────
type Birth = {
  /** Which start-point call sites (file under packages/) this birth runs through. */
  sites: string[];
  /** Exported starters it covers (durable exports, or `gnl.<method>`). */
  starters: string[];
  /** Callers it cannot be started for through its own API today, with why. */
  cannot?: Partial<Record<CallerKey, string>>;
  start: (w: W, who: Who) => Promise<Target>;
};
const ctxOf = (w: W, who: Who) => engineDoor(w, who);
const tool1 = () => Object.assign({ description: 'd', inputSchema: { type: 'object' }, execute: async (i: any) => `did:${i.s}` }, { idempotent: true });

const BIRTHS: Record<string, Birth> = {
  'agent: runDurable': {
    sites: ['durable/src/run.ts'], starters: ['runDurable'],
    start: async (w, who) => { const e = ctxOf(w, who); await runDurable({ runId: 'tgtA', journal: e.journal, model: echo, prompt: SECRET, threadId: 'tgtT', caller: e.caller } as never); return { runId: 'tgtA', threadId: 'tgtT' }; },
  },
  'agent: streamDurable': {
    sites: ['durable/src/run.ts'], starters: ['streamDurable'],
    start: async (w, who) => { const e = ctxOf(w, who); const r: any = await streamDurable({ runId: 'tgtS', journal: e.journal, model: echo, prompt: SECRET, threadId: 'tgtT', caller: e.caller } as never); await r.text; return { runId: 'tgtS', threadId: 'tgtT' }; },
  },
  'agent: gnl.run': {
    sites: ['durable/src/run.ts'], starters: ['createGnl', 'gnl.run'],
    start: async (w, who) => { const e = ctxOf(w, who); await e.gnl.run('a', { runId: 'tgtG', prompt: SECRET, threadId: 'tgtT', caller: e.caller }); return { runId: 'tgtG', threadId: 'tgtT' }; },
  },
  'agent: gnl.stream': {
    sites: ['durable/src/run.ts'], starters: ['gnl.stream'],
    start: async (w, who) => { const e = ctxOf(w, who); const r: any = await e.gnl.stream('a', { runId: 'tgtGS', prompt: SECRET, threadId: 'tgtT', caller: e.caller }); await r.text; return { runId: 'tgtGS', threadId: 'tgtT' }; },
  },
  'workflow: gnl.runWorkflow': {
    sites: ['durable/src/registry.ts'], starters: ['gnl.runWorkflow'],
    start: async (w, who) => { const e = ctxOf(w, who); await e.gnl.runWorkflow('w', { s: SECRET }, { runId: 'tgtW', caller: e.caller }); return { runId: 'tgtW' }; },
  },
  'network: gnl.runNetwork': {
    sites: ['durable/src/registry.ts'], starters: ['gnl.runNetwork'],
    start: async (w, who) => { const e = ctxOf(w, who); await e.gnl.runNetwork('n', { runId: 'tgtN', task: SECRET, caller: e.caller }); return { runId: 'tgtN' }; },
  },
  'network: runNetwork (the exported primitive)': {
    sites: [], starters: ['runNetwork'],
    start: async (w, who) => {
      const e = ctxOf(w, who);
      await runNetwork({ runId: 'tgtNP', journal: e.journal, task: SECRET, routerModel: router, agents: { a: { description: 'a', run: async (task: string) => ({ text: `a:${task}` }) } } } as never);
      return { runId: 'tgtNP' };
    },
  },
  'batch item': {
    sites: ['durable/src/batch.ts'], starters: ['createBatch'],
    start: async (w, who) => {
      const e = ctxOf(w, who);
      const b = createBatch(e.journal, { tool: tool1() as never, toolName: 'echo', itemKey: (i: any) => i.id, caller: e.caller, onDuplicate: 'skip' } as never);
      const items = [{ id: 'tgtB', s: SECRET }];
      const plan: any = await b.preflight('tgtb', items as never);
      await b.run('tgtb', items as never, { planToken: plan.token });
      return { runId: 'batch:tgtb:tgtB' };
    },
  },
  'agent-tool child': {
    sites: ['durable/src/run.ts'], starters: ['createAgentTool', 'runSubAgent'],
    start: async (w, who) => {
      const e = ctxOf(w, who);
      const helper = createAgentTool({ journal: e.journal, model: echo } as never);
      await runDurable({ runId: 'tgtP', journal: e.journal, model: delegating, tools: { helper }, prompt: SECRET, stopWhen: stepCountIs(4), caller: e.caller } as never);
      const childId = (await e.journal.listKeys('')).find((k: string) => k.endsWith(':input') && k !== 'tgtP:input')!.slice(0, -':input'.length);
      return { runId: childId, also: ['tgtP'] };
    },
  },
  fork: {
    sites: ['durable/src/time-travel.ts'], starters: ['forkRun'],
    start: async (w, who) => { const e = ctxOf(w, who); await runDurable({ runId: 'tgtFs', journal: e.journal, model: echo, prompt: SECRET, caller: e.caller } as never); await forkRun(e.journal, 'tgtFs', 1, 'tgtF'); return { runId: 'tgtF', also: ['tgtFs'] }; },
  },
  rollover: {
    sites: ['durable/src/rollover.ts'], starters: ['rolloverRun'],
    start: async (w, who) => { const e = ctxOf(w, who); await runDurable({ runId: 'tgtRs', journal: e.journal, model: echo, prompt: SECRET, caller: e.caller } as never); return { runId: (await rolloverRun(e.journal, 'tgtRs')).newRunId, also: ['tgtRs'] }; },
  },
  replay: {
    sites: ['durable/src/run.ts'], starters: ['replayRun'],
    start: async (w, who) => { const e = ctxOf(w, who); await runDurable({ runId: 'tgtXs', journal: e.journal, model: echo, prompt: SECRET, caller: e.caller } as never); return { runId: (await replayRun({ journal: e.journal, runId: 'tgtXs', newRunId: 'tgtX', model: echo } as never)).newRunId, also: ['tgtXs'] }; },
  },
  'MCP-derived run': {
    sites: ['mcp/src/server.ts'], starters: [],
    cannot: { staff: 'mcp `identity` has no way to say staff (ADR-0002 point 1; agent D)' },
    start: async (w, who) => {
      const before = new Set(await w.storage.runs.listKeys!(''));
      await mcpDoor(w, who)({ s: SECRET }, 'tgtM');
      const k = (await w.storage.runs.listKeys!('')).find((x) => !before.has(x) && x.endsWith(':input'))!;
      return { runId: k.replace(/^org:[^:]+:/, '').slice(0, -':input'.length) };
    },
  },
  'studio workflow fork': {
    sites: ['studio/src/server.ts'], starters: [],
    start: async (w, who) => {
      const e = ctxOf(w, who);
      await e.gnl.runWorkflow('w', { s: SECRET }, { runId: 'tgtVs', caller: e.caller });
      const r = await studioDoor(w)(CALLERS.staff, 'POST', '/workflows/w/runs/tgtVs/fork', { upto: 1, newRunId: 'tgtV' });
      if (r.status !== 200) throw new Error(`studio fork: ${r.status} ${r.body}`);
      return { runId: 'tgtV', also: ['tgtVs'] };
    },
  },
  'queue job run': {
    sites: ['durable/src/run.ts'], starters: [],
    cannot: { staff: 'a job owner is a resourceId: the queue cannot say staff (ADR-0002 point 5a; agent B)' },
    start: async (w, who) => {
      const r = JSON.parse((await queueDoor(w)(who, 'own', { prompt: SECRET }, 'tgtQ')).body);
      return { runId: `job:${r.jobId}` };
    },
  },
  'scheduler fire': {
    sites: ['durable/src/registry.ts'], starters: [],
    cannot: { staff: 'a trigger owner is a resourceId: the scheduler cannot say staff (agent B)' },
    start: async (w, who) => {
      await schedulerDoor(w)(who, 'tgtC', { s: SECRET });
      const k = (await w.storage.runs.listKeys!('')).find((x) => x.includes('sched:') && x.endsWith(':input'))!;
      return { runId: k.replace(/^org:[^:]+:/, '').slice(0, -':input'.length) };
    },
  },
};

/** Exported starters that are NOT a birth, with why. A new starter must land in BIRTHS or here. */
const NOT_A_BIRTH: Record<string, string> = {
  resumeRun: 'continues an existing run (engine door op "resumeRun"), never starts one',
  admitRun: 'THE entry every birth calls, not a birth itself',
  admitThreadRun: 'the thread gate',
  decideRun: 'a decision', runOwnerOf: 'a reading', isRealRun: 'a reading', runStarted: 'a reading',
  runCanceled: 'a reading', runCompensated: 'a reading', summarizeRun: 'a reading', runIdOfKey: 'key parsing',
  runIdentity: 'builds an identity value', forkRunId: 'derives an id', rolloverKey: 'derives a key',
  runBusyMessage: 'an error message', streamFinishError: 'an error helper',
  cancelAgentRun: 'stops a run (REST/studio cancel op)', compensateRun: 'unwinds a run (studio op)', purgeRun: 'erasure',
  runMigrationCheck: 'schema migration, not a run', runRuleLadder: 'semantic rules, not a run',
  createProcessorCtx: 'a processor context', createRetentionSweeper: 'erasure worker', createSuggestions: 'suggestion store',
  createPollLoop: 'a timer', createBoundedUsageCache: 'a cache',
  'gnl.agent': 'looks an agent config up', 'gnl.listWorkflows': 'catalog', 'gnl.listNetworks': 'catalog',
};

// ── doors and their operations ──────────────────────────────────────────────────────────────────
type OpKind = 'read' | 'list' | 'write';
type Op = { kind: OpKind; act: (w: W, t: Target, who: Who) => Promise<Res | undefined> };
type Door = {
  /** The exported factories this door stands for. */
  factories: string[];
  /** Callers this door cannot express today, with why (the cell is reported as inexpressible, not skipped silently). */
  cannot?: Partial<Record<CallerKey, string>>;
  ops: Record<string, Op>;
};
const withThread = (t: Target, f: (thread: string) => Promise<Res>) => (t.threadId ? f(t.threadId) : Promise.resolve(undefined));
const LEGACY_IDENTITY = 'the door takes { resourceId, orgId } today: it cannot say staff or name a user for an application (ADR-0002 point 1; agent D)';
const RESOURCE_ID_ONLY = 'the owner is a resourceId: staff and "an application naming" are not expressible (agent B)';

const DOORS: Record<string, Door> = {
  rest: {
    factories: ['createRestApi', 'chatSurface', 'aguiSurface'],
    ops: {
      'read run': { kind: 'read', act: (w, t, who) => restDoor(w)(who, 'GET', `/runs/${encodeURIComponent(t.runId)}`) },
      'list runs': { kind: 'list', act: (w, _t, who) => restDoor(w)(who, 'GET', '/runs') },
      'list workflow runs': { kind: 'list', act: (w, _t, who) => restDoor(w)(who, 'GET', '/workflows/runs') },
      'list threads': { kind: 'list', act: (w, t, who) => withThread(t, () => restDoor(w)(who, 'GET', '/threads')) },
      'read thread': { kind: 'read', act: (w, t, who) => withThread(t, (th) => restDoor(w)(who, 'GET', `/threads/${th}/messages`)) },
      'start agent run on the id': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', '/agents/a/run', { runId: t.runId, prompt: 'x' }) },
      'stream agent run on the id': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', '/agents/a/stream', { runId: t.runId, prompt: 'x' }) },
      'resume agent run': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', '/agents/a/resume', { runId: t.runId, approvals: {} }) },
      'cancel run': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', `/runs/${encodeURIComponent(t.runId)}/cancel?durable=true`, {}) },
      'workflow run/resume on the id': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', '/workflows/w/run', { runId: t.runId, resume: { approve: { ok: true } } }) },
      'workflow cancel': { kind: 'write', act: (w, t, who) => restDoor(w)(who, 'POST', `/workflows/runs/${encodeURIComponent(t.runId)}/cancel`, {}) },
      'new run on the thread': { kind: 'write', act: (w, t, who) => withThread(t, (th) => restDoor(w)(who, 'POST', '/agents/a/run', { runId: 'atkR', prompt: 'x', threadId: th })) },
    },
  },
  'chat-adapter (standalone)': {
    factories: ['createChatRoute'],
    cannot: { 'other-user-naming-owner': LEGACY_IDENTITY, 'unknown-naming-owner': LEGACY_IDENTITY },
    ops: {
      'turn on the run id': { kind: 'write', act: (w, t, who) => chatDoor(w, who)({ id: 'atkThread', runId: t.runId, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) },
      'turn on the thread': { kind: 'write', act: (w, t, who) => withThread(t, (th) => chatDoor(w, who)({ id: th, runId: 'atkC', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] })) },
    },
  },
  'agui (standalone)': {
    factories: ['createAguiRoute', 'pipeAguiStream'],
    cannot: { 'other-user-naming-owner': LEGACY_IDENTITY, 'unknown-naming-owner': LEGACY_IDENTITY },
    ops: {
      'run on the run id': { kind: 'write', act: (w, t, who) => aguiDoor(w, who)({ runId: t.runId, threadId: 'atkThread', prompt: 'hi' }) },
      'run on the thread': { kind: 'write', act: (w, t, who) => withThread(t, (th) => aguiDoor(w, who)({ runId: 'atkG', threadId: th, prompt: 'hi' })) },
    },
  },
  mcp: {
    factories: ['createMcpServer', 'serveMcp'],
    cannot: { 'other-user-naming-owner': LEGACY_IDENTITY, 'unknown-naming-owner': LEGACY_IDENTITY },
    ops: {
      'tools/call with the owner\'s work key': { kind: 'write', act: (w, _t, who) => mcpDoor(w, who)({ s: 'x' }, 'tgtM') },
      'tools/call naming the run id as the key': { kind: 'write', act: (w, t, who) => mcpDoor(w, who)({ s: 'x' }, t.runId) },
    },
  },
  studio: {
    factories: ['createStudioApi', 'createStudioApp'],
    ops: {
      'read run': { kind: 'read', act: (w, t, who) => studioDoor(w)(who, 'GET', `/runs/${encodeURIComponent(t.runId)}`) },
      'list runs': { kind: 'list', act: (w, _t, who) => studioDoor(w)(who, 'GET', '/runs') },
      'list workflow runs': { kind: 'list', act: (w, _t, who) => studioDoor(w)(who, 'GET', '/workflows/runs') },
      'read thread': { kind: 'read', act: (w, t, who) => withThread(t, (th) => studioDoor(w)(who, 'GET', `/threads/${th}/messages`)) },
      'cancel run': { kind: 'write', act: (w, t, who) => studioDoor(w)(who, 'POST', `/runs/${encodeURIComponent(t.runId)}/cancel`, {}) },
      'fork workflow run': { kind: 'write', act: (w, t, who) => studioDoor(w)(who, 'POST', `/workflows/w/runs/${encodeURIComponent(t.runId)}/fork`, { upto: 1, newRunId: 'atkV' }) },
    },
  },
  'engine (direct)': {
    factories: ['createGnl'],
    ops: {
      'gnl.run on the id': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return engineRes(e.gnl.run('a', { runId: t.runId, prompt: 'x', caller: e.caller })); } },
      'gnl.stream on the id': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return engineRes(e.gnl.stream('a', { runId: t.runId, prompt: 'x', caller: e.caller }).then((r: any) => r.text)); } },
      'resumeRun': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return engineRes(durable.resumeRun(t.runId, { journal: e.journal, model: echo, caller: e.caller } as never)); } },
      'gnl.runWorkflow on the id': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return engineRes(e.gnl.runWorkflow('w', undefined, { runId: t.runId, caller: e.caller, resume: { approve: { ok: true } } })); } },
      'gnl.runNetwork on the id': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return engineRes(e.gnl.runNetwork('n', { runId: t.runId, task: 'x', caller: e.caller })); } },
      'new run on the thread': { kind: 'write', act: async (w, t, who) => { const e = engineDoor(w, who); return t.threadId ? engineRes(e.gnl.run('a', { runId: 'atkE', prompt: 'x', threadId: t.threadId, caller: e.caller })) : undefined; } },
    },
  },
  'queue worker': {
    factories: ['createWorker'],
    cannot: { staff: RESOURCE_ID_ONLY, 'other-org-staff': RESOURCE_ID_ONLY },
    ops: {
      'job continuing the named run': { kind: 'write', act: (w, t, who) => queueDoor(w)(who, 'cont', { runId: t.runId, prompt: 'x' }) },
      'job with the owner\'s job name': { kind: 'write', act: (w, _t, who) => queueDoor(w)(who, 'own', { prompt: 'x' }, 'tgtQ') },
    },
  },
  'events consumer': {
    factories: ['createConsumer'],
    cannot: { staff: RESOURCE_ID_ONLY, 'other-org-staff': RESOURCE_ID_ONLY },
    ops: {
      'event continuing the named run': { kind: 'write', act: (w, t, who) => eventsDoor(w)(who, { runId: t.runId, prompt: 'x' }) },
    },
  },
  'scheduler fire': {
    factories: ['createScheduler'],
    cannot: { staff: RESOURCE_ID_ONLY, 'other-org-staff': RESOURCE_ID_ONLY },
    ops: {
      'trigger with the owner\'s trigger id': { kind: 'write', act: (w, _t, who) => schedulerDoor(w)(who, 'tgtC', { s: 'x' }) },
    },
  },
};
async function engineRes(p: Promise<unknown>): Promise<Res> {
  try { return { status: 200, body: JSON.stringify(await p) ?? '' }; } catch (e) { return { status: 403, body: String((e as Error)?.message ?? e) }; }
}

/** Exported door-like factories that are not a door of their own, with why. */
const NOT_A_DOOR: Record<string, string> = {
  createStudioAdmin: 'serves the static admin UI; it calls createStudioApi, which is the door',
  createStudioRunner: 'the studio\'s engine adapter, behind createStudioApi',
  pipeAgentStream: 'a stream encoder (server/studio), no identity, behind a door',
  createWorkflowWaker: 'takes no request: resumes each suspended run as its RECORDED owner (engine rule)',
  createA2ATool: 'a tool (a client of a remote createRestApi); measured in a2a-remote-owner.test.ts',
  createMcpTools: 'an MCP client', createRagTool: 'a tool; its owner comes from the run (identity channel)',
  createWorkingMemoryTool: 'a tool', createOmRecallTool: 'a tool', createDefaultEmbed: 'an embedder',
  createEnterpriseAuth: 'an auth provider (produces principals; not a door)', createCache: 'a cache',
  createDocsProvider: 'docs search, no runs', createDatasetsManager: 'eval datasets', createTrajectoryScorer: 'a scorer',
  serverIdentityOf: 'reads a sealed identity', createAgentTool: 'a birth (agent-tool child)', createBatch: 'a birth (batch item)',
  createGnl: 'the engine (engine door)', createProcessorCtx: 'processor plumbing', createRetentionSweeper: 'erasure worker',
  createSuggestions: 'suggestion store', createPollLoop: 'a timer', createBoundedUsageCache: 'a cache',
};

// ── snapshots ───────────────────────────────────────────────────────────────────────────────────
async function targetState(w: W, t: Target): Promise<Record<string, string>> {
  const saved = [...w.fail]; w.fail.clear();
  const ids = [t.runId, ...(t.also ?? [])];
  const out: Record<string, string> = {};
  try {
    for (const k of (await w.storage.runs.listKeys!('')).sort()) {
      if (!k.startsWith(`org:${ORG}:`)) continue; // the target lives in its owner's organization; another org's partition is not it
      const bare = k.slice(`org:${ORG}:`.length);
      if (ids.some((id) => bare === `wfrun:${id}` || bare.startsWith(`${id}:`)) || (t.threadId && k.includes(t.threadId))) out[k] = JSON.stringify(await w.storage.runs.get(k));
    }
  } finally { saved.forEach((k) => w.fail.add(k)); }
  return out;
}

// ── the walk ────────────────────────────────────────────────────────────────────────────────────
type Cell = { birth: string; state: State; door: string; op: string; caller: CallerKey };
const label = (c: Cell) => `${c.birth} | ${c.state} | ${c.door} | ${c.op} | ${c.caller}`;

/**
 * A world holding the target in `state`, checked through the engine's ONE reading (`runOwnerOf`), so a
 * cell never tests a state it did not reach. A birth that does not record the owner it was started for
 * is a finding (`wrong`); a lost record with no rows left behind is the `missing` state, which is not
 * the one under test (`skip`).
 */
async function prepare(birth: Birth, state: State): Promise<{ w: W; t: Target; born: CallerKey } | { skip: string } | { wrong: string }> {
  const w = world();
  // An ownerless run a birth cannot start for staff is started for nobody instead (`unknown`).
  const born: CallerKey = BORN_BY[state] === 'staff' && birth.cannot?.staff ? 'unknown' : BORN_BY[state];
  if (birth.cannot?.[born]) return { skip: birth.cannot[born]! };
  let t: Target;
  try { t = await birth.start(w, CALLERS[born]); } catch (e) { return { skip: `cannot be started for ${born}: ${(e as Error).message.slice(0, 120)}` }; }
  await new Promise((r) => setTimeout(r, 5)); // a stream's last write lands after its text resolves
  if (state === 'record-missing-rows-present') for (const k of await w.storage.runs.listKeys!('')) if (k === `org:${ORG}:${t.runId}:input`) await w.storage.runs.deletePrefix!(k);
  if (state === 'unreadable') w.fail.add(`${t.runId}:input`);
  const o = await runOwnerOf(w.scoped(ORG).journal, t.runId);
  const got = o.state === 'owned' ? `${o.owner.kind}${o.owner.kind === 'user' ? `:${o.owner.id}` : ''}${o.recorded ? '' : ' (not recorded)'}` : o.state;
  const want: Record<State, (s: string) => boolean> = {
    normal: (s) => s === 'user:u-ayse',
    ownerless: (s) => s === 'staff' || s === 'unknown',
    'record-missing-rows-present': (s) => s === 'staff (not recorded)',
    unreadable: (s) => s === 'unreadable',
  };
  if (want[state](got)) return { w, t, born };
  if (state === 'record-missing-rows-present' && got === 'missing') return { skip: 'no rows remain once the record is gone (the plain `missing` state)' };
  return { wrong: `${t.runId} reads as '${got}'` };
}

/** A run lock another caller took and RELEASED is bookkeeping; one still held would lock the owner out. */
function heldLockOrData(k: string, after: Record<string, string>): boolean {
  if (!k.endsWith(':lock')) return true;
  const v = after[k] ? JSON.parse(after[k]!) as { expires?: number } | undefined : undefined;
  return !!v && typeof v.expires === 'number' && v.expires > Date.now();
}

/** Every cell of the walk: attackers first on an untouched target, then controls (which may change it). */
async function walk(filter?: { births?: string[]; doors?: string[] }) {
  const findings: string[] = [];
  const inexpressible: string[] = [];
  const bornSkipped: string[] = [];
  const controlSeen = new Map<string, number>();
  const controlBlind: string[] = [];
  let cells = 0;
  let lockTouched = 0;
  for (const [bname, birth] of Object.entries(BIRTHS)) {
    if (filter?.births && !filter.births.includes(bname)) continue;
    for (const state of STATES) {
      const p = await prepare(birth, state);
      if ('skip' in p) { bornSkipped.push(`${bname} | ${state}: ${p.skip}`); continue; }
      if ('wrong' in p) { findings.push(`${bname} | ${state} | (the birth itself) | records its owner | - | 0 | ${p.wrong}`); continue; }
      const { w, t } = p;
      // A run born `unknown` is reachable by an unknown caller BY DESIGN (decideRunAccess): theirs, not attacked.
      const unchecked = p.born === 'unknown' ? [...UNCHECKED[state], 'unknown', 'unknown-naming-owner'] : UNCHECKED[state];
      const doors = Object.entries(DOORS).filter(([d]) => !filter?.doors || filter.doors.includes(d));
      for (const pass of ['attack', 'control'] as const) {
        for (const [dname, door] of doors) {
          // controls: reads and listings before writes, so a control's cancel cannot blind a later read
          const ops = Object.entries(door.ops).sort(([, a], [, b]) => (pass === 'control' ? Number(a.kind === 'write') - Number(b.kind === 'write') : 0));
          for (const [oname, op] of ops) {
            for (const ck of Object.keys(CALLERS) as CallerKey[]) {
              const control = CONTROLS[state].includes(ck);
              if ((pass === 'control') !== control || unchecked.includes(ck)) continue;
              const cell: Cell = { birth: bname, state, door: dname, op: oname, caller: ck };
              if (door.cannot?.[ck]) { inexpressible.push(label(cell)); continue; }
              const before = control ? {} : await targetState(w, t);
              const res = await op.act(w, t, CALLERS[ck]).catch((e) => ({ status: -1, body: `THREW ${(e as Error)?.message ?? e}` }));
              if (!res) break; // the operation does not apply to this target (it has no thread)
              cells++;
              if (control) {
                const seen = res.body.includes(SECRET) || (op.kind === 'list' && res.body.includes(t.runId));
                if (seen) controlSeen.set(dname, (controlSeen.get(dname) ?? 0) + 1);
                else if (dname === 'rest' && op.kind !== 'write' && state === 'normal') controlBlind.push(`${label(cell)} | ${res.status} ${res.body.slice(0, 80)}`);
                continue;
              }
              const after = await targetState(w, t);
              const touched = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
              const changed = touched.filter((k) => heldLockOrData(k, after));
              if (touched.length > changed.length) lockTouched++;
              if (res.body.includes(SECRET)) findings.push(`${label(cell)} | ${res.status} | body has the secret`);
              // Another organization may hold a run of its own under the same id (an earlier cell started
              // it there); its listing showing that id is its own run, not the target.
              const sameIdInOwnOrg = orgOf(CALLERS[ck]) !== ORG && (await w.storage.runs.listKeys!(`org:${orgOf(CALLERS[ck])}:${t.runId}:`)).length > 0;
              if (op.kind === 'list' && res.body.includes(t.runId) && !sameIdInOwnOrg) findings.push(`${label(cell)} | ${res.status} | listing shows ${t.runId}`);
              if (changed.length) findings.push(`${label(cell)} | ${res.status} | changed ${changed.slice(0, 3).join(',')}`);
            }
          }
        }
      }
    }
  }
  return { findings, inexpressible, bornSkipped, controlSeen, controlBlind, cells, lockTouched };
}

describe('conformance registry: births x states x doors x callers', () => {
  it('every cell holds: no attacker reads a secret, lists a foreign id, or changes the target', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const r = await walk();
    vi.restoreAllMocks();
    console.log(`[registry] ${r.cells} cells in ${Date.now() - t0} ms; ${r.findings.length} findings; ${r.inexpressible.length} inexpressible; ${r.bornSkipped.length} birth x state not startable; ${r.lockTouched} cells took and released the target's run lock`);
    console.log(['[registry] findings:', ...r.findings].join('\n  '));
    console.log(['[registry] births that cannot be started in a state:', ...r.bornSkipped].join('\n  '));
    console.log(['[registry] control blind on REST reads:', ...r.controlBlind].join('\n  '));
    for (const d of Object.keys(DOORS)) expect(r.controlSeen.get(d) ?? 0, `door ${d}: no control ever saw the target (the negatives would be vacuous)`).toBeGreaterThan(0);
    expect(r.findings).toEqual([]);
  }, 600_000);
});
