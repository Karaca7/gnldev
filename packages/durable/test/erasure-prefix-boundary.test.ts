// R17: erasing `bob` must not delete `bob:evil`'s keys. User ids may contain ':', and the person-keyed
// families (`xid:res:<rid>:`, `lesson:res:<rid>:`, `suggstats:lesson:res:<rid>:`, `resthr:<rid>:`) were
// erased by a raw prefix delete — measured before this: `bob:evil`'s cross-channel id, lesson and
// lesson counter were all gone after `purgeResource(journal, 'bob')`.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, InMemoryJournal, toJournal, purgeResource } from '../src/index.js';
import { xidKey } from '../src/xid.js';
import { personalLessonKey } from '../src/suggestions.js';
import { ownershipTraceKey } from '../src/retention.js';

const xid = (rid: string, tool: string) => ({ key: xidKey(rid, tool, { order: 'o-1' }), value: { v: 1, toolName: tool, identity: { order: 'o-1' }, amounts: {}, first: { runId: 'r', toolCallId: 't', at: 1 } } });

async function seed() {
  const journal = toJournal(new InMemoryStorage().runs);
  const keys: Record<string, string> = {};
  for (const [name, rid, tool] of [['bobXid', 'bob', 'send'], ['evilXid', 'bob:evil', 'send'], ['bobNsTool', 'bob', 'ns:send'], ['pctXid', 'bob%3Aevil', 'send']] as const) {
    const x = xid(rid, tool);
    await journal.put(x.key, x.value);
    keys[name] = x.key;
  }
  keys.bobLesson = personalLessonKey('bob', '5b2d4f0e-1111-4222-8333-944455556666');
  keys.evilLesson = personalLessonKey('bob:evil', '5b2d4f0e-1111-4222-8333-944455556666');
  keys.bobStats = `suggstats:${keys.bobLesson}`;
  keys.evilStats = `suggstats:${keys.evilLesson}`;
  keys.bobTrace = ownershipTraceKey('bob', 'th-b');
  keys.evilTrace = ownershipTraceKey('bob:evil', 'th-e');
  for (const k of [keys.bobLesson, keys.evilLesson, keys.bobStats, keys.evilStats, keys.bobTrace, keys.evilTrace]) await journal.put(k!, { at: 1 });
  // bob:evil's thread state, which a misread trace (`evil:th-e`) must not reach either.
  await journal.put('mem:th-e:messages', [{ text: 'EVIL-THREAD' }]);
  return { journal, keys };
}

describe('a person-keyed family ends where the person\'s id ends', () => {
  it('erasing bob keeps every key of bob:evil — xid, lesson, counter, trace, thread', async () => {
    const { journal, keys } = await seed();
    await purgeResource(journal, 'bob');
    const left = async (k: string) => (await journal.get(k)) !== undefined;
    expect({
      evilXid: await left(keys.evilXid!), evilLesson: await left(keys.evilLesson!), evilStats: await left(keys.evilStats!),
      evilTrace: await left(keys.evilTrace!), evilThread: await left('mem:th-e:messages'), pctXid: await left(keys.pctXid!),
    }).toEqual({ evilXid: true, evilLesson: true, evilStats: true, evilTrace: true, evilThread: true, pctXid: true });
  });

  it('and still erases all of bob\'s own — including a tool name that contains a colon', async () => {
    const { journal, keys } = await seed();
    await purgeResource(journal, 'bob');
    const gone = async (k: string) => (await journal.get(k)) === undefined;
    expect({
      bobXid: await gone(keys.bobXid!), bobNsTool: await gone(keys.bobNsTool!), bobLesson: await gone(keys.bobLesson!),
      bobStats: await gone(keys.bobStats!), bobTrace: await gone(keys.bobTrace!),
    }).toEqual({ bobXid: true, bobNsTool: true, bobLesson: true, bobStats: true, bobTrace: true });
  });

  it('erasing bob:evil takes only bob:evil\'s, not bob\'s', async () => {
    const { journal, keys } = await seed();
    await purgeResource(journal, 'bob:evil');
    expect(await journal.get(keys.evilXid!)).toBeUndefined();
    expect(await journal.get(keys.evilLesson!)).toBeUndefined();
    expect(await journal.get(keys.evilTrace!)).toBeUndefined();
    expect(await journal.get(keys.bobXid!)).toBeDefined();
    expect(await journal.get(keys.bobLesson!)).toBeDefined();
    expect(await journal.get(keys.bobTrace!)).toBeDefined();
  });

  it('lesson COUNTER rows (invisible to a key listing): bob\'s go, bob:evil\'s stay', async () => {
    const journal = new InMemoryJournal();
    const id = '5b2d4f0e-1111-4222-8333-944455556666';
    await journal.put(personalLessonKey('bob', id), { v: 1 });
    await journal.put(personalLessonKey('bob:evil', id), { v: 1 });
    await journal.incrBy!(`suggstats:${personalLessonKey('bob', id)}`, { injected: 2 });
    await journal.incrBy!(`suggstats:${personalLessonKey('bob:evil', id)}`, { injected: 5 });
    await purgeResource(journal, 'bob');
    expect(await journal.getCounters!(`suggstats:${personalLessonKey('bob', id)}`)).toBeUndefined();
    expect((await journal.getCounters!(`suggstats:${personalLessonKey('bob:evil', id)}`))?.injected).toBe(5);
    expect(await journal.get(personalLessonKey('bob:evil', id))).toBeDefined();
  });

  it('an id with neither ":" nor "%" keeps its trace key byte for byte', () => {
    expect(ownershipTraceKey('ayse', 'tenant:7:chat')).toBe('resthr:ayse:tenant:7:chat');
    expect(ownershipTraceKey('bob:evil', 't')).toBe('resthr:bob%3Aevil:t');
  });
});
