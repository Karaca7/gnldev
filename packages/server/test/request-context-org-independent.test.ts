// What a dynamic agent is told about WHO is calling, on all three endpoints that start work.
//
// `@gnldev/server` documents a plain `org` in requestContext, "visible to dynamic agents", and
// dynamic `system`/`model`/`tools` functions read it. It used to be merged in at each call site
// (`{ ...body.context, ...(s.orgId ? { org: s.orgId } : {}) }`), which means that on the path where no
// organization resolves — every request on a deployment that has not configured `org` — the body's own
// `org` survived untouched. The seal existed to close exactly that class and did not cover the one key
// this package had published.
//
// `/agents/:name/resume` built its context by hand instead and carried neither `__gnl_resourceId` nor
// `__gnl_threadId`, so the two halves of one conversation disagreed about who the caller was.
//
// Every probe reads the context through the DYNAMIC TOOLS function, i.e. the surface a host actually
// writes policy against — not through the seal helper, which is unit-tested one layer down.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(c: any) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          c.enqueue({ type: 'text-delta', id: '1', delta: text });
          c.enqueue({ type: 'text-end', id: '1' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
          c.close();
        },
      }),
    }),
  };
}

/** An agent whose dynamic `tools` records the exact request context it was resolved with. */
function capturingAgent(seen: Record<string, unknown>[]) {
  return { model: mkModel('ok'), tools: (ctx: Record<string, unknown>) => { seen.push({ ...ctx }); return {}; } };
}

const post = (api: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(api, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('a request body that names its own organization', () => {
  // The shared-scope path: no `org` option, so nothing server-side ever resolves an organization and
  // nothing was there to overwrite the body's copy. This is the default configuration.
  it('does not reach a dynamic agent on a deployment with no organizations (run)', async () => {
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: capturingAgent(seen) } } as never);

    const res = await post(api, '/agents/a/run', { runId: 'r1', prompt: 'hi', context: { org: 'victim', role: 'admin' } });

    expect(res.status).toBe(200);
    expect(seen.length, 'the dynamic tools function never ran — this test proves nothing').toBeGreaterThan(0);
    expect(seen[0]!.org, 'the caller chose the organization its agent believes it serves').toBeUndefined();
    expect('org' in seen[0]!).toBe(false);
    expect(seen[0]!.role, 'ordinary caller-supplied context was collateral damage').toBe('admin');
  });

  it('does not reach a dynamic agent on the stream endpoint either', async () => {
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: capturingAgent(seen) } } as never);

    const res = await post(api, '/agents/a/stream', { runId: 'r2', prompt: 'hi', context: { org: 'victim' } });
    await res.text(); // drain, so the run completes before the assertions

    expect(seen.length, 'the dynamic tools function never ran — this test proves nothing').toBeGreaterThan(0);
    expect(seen[0]!.org, 'the stream path leaked what the run path refuses').toBeUndefined();
  });

  // And when an organization DOES resolve, the server's value wins rather than merely being merged
  // over — a body key that arrives after the merge would otherwise still decide.
  it('loses to the server-resolved organization', async () => {
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: capturingAgent(seen) } } as never,
      { org: {} } as never,
    );

    await post(api, '/agents/a/run', { runId: 'r3', prompt: 'hi', context: { org: 'victim' } }, { 'x-gnl-org': 'acme' });

    expect(seen[0]!.org).toBe('acme');
    expect(seen[0]!.__gnl_orgId, 'the two published names for one fact disagree').toBe('acme');
  });

  // The counterpart nobody would notice failing: the server MUST still publish `org`, or every
  // dynamic agent that reads it silently loses its organization and the fix trades a leak for an outage.
  it('is replaced by a real value, not merely removed', async () => {
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi(
      { journal: new InMemoryJournal(), agents: { a: capturingAgent(seen) } } as never,
      { org: {} } as never,
    );

    await post(api, '/agents/a/run', { runId: 'r4', prompt: 'hi' }, { 'x-gnl-org': 'acme' });

    expect(seen[0]!.org, 'the documented `org` key is no longer published to dynamic agents').toBe('acme');
  });
});

describe('/agents/:name/resume', () => {
  const authed = () => roleAuth({ admin: { token: 'adm', user: 'alice', orgId: 'acme' } });

  /**
   * A run whose journaled input exists, which is all `resume` needs to start work. The key carries
   * the organization prefix because the resume route reads through the org-scoped journal.
   */
  async function seedInput(journal: InMemoryJournal, runId: string): Promise<void> {
    await journal.put(`org:acme:${runId}:input`, { prompt: 'hi' });
  }

  // Pre-change this path built `s.orgId ? { org: s.orgId } : undefined` by hand, so a dynamic
  // function saw an identity on a fresh run and none on the resume of that same run.
  it('gives the dynamic agent the same identity the fresh run got', async () => {
    const journal = new InMemoryJournal();
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi(
      { journal, agents: { a: capturingAgent(seen) } } as never,
      { auth: authed(), org: {} } as never,
    );
    const auth = { authorization: 'Bearer adm' };

    await post(api, '/agents/a/run', { runId: 'run-1', prompt: 'hi' }, auth);
    const fromRun = seen[0]!;

    await seedInput(journal, 'run-2');
    const res = await post(api, '/agents/a/resume', { runId: 'run-2' }, auth);
    expect(res.status, await res.text()).toBe(200);
    const fromResume = seen[1]!;

    expect(fromRun.__gnl_resourceId, 'the fresh run had no identity — the fixture is wrong').toBe('alice');
    expect(fromResume.__gnl_resourceId, 'the resume half of the conversation does not know who the caller is').toBe('alice');
    expect(fromResume.org).toBe('acme');
    expect(fromResume.__gnl_orgId).toBe('acme');
  });

  // The resume body is not a context channel. It never was documented as one, and a path that seals
  // `{}` must keep it that way.
  it('ignores a context supplied in the resume body', async () => {
    const journal = new InMemoryJournal();
    const seen: Record<string, unknown>[] = [];
    const api = createRestApi(
      { journal, agents: { a: capturingAgent(seen) } } as never,
      { auth: authed(), org: {} } as never,
    );

    await seedInput(journal, 'run-3');
    await post(
      api,
      '/agents/a/resume',
      { runId: 'run-3', context: { org: 'victim', __gnl_resourceId: 'evil', __gnl_orgId: 'victim' } },
      { authorization: 'Bearer adm' },
    );

    expect(seen[0]!.org).toBe('acme');
    expect(seen[0]!.__gnl_resourceId).toBe('alice');
    expect(JSON.stringify(seen[0]), 'a resume body decided the identity of the run it resumed').not.toContain('victim');
  });
});

describe('a single-tenant deployment', () => {
  // Backward compatibility. The whole change is about organizations; a deployment that has none must
  // behave exactly as before, including still being allowed to hand over a conversation store object.
  it('still accepts a `memory` object and still passes the caller\'s context through', async () => {
    const seen: Record<string, unknown>[] = [];
    const memory = (() => {
      const threads = new Map<string, unknown[]>();
      return {
        getMessages: async (id: string) => threads.get(id) ?? [],
        append: async (id: string, msgs: unknown[]) => { threads.set(id, [...(threads.get(id) ?? []), ...msgs]); },
      };
    })();

    const api = createRestApi({ journal: new InMemoryJournal(), memory, agents: { a: capturingAgent(seen) } } as never);
    const first = await post(api, '/agents/a/run', { runId: 'r9', threadId: 't1', prompt: 'remember this', context: { locale: 'tr' } });
    const second = await post(api, '/agents/a/run', { runId: 'r10', threadId: 't1', prompt: 'and now?' });

    expect(first.status, await first.text()).toBe(200);
    expect(second.status).toBe(200);
    expect(seen[0]!.locale, 'ordinary caller context stopped reaching dynamic agents').toBe('tr');
    // The store is still wired up: the second run's thread carries the first run's turn.
    expect(await memory.getMessages('t1'), 'the host-provided conversation store was ignored').not.toHaveLength(0);
    expect(JSON.stringify(await memory.getMessages('t1'))).toContain('remember this');
  });
});
