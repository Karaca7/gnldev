// ADR-0002 open point, MEASURED: does a remote run started through @gnldev/a2a belong to the end user of
// the calling run? A local run for Ayşe calls the a2a tool; the tool reaches a remote @gnldev/server
// (createRestApi, through `fetchImpl` = the remote app) with the service's own credential, the way the
// a2a README wires it. The remote run's owner is read with the engine's one reading, `runOwnerOf`.
//
// The ADR's decision: the remote run should be Ayşe's (the tool reads her from the run's identity and
// calls as an application naming her). This test states that and stays red until it holds.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, runOwnerOf, toJournal, user } from '@gnldev/durable';
import { stepCountIs } from 'ai';
import { createRestApi } from '../src/index.js';
import { createA2ATool } from '../../a2a/src/index.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
const text = (t: string): any => ({ specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {}, doGenerate: async () => ({ content: [{ type: 'text', text: t }], finishReason: stop, usage, warnings: [] }) });
/** Delegates once to the `remote` tool, then answers with what came back. */
const delegating: any = {
  specificationVersion: 'v4', provider: 'm', modelId: 'd', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: stop, usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'remote', input: JSON.stringify({ task: 'AYSE-TASK' }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] }),
};

/** The remote deployment: one service credential, as an application (roleAuth's `client`) or as staff. */
function remote(kind: 'application' | 'operator') {
  const storage = new InMemoryStorage();
  const principal = kind === 'application' ? { kind: 'application', id: 'svc', roles: ['client'] } : { kind: 'operator', id: 'svc', roles: ['admin'] };
  const auth = { authenticate: (r: Request) => (r.headers.get('authorization') === 'Bearer svc' ? principal : null), authorize: () => ({ allow: true }) };
  const api = createRestApi({ storage, agents: { worker: { model: text('REMOTE-ANSWER') } } } as never, { auth: auth as never, protectionsBanner: false }) as (r: Request) => Promise<Response>;
  const fetchImpl = (async (url: string, init: RequestInit) => api(new Request(url, init))) as unknown as typeof fetch;
  return { storage, fetchImpl };
}

describe('a2a: whose is the remote run', () => {
  for (const kind of ['application', 'operator'] as const) {
    it(`service credential as ${kind}: the remote run belongs to the calling run's end user`, async () => {
      const r = remote(kind);
      const tool = createA2ATool({ endpoint: 'http://remote', agentName: 'worker', fetchImpl: r.fetchImpl, headers: { authorization: 'Bearer svc' } });
      const local = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: delegating, tools: { remote: tool }, stopWhen: stepCountIs(3) } } } as never);
      const out = await local.run('a', { runId: 'local-1', prompt: 'hi', caller: user('u-ayse') });
      const steps = JSON.stringify((out as { steps?: unknown }).steps ?? out);
      const remoteIds = (await r.storage.runs.listKeys!('')).filter((k) => k.endsWith(':input')).map((k) => k.slice(0, -':input'.length));
      const owners = await Promise.all(remoteIds.map(async (id) => {
        const o = await runOwnerOf(toJournal(r.storage.runs) as never, id);
        return `${id} -> ${o.state === 'owned' ? `${o.owner.kind}${o.owner.kind === 'user' ? `:${o.owner.id}` : ''}` : o.state}`;
      }));
      console.log(`[a2a ${kind}] remote runs: ${owners.join(', ') || '(none)'}; tool result: ${steps.match(/REMOTE-ANSWER|HTTP \d+[^"]*/)?.[0] ?? '?'}`);
      expect(remoteIds.length, 'the remote was reached and started a run').toBe(1);
      expect(owners[0]).toMatch(/-> user:u-ayse$/);
    });
  }
});
