// GET /threads?resourceId= — the filter that silently did nothing.
//
// `StudioMemory` declared `listThreads(resourceId?: string)` and this route called it with a bare
// string. The store hosts actually pass — @gnldev/memory's `AgentMemory` — reads `opts.resourceId`,
// so the id landed nowhere, `resourceId` came out `undefined`, and the underlying page query ran
// UNFILTERED. Measured against the real AgentMemory with two threads owned by two different
// resources: asking for one resource's threads returned both.
//
// Nothing caught it because Studio had written its own structural type for someone else's method, so
// the two shapes had no common declaration to disagree in. The contract now lives on
// `Memory.listThreads`/`listAllThreads` in @gnldev/durable and `StudioMemory` mirrors it — this file
// is the behavioural half: the stub REFUSES the old call shape instead of quietly tolerating it, so a
// caller that regresses fails loudly here rather than serving one user another user's conversations.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, type StudioMemory } from '../src/server.js';
import { call } from './call.js';

const THREADS = [
  { id: 't-ayse', resourceId: 'u-ayse' },
  { id: 't-mehmet', resourceId: 'u-mehmet' },
];

function strictMemory(): StudioMemory {
  return {
    // The object argument is the point. A bare string throws rather than being ignored — mirroring
    // AgentMemory, where ignoring it is exactly what unfiltered the answer.
    listThreads: (opts: { resourceId: string }) => {
      if (typeof opts !== 'object' || opts === null) {
        throw new TypeError('listThreads takes { resourceId }, not a bare id');
      }
      return THREADS.filter((t) => t.resourceId === opts.resourceId);
    },
    listAllThreads: () => THREADS,
    getMessages: () => [],
  } as StudioMemory;
}

const app = () => createStudioApi({ reader: new InMemoryJournal(), memory: strictMemory() });

describe('Studio GET /threads', () => {
  it('?resourceId= returns ONLY that resource’s threads', async () => {
    const res = await call(app(), '/threads?resourceId=u-ayse');
    expect(res.status).toBe(200);
    // The distinguishing assertion: not "some threads came back" but "the other user's did not".
    // The broken implementation returned both and looked like a working filter.
    expect(await res.json()).toEqual([{ id: 't-ayse', resourceId: 'u-ayse' }]);
  });

  it('no ?resourceId= is the operator view — every thread', async () => {
    expect(await (await call(app(), '/threads')).json()).toHaveLength(2);
  });

  it('an empty ?resourceId= is treated as absent, not as a resource named ""', async () => {
    // `?resourceId=` with nothing after it is what a client sends when its variable is empty. Reading
    // it as a real id would filter to a resource that cannot exist and answer an empty list, which
    // reads as "this user has no conversations" rather than "you forgot to fill this in".
    expect(await (await call(app(), '/threads?resourceId=')).json()).toHaveLength(2);
  });

  it('a store with no global listing answers empty rather than throwing', async () => {
    // `listAllThreads` is optional on the contract: a custom adapter may only be able to answer for
    // one resource at a time. The unfiltered route must degrade, not fail.
    const partial = { listThreads: () => [], getMessages: () => [] } as unknown as StudioMemory;
    const res = await call(createStudioApi({ reader: new InMemoryJournal(), memory: partial }), '/threads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
