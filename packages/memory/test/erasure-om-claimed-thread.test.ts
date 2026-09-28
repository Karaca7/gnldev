// A thread opened anonymously is taken by the first named user (a documented 0.7 rule: a guest chats,
// then signs in). Its observations indexed BEFORE the claim carry no owner label, so an erasure that
// deletes documents by owner left them. Measured on 4efc24a5 by the release panel:
//   before ["OBS-BEFORE-CLAIM: IBAN TR55-AYSE","OBS-AFTER-CLAIM"] → after ["OBS-BEFORE-CLAIM: IBAN TR55-AYSE"]
// A thread's observations go with the thread, whoever labelled them.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, user, eraseSubject, scopeConfigToOrg } from '@gnldev/durable';
import { memoryPreset } from '../src/index.js';

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const echo: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'e', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
};
const embed = async (t: string[]) => t.map(() => [1, 0, 0]);
const obs = (id: string, text: string, seq: number, threadId: string) => ({ id, text, fromSeq: seq - 1, toSeq: seq, threadId });
const texts = async (s: InMemoryStorage) => (await s.vectors!.query([1, 0, 0], 50)).map((m) => m.text).sort();

describe('erasure takes a thread\'s observations, however they were labelled', () => {
  it('an observation indexed while the thread was anonymous goes when its later owner is erased', async () => {
    const storage = new InMemoryStorage();
    const memory: any = memoryPreset(storage as any, 'chat', { observationalMemory: { model: echo, omVectors: { store: storage.vectors!, embed } } as any });
    const gnl = createGnl({ storage, memory, agents: { a: { model: echo } } } as any);
    await gnl.run('a', { runId: 'anon1', prompt: 'my IBAN is TR55-AYSE', threadId: 'T' });
    await memory.indexObservationVector('T', 0, 1, obs('o1', 'OBS-BEFORE-CLAIM: IBAN TR55-AYSE', 1, 'T'));
    await gnl.run('a', { runId: 'ay1', prompt: 'hi', threadId: 'T', caller: user('u-ayse') });
    await memory.indexObservationVector('T', 0, 2, obs('o2', 'OBS-AFTER-CLAIM', 2, 'T'));
    // Bob's own thread, and a knowledge-base document that merely mentions the same thread id.
    await gnl.run('a', { runId: 'bob1', prompt: 'hi', threadId: 'TB', caller: user('u-bob') });
    await memory.indexObservationVector('TB', 0, 1, obs('ob', 'OBS-BOB', 1, 'TB'));
    await storage.vectors!.upsert([{ id: 'kb1', text: 'KB-NOTE-ABOUT-T', embedding: [1, 0, 0], shared: true, metadata: { threadId: 'T' } }]);

    expect(await texts(storage)).toEqual(['KB-NOTE-ABOUT-T', 'OBS-AFTER-CLAIM', 'OBS-BEFORE-CLAIM: IBAN TR55-AYSE', 'OBS-BOB']);
    const report = await eraseSubject(storage, 'u-ayse');
    expect(report.memoryThreads).toBe(1);
    expect(await texts(storage)).toEqual(['KB-NOTE-ABOUT-T', 'OBS-BOB']);
  });

  it('in an organization: the same thread id in another organization keeps its observations', async () => {
    const storage = new InMemoryStorage();
    const build = (org: string) => {
      let mem: any;
      const cfg: any = scopeConfigToOrg({
        storage,
        memoryFactory: (s: any) => (mem = memoryPreset(s, 'chat', { observationalMemory: { model: echo, omVectors: { store: s.vectors, embed } } as any })),
        agents: { a: { model: echo } },
      } as any, org);
      return { gnl: createGnl(cfg.config), mem: () => mem };
    };
    const acme = build('acme');
    await acme.gnl.run('a', { runId: 'anon1', prompt: 'x', threadId: 'T' });
    await acme.mem().indexObservationVector('T', 0, 1, obs('o1', 'ACME-ANON-OBS', 1, 'T'));
    await acme.gnl.run('a', { runId: 'ay1', prompt: 'hi', threadId: 'T', caller: user('u-ayse', 'acme') });
    const globex = build('globex');
    await globex.gnl.run('a', { runId: 'ay1', prompt: 'hi', threadId: 'T', caller: user('u-ayse', 'globex') });
    await globex.mem().indexObservationVector('T', 0, 1, obs('o1', 'GLOBEX-AYSE-OBS', 1, 'T'));

    await eraseSubject(storage, 'u-ayse', { orgId: 'acme' });
    expect(await texts(storage)).toEqual(['GLOBEX-AYSE-OBS']);
  });
});
