// A runId is a key PREFIX, and three places treated it as if it were an identifier.
//
// runid-key-family.test.ts already pins the first half of that lesson: a runId may not CLAIM a
// family the journal owns (`mem`, `xid`, …). This file is the second half — the ones where a runId
// is legal, sits in nobody else's family, and still reaches another run's records:
//
//   (a) `:model:` / `:tool:` INSIDE a runId. parseJournalKey matches `^(.*):(model|tool):.+$`
//       greedily, so `pipeline:tool:x` writing `pipeline:tool:x:model:0` is read back as run
//       `pipeline` with kind `tool` — the id has manufactured a journal record for a run that is not
//       its own. The chat adapter DERIVES runIds from client-supplied ids (`${body.id}:${msg.id}`),
//       so this is reachable from outside, not only from a careless caller.
//
//   (b) `mem-appended:<runId>` has no trailing separator, so purgeRun's prefix delete of
//       `mem-appended:r-1` also takes `mem-appended:r-10`. The same shape was already fixed once for
//       `wfrun:<runId>` (retention.ts deleteExactKey) and these two were missed.
//
//   (c) `${runId}:` captures a run whose id EXTENDS this one. purgeRun('conv') deletes every key
//       under `conv:` — which is exactly where run `conv:msg1` lives. Two legitimate runs, one
//       purge, one of them collateral.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, purgeRun, assertRunIdSafe } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

describe('(a) a runId may not carry the journal\'s own record separators', () => {
  it("rejects ':tool:' and ':model:' inside the id", () => {
    expect(() => assertRunIdSafe('pipeline:tool:x')).toThrow(/tool:/);
    expect(() => assertRunIdSafe('pipeline:model:0')).toThrow(/model:/);
    // Also when it is the tail — `x:tool:` still lands inside the greedy match of a derived key.
    expect(() => assertRunIdSafe('a:tool:b:c')).toThrow();
  });

  it('a plain colonful id — the chat adapter\'s own derivation — still passes', () => {
    // `${body.id}:${lastMessage.id}` is the documented default runId of @gnldev/chat-adapter. If this
    // ever throws, every useChat conversation stops, so the rule must stay narrower than "no colons".
    expect(() => assertRunIdSafe('chatA1:msgX9')).not.toThrow();
    expect(() => assertRunIdSafe('conv:msg1')).not.toThrow();
    // The engine's own composite ids keep working (they are constructed here, not supplied).
    expect(() => assertRunIdSafe('agent:parent-1:call-9')).not.toThrow();
    expect(() => assertRunIdSafe('wf:parent-1:call-9')).not.toThrow();
    // A tool NAMED in a segment is fine — only the `:tool:`/`:model:` separator shape is refused.
    expect(() => assertRunIdSafe('tools-run-1')).not.toThrow();
    expect(() => assertRunIdSafe('model-eval:7')).not.toThrow();
  });
});

describe.each([
  ['InMemory', () => new InMemoryJournal() as any],
  ['Sqlite', () => new SqliteStorage(':memory:').runs as any],
])('(b) purgeRun does not prefix-capture a neighbour\'s memory markers (%s)', (_name, make) => {
  it("purging r-1 leaves r-10's mem-appended / mem-user-appended markers", async () => {
    const journal = make();
    await journal.put(runKeys.model('r-1', 0), { content: [] });
    await journal.put(runKeys.memAppended('r-1'), true);
    await journal.put(runKeys.memUserAppended('r-1'), true);
    // The neighbour whose id EXTENDS r-1 — the boundary purge.test.ts already protects for `${runId}:`
    // keys (which carry a trailing colon) but not for these two, which do not.
    await journal.put(runKeys.model('r-10', 0), { content: [] });
    await journal.put(runKeys.memAppended('r-10'), true);
    await journal.put(runKeys.memUserAppended('r-10'), true);

    await purgeRun(journal, 'r-1');

    expect(await journal.get(runKeys.memAppended('r-1'))).toBeUndefined();
    expect(await journal.get(runKeys.memUserAppended('r-1'))).toBeUndefined();
    expect(await journal.get(runKeys.memAppended('r-10'))).toBe(true);
    expect(await journal.get(runKeys.memUserAppended('r-10'))).toBe(true);
    expect(await journal.get(runKeys.model('r-10', 0))).toBeDefined();
  });
});

describe.each([
  ['InMemory', () => new InMemoryJournal() as any],
  ['Sqlite', () => new SqliteStorage(':memory:').runs as any],
])('(c) purgeRun does not swallow a run whose id extends it (%s)', (_name, make) => {
  it("purgeRun('conv') leaves run 'conv:msg1' whole", async () => {
    const journal = make();
    // Both are ordinary runs. `conv:msg1` is precisely the shape @gnldev/chat-adapter derives per
    // turn (`${conversationId}:${messageId}`), so a host that ALSO runs something under the bare
    // conversation id has this pair by accident, not by misuse.
    await journal.put(runKeys.model('conv', 0), { content: ['parent'] });
    await journal.put(runKeys.input('conv'), { prompt: 'parent prompt', _v: 1 });
    await journal.put(runKeys.model('conv:msg1', 0), { content: ['neighbour'] });
    await journal.put(runKeys.tool('conv:msg1', 'c9'), { status: 'succeeded', output: 7 });
    await journal.put(runKeys.input('conv:msg1'), { prompt: 'neighbour prompt', _v: 1 });
    await journal.put(runKeys.cfgModel('conv:msg1'), { spec: 'm/1' });

    await purgeRun(journal, 'conv');

    // The target is gone…
    expect(await journal.get(runKeys.model('conv', 0))).toBeUndefined();
    expect(await journal.get(runKeys.input('conv'))).toBeUndefined();
    // …and the neighbour is untouched, down to the records that carry its PII.
    expect(await journal.get(runKeys.model('conv:msg1', 0))).toBeDefined();
    expect(await journal.get(runKeys.tool('conv:msg1', 'c9'))).toBeDefined();
    expect(await journal.get(runKeys.input('conv:msg1'))).toBeDefined();
    expect(await journal.get(runKeys.cfgModel('conv:msg1'))).toBeDefined();
  });

  it('with no extending neighbour, the whole `${runId}:` namespace still goes', async () => {
    const journal = make();
    await journal.put(runKeys.model('solo', 0), { content: [] });
    await journal.put(runKeys.input('solo'), { prompt: 'p', _v: 1 });
    await journal.put(runKeys.cfgModel('solo'), { spec: 'm/1' });
    await journal.put(runKeys.proc('solo', 'redact'), { out: 1 });

    const deleted = await purgeRun(journal, 'solo');

    expect(deleted).toBeGreaterThanOrEqual(4);
    expect(await journal.get(runKeys.model('solo', 0))).toBeUndefined();
    expect(await journal.get(runKeys.input('solo'))).toBeUndefined();
    expect(await journal.get(runKeys.cfgModel('solo'))).toBeUndefined();
    expect(await journal.get(runKeys.proc('solo', 'redact'))).toBeUndefined();
  });
});
