// A caller-supplied thread id becomes a key SEGMENT, and `parseJournalKey` claims any key with a
// `:model:` or `:tool:` segment as a run record — whatever namespace it started in. So an id named
// 'model' does not look odd, it RENAMES ITS OWN KEYSPACE, and the next sweep purges that "run" by
// prefix.
//
// The check existed before this file, in exactly one place: memKey. Nothing held it — the guard
// carried a comment citing an audit ("an unrelated user's messages went 1 → 0") and no test — and
// more importantly `mem:` was not the only door. Measured before the rule moved beside the regex
// that creates it:
//
//   rag's SemanticMemory wrote `mem:model:working` by hand   → sweepRuns purged 'mem',  2 users gone
//   durable's own semKey wrote `xthr:model:sem-pay-…`        → sweepRuns purged 'xthr', 2 users' dedup gone
//
// The second one needs no memory configured at all: a deployment using threadId purely for
// idempotency never calls memKey, which is the shape retention.ts names in its own comment.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, parseJournalKey, assertThreadId, memKey, runKeys } from '../src/index.js';
import { semKey, semTombKey } from '../src/semantic-dup.js';
import { semJudgeKey } from '../src/semantic-judge.js';
import { sweepRuns, listOrphanThreadState } from '../src/retention.js';

const POISON = ['model', 'tool', 'a:model', 'model:b', 'x:tool:y'];

// Listed by hand on purpose: a new builder is a new door, and both properties below read this ONE
// list — the guard, and retention's ability to read the key back.
const BUILDERS: Array<[string, (t: string) => string]> = [
  ['memKey', (t) => memKey(t, 'working')],
  ['runKeys.toolThread', (t) => runKeys.toolThread(t, 'pay', 'h')],
  ['semKey', (t) => semKey(t, 'pay', 'h')],
  ['semTombKey', (t) => semTombKey(t, 'pay', 'h1', 'h2')],
  ['semJudgeKey', (t) => semJudgeKey(t, 'pay', 'h1', 'h2')],
];

describe('a thread id cannot rename its own keyspace', () => {
  it('EVERY key builder that takes a thread id refuses the two reserved words', () => {
    for (const [name, build] of BUILDERS) {
      for (const bad of POISON) {
        expect(() => build(bad), `${name} accepted '${bad}'`).toThrow(/collide with the journal's key schema/);
      }
      // …and the CONTROL half: a guard that refuses everything protects nothing, and an id with a
      // colon in it must still work — sweepThreads' suffix inference has always supported those.
      expect(() => build('alice'), `${name} rejected a sound id`).not.toThrow();
      expect(() => build('acme:alice'), `${name} rejected a colon id`).not.toThrow();
    }
  });

  it('and retention can read back what every one of them writes', async () => {
    // The other half of the same list, and the reason it lives in ONE test: retention recovers a
    // thread id out of `xthr:<threadId>:<family>-…` by matching a KNOWN family, because a thread id
    // may contain ':'. That list is written by hand in retention.ts, and nothing bound it to the
    // builders — so a new family arrives, the sweep stops recognising its keys, and the thread they
    // belong to is reported as state whose run is gone.
    //
    // Adding a builder above without registering its family here turns this red, which is the point:
    // one list, two properties.
    for (const [name, build] of BUILDERS) {
      const j = new InMemoryJournal();
      await j.put('mem:th-live:messages', [{ role: 'user', content: 'hi', ts: Date.now() }]);
      const key = build('th-live');
      if (!key.startsWith('xthr:')) continue; // memKey writes `mem:`, covered by the orphan tests
      await j.put(key, { v: 1 });

      const r = await listOrphanThreadState(j);
      expect(r.unrecognisedKeys, `${name} writes a family retention cannot read: ${key}`).toEqual([]);
      expect(r.threadIds, `${name}'s key made a LIVE thread look orphaned`).toEqual([]);
    }
  });

  it('the word must be a whole SEGMENT — a thread called "models" is fine', () => {
    // The hazard is the regex `(^|:)(model|tool)(:|$)`, not the substring. Rejecting 'models' would
    // be a guard that fires on innocent ids, which is how a safety check gets turned off.
    for (const ok of ['models', 'toolbox', 'remodel', 'my-model', 'tooling']) {
      expect(() => assertThreadId(ok), `'${ok}' is not a reserved segment`).not.toThrow();
    }
  });

  it('WHY it is refused — and the second line of defence, for the poison already written', async () => {
    // Two halves, and they close different windows. The guard above stops NEW keys of this shape.
    // This one is about the ones already in somebody's database: the index row froze at write time,
    // so no upgrade reaches it. Measured on real Postgres and real Redis, before the sweep learned
    // to ask: `purged: ['mem']`, two unrelated users' threads gone, in one sweep.
    const j = new InMemoryJournal();
    await j.put('mem:alice:messages', [{ role: 'user', content: 'hi', ts: Date.now() }]);
    await j.put('mem:bob:messages', [{ role: 'user', content: 'hi', ts: Date.now() }]);
    await j.put('mem:model:working', 'the poison'); // what a hand-built key used to produce

    // The key still READS as a run, and that stays true on purpose: parseJournalKey answers a shape
    // question that replay depends on, and tightening it drops real records (a batch item's
    // toolCallId contains ':' — measured, 54 adapter-conformance tests red).
    expect(parseJournalKey('mem:alice:messages')).toBeNull();
    expect(parseJournalKey('mem:model:working')).toEqual({ runId: 'mem', kind: 'model' });

    // What changed is where the strictness sits: at the point the delete is SPENT.
    const r = await sweepRuns(j, { olderThanMs: 0, now: Date.now() + 10 ** 12 });
    expect(r.purged, 'a row no run ever wrote must not be purged by prefix').toEqual([]);
    expect(r.skippedGhosts, 'and the refusal is NAMED, not silent').toEqual(['mem']);

    const after = await j.listKeys('');
    expect(after.sort(), "the two users' threads are still there").toEqual([
      'mem:alice:messages', 'mem:bob:messages', 'mem:model:working',
    ]);
  });

  it('CONTROL: a real run is still swept — the guard must not stop retention', async () => {
    // A guard that refuses everything is a leak, not a fix: unswept runs grow forever. `:input` is
    // the rule precisely because every real run has one, including a run that died at step 0.
    const j = new InMemoryJournal();
    await j.put('r-real:input', { _v: 2, prompt: 'x' });
    await j.put('r-real:model:0', { content: [] });
    await j.put('r-early:input', { _v: 2, prompt: 'died before step 1' });

    const r = await sweepRuns(j, { olderThanMs: 0, now: Date.now() + 10 ** 12 });
    expect(r.purged.sort()).toEqual(['r-early', 'r-real']);
    expect(r.skippedGhosts).toBeUndefined();
  });
});
