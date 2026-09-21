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

  it('WHY it is refused: the poisoned key reads as a run, and a sweep takes the whole keyspace', async () => {
    // This is the damage the guard prevents, demonstrated on the raw journal rather than through a
    // builder — otherwise the test would only prove the builder throws, not why it should.
    const j = new InMemoryJournal();
    await j.put('mem:alice:messages', [{ role: 'user', content: 'hi', ts: Date.now() }]);
    await j.put('mem:bob:messages', [{ role: 'user', content: 'hi', ts: Date.now() }]);
    await j.put('mem:model:working', 'the poison'); // what a hand-built key used to produce

    expect(parseJournalKey('mem:alice:messages')).toBeNull();
    expect(parseJournalKey('mem:model:working')).toEqual({ runId: 'mem', kind: 'model' });

    const r = await sweepRuns(j, { olderThanMs: 0, now: Date.now() + 10 ** 12 });
    expect(r.purged).toEqual(['mem']); // one "run" — which is the entire mem: keyspace

    const after = await j.listKeys('');
    expect(after, "two unrelated users' threads went with it").toEqual([]);
  });
});
