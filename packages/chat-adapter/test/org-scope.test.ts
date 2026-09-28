// The chat route derives a turn's run id from `(agent, subject, conversation:message)`. Two
// organizations can each have a user `u1` whose client numbers conversations the same way, so the
// identity names an organization and the route has to keep the two apart — the same boundary
// @gnldev/mcp's `callTool` crossed (see packages/mcp/test/org-scope.test.ts).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, withOrg } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function route() {
  const journal = new InMemoryJournal();
  let modelCalls = 0;
  const model: any = {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => {
      modelCalls++;
      return { stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: `answer-${modelCalls}` },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]) };
    },
  };
  const app = createChatRoute({ journal, agents: { a: { model } } }, {
    identify: (req) => ({ kind: 'subject', id: 'u1', roles: [], orgId: req.headers.get('x-test-org') ?? undefined }),
  });
  const post = async (org: string) => {
    const res = await app.request('/agents/a/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': org },
      body: JSON.stringify({ id: 'c1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    });
    return { status: res.status, body: await res.text(), runId: res.headers.get('x-gnl-run-id') };
  };
  return { journal, post, calls: () => modelCalls };
}

describe('chat route: an organization is a boundary', () => {
  it('the same user and turn in two organizations run twice, and neither sees the other\'s answer', async () => {
    const { post, calls } = route();
    const acme = await post('acme');
    const globex = await post('globex');
    expect(acme.body).toContain('answer-1');
    expect(globex.body, 'globex was replayed acme\'s answer').not.toContain('answer-1');
    expect(calls()).toBe(2);
  });

  it('the run is written to that organization\'s journal', async () => {
    const { journal, post } = route();
    const { runId } = await post('acme');
    const rows = await (withOrg(journal, 'acme') as any).listRuns();
    expect((Array.isArray(rows) ? rows : rows.items).map((r: { runId: string }) => r.runId)).toContain(runId);
  });
});

describe('chat route: a prebuilt { gnl } cannot keep organizations apart', () => {
  it('an org-bound turn is refused, not served from the shared instance', async () => {
    const { createGnl } = await import('@gnldev/durable');
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: {} } as never);
    const app = createChatRoute({ gnl }, { identify: () => ({ kind: 'subject', id: 'u1', roles: [], orgId: 'acme' }) });
    const res = await app.request('/agents/a/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('cannot keep organizations apart');
  });
});
