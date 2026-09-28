// Extension check (ADR-0002 prediction): a NEW run kind ("cron-agent": a scheduled agent run that calls
// a tool) and a NEW root-polled log, written ONLY with public API — no framework file touched.
import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryStorage, createGnl, toJournal, eraseSubject, ownedName, ownerOfName, user, UNKNOWN, runIdentity, toolContextFor, type WorkStore, type Caller } from '../src/index.js';
import { scheduleWorkflow, pollScheduler, listTriggers, triggerEraser } from '../../scheduler/src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const embed = async () => [1, 0, 0];

describe('extension: cron-agent + a new root-polled log', () => {
  it('a scheduled agent run acts for the trigger owner, is born owned, and is erased with her', async () => {
    const storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    const store = new InMemoryVectorStore();
    await indexDocuments(store, embed, [{ id: 'a', text: 'AYSE invoice', owner: 'ayse' }, { id: 'm', text: 'MEHMET invoice', owner: 'mehmet' }]);
    let seen = '';
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('kb', 'c1', { query: 'invoice' });
      seen = JSON.stringify(prompt); return finalTextResult('digest');
    });
    const gnl = createGnl({ storage, agents: { digest: { model, tools: { kb: createRagTool({ store, embed, topK: 10 }) } } } } as never);
    // The cron-agent: the scheduler's runner contract, mapped onto an agent run. User code, 6 lines.
    // The scheduler hands the trigger's recorded owner as `caller`; the runner passes it straight on.
    const cronAgent = { runWorkflow: async (name: string, _input: unknown, o?: { runId?: string; caller?: Caller }) => {
      const r = await gnl.run(name, { runId: o!.runId!, prompt: 'daily digest', ...(o?.caller ? { caller: o.caller } : {}) });
      return { runId: r.runId ?? o!.runId! };
    } };
    const now = 1_000_000;
    await scheduleWorkflow(journal, { id: 'daily', name: 'digest', every: 1000, resourceId: 'ayse' }, now);
    await pollScheduler(journal, cronAgent as never, now + 5000);
    expect(seen).toContain('AYSE invoice');
    expect(seen).not.toContain('MEHMET invoice');
    const runId = (await journal.listKeys('sched:')).find((k) => k.endsWith(':input'))!.slice(0, -':input'.length);
    expect((await journal.get<{ resourceId?: string }>(`${runId}:input`))?.resourceId).toBe('ayse');
    await eraseSubject(storage, 'ayse', { erasers: [triggerEraser(journal)] });
    expect(await listTriggers(journal)).toEqual([]);
    expect(await journal.get(`${runId}:input`)).toBeUndefined();
  });

  it('a new root-polled log: owner in the name → identity for the consumer and erasure for free', async () => {
    const storage = new InMemoryStorage();
    const work: WorkStore = storage.work!;
    // Producer: an "audit-log" of our own. The owner goes into the engine's owned name, not the payload.
    const append = (payload: unknown, owner: { resourceId?: string }) => work.append('app:audit', payload, ownedName(crypto.randomUUID(), owner));
    await append({ what: 'login' }, { resourceId: 'ayse' });
    await append({ what: 'login' }, { resourceId: 'mehmet' });
    // Consumer: the identity a tool call made from this log runs under comes from the NAME.
    const page = await work.list('app:audit');
    const who = page.items.map((r) => toolContextFor(runIdentity(((o) => (o ? user(o) : UNKNOWN))(ownerOfName(r.id).resourceId), `audit:${r.id}`)).identity);
    expect(who.map((w) => (w.kind === 'user' ? w.id : w.kind))).toEqual(['ayse', 'mehmet']);
    await eraseSubject(storage, 'ayse');
    expect((await work.list('app:audit')).items.map((r) => ownerOfName(r.id).resourceId)).toEqual(['mehmet']);
  });
});
