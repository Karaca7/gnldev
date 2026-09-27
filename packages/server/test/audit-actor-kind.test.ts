// The audit trail tells staff from end users. It wrote the raw principal id, so an end user whose token
// says `sub: 'ops'` and the operator `ops` were one actor in the record — anyone reading the trail
// would take the user's action for the operator's. Staff are named `operator:<id>`, as everywhere
// else names are compared.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { InMemoryJournal, listLog } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const model = {
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};

describe('audit actors', () => {
  it('an end user named "ops" and the operator "ops" are two actors', async () => {
    const SECRET = randomBytes(32).toString('hex');
    const PASS = randomBytes(16).toString('hex');
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, memory: false, agents: { a: { model } } } as never, {
      auth: roleAuth({ admin: { user: 'ops', pass: PASS }, endUsers: { secret: SECRET } }),
      protectionsBanner: false,
    } as never);
    const endUser = { authorization: `Bearer ${signSubjectToken({ sub: 'ops' }, SECRET)}` };
    const staff = { authorization: 'Basic ' + Buffer.from(`ops:${PASS}`).toString('base64') };
    const post = (h: Record<string, string>, path: string, body: unknown) =>
      api(new Request(`http://x${path}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect((await post(endUser, '/agents/a/run', { runId: 'r-u', prompt: 'hi' })).status).toBe(200);
    expect((await post(endUser, '/runs/r-u/cancel', {})).status).toBe(200);
    expect((await post(staff, '/agents/a/run', { runId: 'r-s', prompt: 'hi' })).status).toBe(200);
    expect((await post(staff, '/runs/r-s/cancel', {})).status).toBe(200);
    const byTarget = Object.fromEntries((await listLog(journal, '__audit__')).map((i: any) => [i.payload.target, i.payload.actor]));
    expect(byTarget['r-u']).toBe('ops');
    expect(byTarget['r-s']).toBe('operator:ops');
  });
});
