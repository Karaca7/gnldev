// 0.7.0 release panel D-4: a foreign runId sent with the caller's OWN thread was answered, on the
// standalone chat and AG-UI doors, with a 409 whose text named the run's thread — the victim's
// conversation id. The engine's thread gates ran before its ownership refusal. The refusal now comes
// first on any call with a thread, so every door answers "not yours" and names nobody, the way REST's
// edge gate does. A caller re-using ITS OWN runId on a second thread still hears which thread it was.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl, user, scopeConfigToOrg, resumeRun, STAFF, type Caller } from '@gnldev/durable';
import { createChatRoute } from '../../chat-adapter/src/chat-route.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { echo } from './conformance-registry.js';

const VICTIM_THREAD = 'VICTIM-THREAD-ID';
const MAL = { kind: 'subject', id: 'u-mallory', orgId: 'acme', roles: [] } as never;
const AYSE = { kind: 'subject', id: 'u-ayse', orgId: 'acme', roles: [] } as never;
const turn = (text: string) => [{ id: 'q', role: 'user', parts: [{ type: 'text', text }] }];

async function world(owner: Caller) {
  const storage = new InMemoryStorage();
  const config: any = { storage, memoryFactory: (s: any) => new BasicMemory(s.runs ?? s), agents: { a: { model: echo } } };
  const scoped = scopeConfigToOrg(config, 'acme') as any;
  await createGnl(scoped.config).run('a', { runId: 'r-victim', prompt: 'V', threadId: VICTIM_THREAD, caller: owner });
  return { config, scoped };
}
const chat = async (config: any, who: unknown, body: object) => {
  const r: Response = await (createChatRoute(config, { identify: () => who as never }) as any).request('/agents/a/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
};
const agui = async (config: any, who: unknown, body: object) => {
  const r: Response = await (createAguiRoute(config, { identify: () => who as never }) as any)(new Request('http://x/agents/a/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.text() };
};

describe('a foreign run id with my own thread: the refusal names nobody', () => {
  for (const [label, owner] of [['a user\'s run', user('u-ayse', 'acme')], ['a staff run', STAFF]] as const) {
    it(`chat (standalone), ${label}`, async () => {
      const { config } = await world(owner);
      const r = await chat(config, MAL, { id: 't-mine', runId: 'r-victim', messages: turn('hi') });
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body).code).toBe('run_owner_mismatch');
      expect(r.body).not.toContain(VICTIM_THREAD);
    });

    it(`agui (standalone), ${label}`, async () => {
      const { config } = await world(owner);
      const r = await agui(config, MAL, { runId: 'r-victim', threadId: 't-mine', prompt: 'hi' });
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body).code).toBe('run_owner_mismatch');
      expect(r.body).not.toContain(VICTIM_THREAD);
    });

    it(`chat on a prebuilt { gnl } (no journal at the door), ${label}`, async () => {
      const storage = new InMemoryStorage();
      const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model: echo } } } as never);
      await gnl.run('a', { runId: 'r-victim', prompt: 'V', threadId: VICTIM_THREAD, caller: owner.kind === 'user' ? user('u-ayse') : STAFF });
      const who = { kind: 'subject', id: 'u-mallory', roles: [] };
      const r = await chat({ gnl }, who, { id: 't-mine', runId: 'r-victim', messages: turn('hi') });
      expect(r.status).toBe(409);
      expect(r.body).not.toContain(VICTIM_THREAD);
    });

    it(`resumeRun (the run's own thread, re-entered), ${label}`, async () => {
      const { scoped } = await world(owner);
      const err = await resumeRun('r-victim', { journal: scoped.journal, model: echo, caller: user('u-mallory', 'acme') } as never).then(() => undefined, (e: Error) => e);
      expect(err?.name).toBe('RunOwnerMismatchError');
      expect(err?.message).not.toContain(VICTIM_THREAD);
    });
  }

  it('control: the OWNER re-using her runId on another thread still hears which thread it was', async () => {
    const { config } = await world(user('u-ayse', 'acme'));
    const r = await agui(config, AYSE, { runId: 'r-victim', threadId: 't-other', prompt: 'hi' });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).code).toBe('run_thread_mismatch');
    expect(r.body).toContain(VICTIM_THREAD);
  });
});
