// Two runs answering the SAME thread at the same time must not cost the thread any messages.
//
// This is not hypothetical. Measured against a 4-worker PM2 cluster on Postgres: firing the same turn
// three times concurrently with distinct runIds (a double-clicked send, or a client retry) produced
// `HTTP 400 — "Tool result is missing for tool call tc-…"` on 5.6% of requests, while the identical
// load spread across separate threads produced 0.0%. Message counts for what should have been
// identical conversations ranged 12-20 on the shared thread and were exactly 8 on separate ones.
//
// The mechanism is a read-modify-write with no lock. `AgentMemory.append` reads the thread to work
// out the next `seq`, then writes rows at that seq:
//
//     const existing = await this.allMessages(threadId);
//     let seq = existing.length;                       // READ
//     ...                                              // <- another run can write here
//     await this.store.appendMessages(threadId, rows); // WRITE
//
// and every MemoryStore treats `(threadId, seq)` as the idempotency key — Postgres and sqlite with
// `ON CONFLICT (thread_id, seq) DO NOTHING`, InMemoryStorage with `if (seen.has(r.seq)) continue`.
// That key is right for REPLAY (the same run re-appending the same messages is a no-op) and wrong for
// CONCURRENCY: two different messages that computed the same seq are not duplicates of each other,
// and dropping one is silent data loss.
//
// The run-level marker in run.ts (`claimMemoryAppend`) does not cover this. It serialises a single
// run against its own replay, not two runs against one thread.
//
// The second test guards the symptom users see, and cannot REPRODUCE it — say so plainly, because a
// green test that structurally cannot fail is worse than no test. `InMemoryStorage.appendMessages` has
// no `await` in it, so a batch there is all-or-nothing and the partial loss that orphans a tool call
// is unreachable: measured 0/30 here against 16/30 on real Postgres. Reverting the fix leaves this
// test green. It is a regression guard for the invariant, not evidence the defect is closed; that
// evidence is in integration-real.test.ts and in the harness's verify checks 6 and 7.
//
// Partial loss is worse than total loss: if run B's tool-call lands and its tool-result is dropped,
// the thread holds an assistant message whose tool call is never answered, and later turns on that
// thread fail at the provider.
//
// It does eventually recover, and for a reason worth knowing rather than assuming: write-ahead
// persistence (GUIDE §7.3) stores the user's message BEFORE the model is called, so a turn that
// fails still lands its message and still advances the recent-message window. The orphan slides out
// of that window and the thread works again — measured at 5 consecutive failures with the default
// `chat` preset (recentN 10). So the damage is bounded, not permanent. It is still five real errors
// the user saw and five junk messages left in the transcript, and the count scales with `recentN`;
// a preset that recalls older messages can also pull the orphan back in.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const user = (content: string) => ({ role: 'user', content });
const callsTool = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'book', input: {} }],
});
const toolAnswer = (id: string) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'book', output: { type: 'json', value: { ok: true } } }],
});

/** Every tool call in the stored history, and every tool result that answers one. */
function toolIds(messages: any[]): { called: string[]; answered: string[] } {
  const called: string[] = [], answered: string[] = [];
  for (const m of messages) {
    for (const part of Array.isArray(m?.content) ? m.content : []) {
      if (part?.type === 'tool-call') called.push(part.toolCallId);
      if (part?.type === 'tool-result') answered.push(part.toolCallId);
    }
  }
  return { called, answered };
}

async function storedMessages(storage: InMemoryStorage, threadId: string) {
  return (await storage.memory.getMessages(threadId, { limit: 1000 })).items.map((r) => r.message as any);
}

describe('AgentMemory.append under concurrency', () => {
  it('keeps every message when two runs append to one thread at once', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('first turn')]);

    // Both runs read the thread before either writes — the double-click.
    await Promise.all([
      mem.append('t', [callsTool('tc-A'), toolAnswer('tc-A')]),
      mem.append('t', [callsTool('tc-B'), toolAnswer('tc-B')]),
    ]);

    // 1 + 2 + 2. Anything less is a message the user wrote or the model produced, silently gone.
    expect((await storedMessages(storage, 't')).length).toBe(5);
  });

  it('never leaves a tool call without its result', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });

    // Two appends per turn, which is what a run actually does: the user message is written ahead
    // (run.ts:751) and the messages the model produced are appended when the step settles
    // (run.ts:1124). Batches of different lengths starting from different reads are what lets a
    // conflict cover only PART of a batch — total loss keeps the history consistent, partial loss
    // does not.
    const turn = (id: string, text: string) => async () => {
      await mem.append('t', [user(text)]);
      await mem.append('t', [callsTool(id), toolAnswer(id)]);
    };
    await Promise.all([turn('tc-A', 'a')(), turn('tc-B', 'b')()]);

    const { called, answered } = toolIds(await storedMessages(storage, 't'));
    // An orphan here is what the provider rejects with "Tool result is missing for tool call X",
    // and it does so on every subsequent turn until the orphan slides out of the memory window —
    // measured at 5 consecutive failures with the default preset, each one a real error for the user.
    expect([...called].sort()).toEqual([...answered].sort());
  });

  it('the STORE keeps its own idempotency contract for identical rows', async () => {
    // Deliberately at the store, not through AgentMemory. `MemoryStore.appendMessages` is documented
    // as "per-message idempotent (CAS)", and it is: the same (threadId, seq) written twice leaves one
    // row. What is NOT true — and what the first version of this test wrongly assumed — is that
    // `AgentMemory.append` inherits that. Called twice with the same batch it reads a longer thread
    // the second time, computes fresh seqs, and writes a second copy (measured: 6 rows for 3
    // messages). Replay safety comes from the run-level marker in run.ts, not from this key.
    const storage = new InMemoryStorage();
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    const rows = [0, 1, 2].map((seq) => ({ threadId: 't', seq, role: 'user', text: `m${seq}`, ts: 1, message: user(`m${seq}`) }));

    await storage.memory.appendMessages('t', rows);
    await storage.memory.appendMessages('t', rows);

    expect((await storedMessages(storage, 't')).length).toBe(3);
  });
});
