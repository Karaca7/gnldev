// Cross-thread recall (`scope: 'resource'`) is the memory package's headline feature: the user says
// something in one conversation and the assistant still knows it in the next one. It never fired on
// a new thread.
//
// composeTrack1 short-circuited on `all.length <= recentN`, where `all` is THIS thread's history. For
// thread scope that is a sound optimisation — if the whole conversation fits in the recent window
// there is nothing left to recall. For resource scope it is simply the wrong question, because the
// recall reaches the user's OTHER threads and the current thread's length says nothing about them.
//
// With the shipped `assistant` preset (recentN: 8) the feature was off for the first four exchanges
// of every new conversation — precisely the "do you remember me?" turns.
//
// The existing test asked from the OLD thread, which already had more messages than recentN, so the
// gate was open and the bug invisible. This one asks from the new thread, at every length below the
// threshold.
import { describe, it, expect } from 'vitest';
import { AgentMemory } from '../src/index.js';
import { InMemoryStorage } from '@gnldev/durable';

/** Deterministic pseudo-embedding: same text → same vector, similar text → similar vector. */
const DIMS = ['refund', 'joke', 'weather', 'postcode'];
const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1);
};

const u = (content: string) => ({ role: 'user', content });

async function seedOtherThread(mem: AgentMemory) {
  await mem.createThread({ id: 'thread-old', resourceId: 'user-1' });
  await mem.createThread({ id: 'thread-new', resourceId: 'user-1' });
  await mem.append('thread-old', [u('refund policy lives here'), u('noted'), u('and a joke')]);
}

describe("scope: 'resource' on a brand-new thread", () => {
  for (const own of [0, 1, 2, 3]) {
    it(`recalls from the user's other threads with ${own} message(s) of its own`, async () => {
      const mem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 2 });
      await seedOtherThread(mem);
      if (own) await mem.append('thread-new', Array.from({ length: own }, (_, i) => u(`unrelated ${i}`)));

      // getMessages takes the scope directly, which is the surface composeTrack1 sits behind.
      const msgs = await mem.getMessages('thread-new', {
        query: 'refund',
        resourceId: 'user-1',
        scope: 'resource',
      });

      expect(JSON.stringify(msgs), `own=${own}`).toContain('refund policy lives here');
    });
  }

  it("thread scope keeps its short-circuit — a conversation inside the window recalls nothing extra", async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 8 });
    await seedOtherThread(mem);
    await mem.append('thread-new', [u('hello')]);

    const msgs = await mem.getMessages('thread-new', {
      query: 'refund',
      resourceId: 'user-1',
      scope: 'thread',
    });
    expect(JSON.stringify(msgs)).not.toContain('refund policy lives here');
  });
});
