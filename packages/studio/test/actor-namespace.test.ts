// Staff and end users share one id string space (a basic-auth login, a token's `sub`). The engine's
// actor lock compares names, so Studio hands it a kind-qualified one: staff `ayse` is `operator:ayse`,
// and cannot answer a refusal meant for the end user `ayse`. Measured before: actor=ayse, 200.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, stampFormat, RunActorMismatchError } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';

async function seed(journal: InMemoryJournal, runId: string, actor: string) {
  const sentinel = { __gnl_suspend: { toolCallId: 'call-1', toolName: 't', args: {}, reason: 'r', kind: 'confirm' } };
  await journal.put(`${runId}:tool:call-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 't' }));
  await journal.put(`${runId}:input`, stampFormat({ at: Date.now(), prompt: 'x', actor }));
}

describe('actor lock: staff login vs end-user id', () => {
  it('staff "ayse" is not the end user "ayse": Studio hands the engine a kind-qualified actor', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'r-user', 'ayse'); // a run the END USER ayse owns (stamp = her subject id)
    let seen: string | undefined;
    const api = createStudioApi({
      reader: journal,
      auth: roleAuth({ admin: { user: 'ayse', pass: 'pw' } }),
      // The engine's lock, as run.ts applies it: two names, and they must match.
      resume: async (_r, _a, ctx) => {
        seen = ctx.actor;
        const frozen = 'ayse';
        if (ctx.actor && frozen !== ctx.actor) throw new RunActorMismatchError(`run belongs to actor '${frozen}'`, { runId: 'r-user', ownerActor: frozen, requestedActor: ctx.actor });
        return { text: 'ok' };
      },
    } as never) as unknown as (r: Request) => Promise<Response>;
    const res = await api(new Request('http://s/runs/r-user/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('ayse:pw').toString('base64') },
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    }));
    expect(seen).toBe('operator:ayse');
    expect(res.status).toBe(409);
  });
});
