// An event can say whose it is, and the handler hears it — so the run it starts belongs to that user in
// that organization, the way a queued job's does. Before, `emit` took no owner (one given was dropped),
// the handler saw only `{ id, topic }`, and every event-triggered run was born ownerless.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage } from '@gnldev/durable';
import { emit, createConsumer, EventDepthExceededError, type EventMeta } from '../src/index.js';

async function consume(storage: InMemoryStorage, topic: string) {
  const seen: Array<[unknown, EventMeta]> = [];
  const c = createConsumer(storage.work!, topic, async (p, meta) => { seen.push([p, meta]); }, { name: 'c1' });
  await c.poll();
  return seen;
}

describe('an event carries its owner', () => {
  it('the handler hears the user and the organization, and the payload unchanged', async () => {
    const storage = new InMemoryStorage();
    await emit(storage.work!, 'orders.created', { order: 7 }, { resourceId: 'ayse', orgId: 'acme' });
    const [[payload, meta]] = await consume(storage, 'orders.created') as any;
    expect(payload).toEqual({ order: 7 });
    expect({ r: meta.resourceId, o: meta.orgId }).toEqual({ r: 'ayse', o: 'acme' });
  });

  it('a system event is stored and delivered exactly as before', async () => {
    const storage = new InMemoryStorage();
    await emit(storage.work!, 't', { n: 1 }, { id: 'e1' });
    expect((await storage.work!.list('evt:t')).items[0]?.payload ?? (await storage.work!.list('t')).items[0]?.payload).toEqual({ n: 1 });
    const [[payload, meta]] = await consume(storage, 't') as any;
    expect(payload).toEqual({ n: 1 });
    expect(meta).toEqual({ id: 'e1', topic: 't' });
  });

  it('explicit ids are names within their owner', async () => {
    const storage = new InMemoryStorage();
    const a = await emit(storage.work!, 't', 'A', { id: 'weekly', orgId: 'acme' });
    const b = await emit(storage.work!, 't', 'B', { id: 'weekly', orgId: 'globex' });
    expect(b).not.toBe(a);
    expect((await consume(storage, 't')).map(([p]) => p)).toEqual(['A', 'B']);
  });

  it('emitting into an organization-scoped store is refused, not silently lost', async () => {
    const storage = new InMemoryStorage();
    await expect(emit(withOrgStorage(storage, 'acme').work!, 't', {})).rejects.toThrow(/organization/);
  });

  it('maxDepth is counted per organization', async () => {
    const storage = new InMemoryStorage();
    for (let i = 0; i < 2; i++) await emit(storage.work!, 't', i, { orgId: 'acme', maxDepth: 2 });
    await expect(emit(storage.work!, 't', 9, { orgId: 'acme', maxDepth: 2 })).rejects.toBeInstanceOf(EventDepthExceededError);
    await expect(emit(storage.work!, 't', 9, { orgId: 'globex', maxDepth: 2 })).resolves.toBeTruthy();
  });

  it('a malformed organization or an empty user is refused at emit', async () => {
    const storage = new InMemoryStorage();
    await expect(emit(storage.work!, 't', {}, { orgId: 'a:b' })).rejects.toThrow(/invalid orgId/);
    await expect(emit(storage.work!, 't', {}, { resourceId: '' })).rejects.toThrow(/resourceId/);
  });
});
