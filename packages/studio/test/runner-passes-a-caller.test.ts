// Studio is a door too (ADR-0002): its auth provider yields a Principal, and what it hands the engine
// is `engineCallerOf(principal, named)` — carried on the callback ctx as `caller` and passed on by the
// runner. Before this, the runner sealed only the organization, so every playground run and every
// code-workflow run an operator started was born `unknown` — nobody's, reachable by nobody but an
// unknown caller — and the tool test-run hard-coded `STAFF` for whoever called it, a host included.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, identityOf } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { createStudioRunner } from '../src/runner.js';
import { createStudioApi } from '../src/server.js';

const model = {
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};
const auth = {
  authenticate: (req: Request) =>
    req.headers.get('authorization') === 'Bearer ops' ? { kind: 'operator', id: 'ops', roles: ['admin'] } : null,
  authorize: (p: unknown) => ({ allow: !!p }),
};

function setup() {
  const journal = new InMemoryJournal();
  const seen: { kind?: string; id?: string }[] = [];
  const probe = { description: 'who am I', execute: async (_: unknown, options: unknown) => { const i = identityOf(options); seen.push(i as never); return i.kind; } };
  const config = {
    journal,
    agents: { a: { model, tools: { probe } } },
    workflows: { w: workflow<unknown>().then(step('s', async () => 'x')) },
  } as any;
  const runner = createStudioRunner(createGnl(config) as never, config, { toolExec: true });
  const api = createStudioApi({ reader: journal, gnl: runner, auth: auth as never } as never) as (r: Request) => Promise<Response>;
  const post = async (path: string, body: unknown) => {
    const r = await api(new Request(`http://x${path}`, {
      method: 'POST', headers: { authorization: 'Bearer ops', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: r.status, body: await r.text() };
  };
  return { journal, runner, post, seen };
}

describe('an operator in Studio is staff to the engine', () => {
  it('a playground run the operator starts naming nobody is staff\'s', async () => {
    const { journal, post } = setup();
    const res = await post('/agents/a/run', { runId: 'r1', prompt: 'hi' });
    expect(res.status, res.body).toBe(200);
    const rec = await journal.get<Record<string, unknown>>('r1:input');
    expect(rec?.resourceId).toBeUndefined();
    expect(rec?.ownerKind, 'born to nobody while an operator started it').toBe('staff');
  });

  it('a playground run naming a user is that user\'s (sibling)', async () => {
    const { journal, post } = setup();
    expect((await post('/agents/a/run', { runId: 'r2', prompt: 'hi', resourceId: 'u-ayse' })).status).toBe(200);
    expect((await journal.get<Record<string, unknown>>('r2:input'))?.resourceId).toBe('u-ayse');
  });

  it('a code workflow the operator runs is staff\'s', async () => {
    const { journal, post } = setup();
    const res = await post('/workflows/w/run', { runId: 'wf1', input: {} });
    expect(res.status, res.body).toBe(200);
    expect((await journal.get<Record<string, unknown>>('wf1:input'))?.ownerKind).toBe('staff');
  });

  it('the tool test-run tells the tool it runs for staff', async () => {
    const { post, seen } = setup();
    const res = await post('/tools/probe/execute', { input: {}, durable: true });
    expect(res.status, res.body).toBe(200);
    expect(seen.at(-1)?.kind).toBe('staff');
  });
});

describe('the runner passes the caller it is given, and invents none', () => {
  it('a host calling runTool with no ctx: the tool runs for `unknown`, not for staff', async () => {
    const { runner, seen } = setup();
    await (runner as any).runTool('probe', {}, { durable: true });
    expect(seen.at(-1)?.kind).toBe('unknown');
  });

  it('a host passing a user caller: the run and the tool are that user\'s', async () => {
    const { runner, journal, seen } = setup();
    await (runner as any).run('a', { runId: 'r3', prompt: 'hi' }, { caller: { kind: 'user', id: 'u-mehmet' } });
    expect((await journal.get<Record<string, unknown>>('r3:input'))?.resourceId).toBe('u-mehmet');
    await (runner as any).runTool('probe', {}, { durable: true }, { caller: { kind: 'user', id: 'u-mehmet' } });
    expect(seen.at(-1)).toMatchObject({ kind: 'user', id: 'u-mehmet' });
  });

  it('a host passing no ctx to run: `unknown`, as the engine reads a call with no caller', async () => {
    const { runner, journal } = setup();
    await (runner as any).run('a', { runId: 'r4', prompt: 'hi' });
    expect((await journal.get<Record<string, unknown>>('r4:input'))?.ownerKind).toBe('unknown');
  });
});
