// The AG-UI route derives a run id from `(agent, subject, Idempotency-Key)`. Two organizations can each
// have a user `u1` whose gateway sends the same key, so the identity's organization has to separate
// them — the boundary @gnldev/mcp and @gnldev/chat-adapter crossed (their org-scope tests).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, withOrg } from '@gnldev/durable';
import { createAguiRoute } from '../src/route.js';
import { call } from './call.js';

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
  const app = createAguiRoute({ journal, agents: { a: { model } } } as never, {
    identify: (req: Request) => ({ kind: 'subject', id: 'u1', roles: [], orgId: req.headers.get('x-test-org') ?? undefined }),
  } as never);
  const post = async (org: string) => {
    const res = await call(app, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': org, 'Idempotency-Key': 'k1' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    return await res.text();
  };
  return { journal, post, calls: () => modelCalls };
}

describe('agui route: an organization is a boundary', () => {
  it('the same user and key in two organizations run twice, and neither sees the other\'s answer', async () => {
    const { post, calls, journal } = route();
    expect(await post('acme')).toContain('answer-1');
    expect(await post('globex'), 'globex was replayed acme\'s answer').not.toContain('answer-1');
    expect(calls()).toBe(2);
    const acmeRuns = await (withOrg(journal, 'acme') as any).listRuns();
    expect((Array.isArray(acmeRuns) ? acmeRuns : acmeRuns.items).length).toBe(1);
  });
});
