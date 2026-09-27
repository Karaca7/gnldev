// A client holds its token until it expires. In a single-page app where one user logs out and another
// logs in without a reload, the second user's requests went out on the first one's token for up to its
// lifetime — reading her data and starting runs as her. `clearToken()` forgets it; the next request asks
// `getToken` again.
import { describe, it, expect } from 'vitest';
import { GnlClient } from '../src/index.js';

const tokenFor = (sub: string) => {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
};
function setup(users: string[]) {
  const sent: string[] = [];
  let i = 0;
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    sent.push(JSON.parse(Buffer.from(auth.split('.')[1] ?? 'e30', 'base64url').toString()).sub);
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchImpl, getToken: async () => tokenFor(users[Math.min(i++, users.length - 1)]!) });
  return { client, sent };
}

describe('clearToken', () => {
  it('the next request after a logout carries the next user\'s token', async () => {
    const { client, sent } = setup(['alice', 'bob']);
    await client.listRuns();
    client.clearToken();
    await client.listRuns();
    expect(sent).toEqual(['alice', 'bob']);
  });

  it('a refresh started for the previous user does not become the next user\'s token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const sent: string[] = [];
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization') ?? '';
      sent.push(JSON.parse(Buffer.from(auth.split('.')[1]!, 'base64url').toString()).sub);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new GnlClient({
      baseUrl: 'http://x', fetch: fetchImpl,
      getToken: async () => { const me = n++ === 0 ? 'alice' : 'bob'; if (me === 'alice') await gate; return tokenFor(me); },
    });
    const first = client.listRuns();
    client.clearToken();
    release();
    await first;
    await client.listRuns();
    expect(sent[sent.length - 1]).toBe('bob');
  });

  it('without a clear, the token is reused as before', async () => {
    const { client, sent } = setup(['alice', 'bob']);
    await client.listRuns();
    await client.listRuns();
    expect(sent).toEqual(['alice', 'alice']);
  });
});
