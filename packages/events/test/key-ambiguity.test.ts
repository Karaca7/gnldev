// Key AMBIGUITY: two different, legitimate (topic, consumer) pairs must never address the same
// marker key.
//
// MEASURED BUG (A3): every marker is built by concatenation — `evtack:${topic}:${consumer}:${id}` —
// and `:` is both the delimiter and a character callers legitimately put in names (`billing:eu`,
// `orders:created`, an URN event id). So topic `a` + consumer `b:c` and topic `a:b` + consumer `c`
// produced the SAME key:
//
//   c1 poll -> 1  saw: [{"which":"TOPIC-A payload"}]
//   c2 poll -> 0  saw: []
//   c2 second poll -> 0  saw: []            <- permanent
//   evtack:a:b:c:order-42 = true
//   c2 quarantined: []                      <- not in the dead-letter either
//
// The first consumer's ack marker made the second one's event invisible: never delivered, never
// quarantined, never logged. That is silent, permanent loss of the at-least-once delivery this
// package exists to provide, so it gets a file of its own — one test per key family, because the
// same concatenation is used by all five (ack, attempt, dead-letter, cursor, rescan) and a fix that
// covers four of them still loses events.
//
// The names below are deliberately short (`a`, `b:c`) so the collision is visible at a glance; they
// stand in for the realistic pairs (`billing:eu` + `emailer` vs `billing` + `eu:emailer`) that
// motivate this, one of which is pinned at the bottom.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '../src/index.js';

/** The colliding pair: both spellings of "a : b : c" split across topic and consumer. */
const T1 = 'a', C1 = 'b:c'; // topic 'a',   consumer 'b:c'
const T2 = 'a:b', C2 = 'c'; // topic 'a:b', consumer 'c'

describe('@gnldev/events — a `:` in a name may not collapse two identities into one key', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  // ackKey — the original repro. One consumer's "I delivered this" swallows another's event.
  it('an ack marker under one identity does not swallow the other identity\'s event', async () => {
    const work = new InMemoryStorage().work;
    const ID = 'order-42';
    await emit(work, T1, { which: 'topic-a' }, { id: ID });
    await emit(work, T2, { which: 'topic-a:b' }, { id: ID });

    const saw1: any[] = [];
    const saw2: any[] = [];
    const c1 = createConsumer(work, T1, (p: any) => void saw1.push(p), { name: C1 });
    const c2 = createConsumer(work, T2, (p: any) => void saw2.push(p), { name: C2 });

    expect(await c1.poll()).toBe(1);
    expect(await c2.poll()).toBe(1); // 0 = c1's marker made this event invisible
    expect(saw1).toEqual([{ which: 'topic-a' }]);
    expect(saw2).toEqual([{ which: 'topic-a:b' }]);

    // ...and it is still exactly-once for each of them.
    expect(await c1.poll()).toBe(0);
    expect(await c2.poll()).toBe(0);
    expect(saw1).toHaveLength(1);
    expect(saw2).toHaveLength(1);
  });

  // attKey — one consumer's retry backoff must not park another consumer's healthy event.
  it('a retry backoff under one identity does not park the other identity\'s event', async () => {
    const work = new InMemoryStorage().work;
    const ID = 'p';
    await emit(work, T1, { which: 'topic-a' }, { id: ID });
    await emit(work, T2, { which: 'topic-a:b' }, { id: ID });

    // c1 fails once → its attempt record parks the event for the default 60s.
    const c1 = createConsumer(work, T1, () => { throw new Error('boom'); }, { name: C1 });
    expect(await c1.poll()).toBe(0);

    // c2's handler is healthy and its event has never failed, so nothing may hold it back.
    const saw2: any[] = [];
    const c2 = createConsumer(work, T2, (p: any) => void saw2.push(p), { name: C2 });
    expect(await c2.poll()).toBe(1); // 0 = c2 inherited c1's 60s backoff
    expect(saw2).toEqual([{ which: 'topic-a:b' }]);
  });

  // deadKey — a quarantine under one identity must not dead-letter another identity's event, which
  // is worse than plain loss: `listDeadEvents` reports the victim as quarantined with someone
  // else's error message, so the operator's own tooling confirms a failure that never happened.
  it('a quarantine under one identity does not quarantine the other identity\'s event', async () => {
    const work = new InMemoryStorage().work;
    const ID = 'p';
    await emit(work, T1, { which: 'topic-a' }, { id: ID });
    await emit(work, T2, { which: 'topic-a:b' }, { id: ID });

    const c1 = createConsumer(work, T1, () => { throw new Error('c1 handler is broken'); },
      { name: C1, maxAttempts: 1, retryDelayMs: 0 });
    await c1.poll();
    expect((await listDeadEvents(work, T1, C1))[0]!.status).toBe('quarantined');

    const saw2: any[] = [];
    const c2 = createConsumer(work, T2, (p: any) => void saw2.push(p), { name: C2, retryDelayMs: 0 });
    expect(await c2.poll()).toBe(1); // 0 = c2's event was skipped as "we gave up on it"
    expect(saw2).toEqual([{ which: 'topic-a:b' }]);
    expect(await listDeadEvents(work, T2, C2)).toEqual([]); // ...and no phantom dead-letter record
  });

  // cursorKeyOf — the read bookmark. A cursor is only persisted once a full page is consumed, so
  // this needs more than one page (default page size 50).
  it('a scan bookmark under one identity does not skip the other identity\'s log', async () => {
    const work = new InMemoryStorage().work;
    const N = 60;
    // DIFFERENT event ids per topic, so the ack markers cannot collide: this test must fail for the
    // cursor and nothing else.
    for (let i = 0; i < N; i++) await emit(work, T1, { id: `x${i}` }, { id: `x${i}` });
    for (let i = 0; i < N; i++) await emit(work, T2, { id: `y${i}` }, { id: `y${i}` });

    const seen1: string[] = [];
    const seen2: string[] = [];
    const c1 = createConsumer(work, T1, (p: any) => void seen1.push(p.id), { name: C1 });
    const c2 = createConsumer(work, T2, (p: any) => void seen2.push(p.id), { name: C2 });

    expect(await c1.poll()).toBe(N); // c1 drains its log and persists a bookmark past page 1
    expect(await c2.poll()).toBe(N); // 10 = c2 started from c1's bookmark and never saw y0..y49
    expect(seen2).toContain('y0');
    expect(seen2).toHaveLength(N);

    // The events c2 skipped would be gone for good: the bookmark only ever moves forwards.
    expect(await c2.poll()).toBe(0);
    expect(seen2).toHaveLength(N);
    expect(seen1).toHaveLength(N);
  });

  // rescanKeyOf (with cursorKeyOf — the two are keyed by the same pair, so they collide together).
  // A release arms a one-pass rescan flag; a colliding consumer clears the flag at the end of ITS
  // pass and leaves the shared bookmark parked forward, so the operator's release evaporates: the
  // event stays `released` and unreachable, which is the leak K1 was fixed to make impossible.
  it('a release under one identity is not swallowed by the other identity\'s poll', async () => {
    const work = new InMemoryStorage().work;
    const N = 60;
    const POISON = 'x3'; // page 1 → quarantine unfreezes the bookmark past it
    for (let i = 0; i < N; i++) await emit(work, T1, { id: `x${i}` }, { id: `x${i}` });
    for (let i = 0; i < N; i++) await emit(work, T2, { id: `y${i}` }, { id: `y${i}` });

    const seen1: string[] = [];
    let broken = true;
    const c1 = createConsumer(work, T1, (p: any) => {
      if (p.id === POISON && broken) throw new Error('boom');
      seen1.push(p.id);
    }, { name: C1, maxAttempts: 1, retryDelayMs: 0 });
    const c2 = createConsumer(work, T2, () => {}, { name: C2 });

    expect(await c1.poll()).toBe(N - 1);
    expect((await listDeadEvents(work, T1, C1))[0]!.status).toBe('quarantined');

    broken = false;
    expect(await retryDeadEvent(work, T1, C1, POISON)).toBe(true);
    await c2.poll(); // an unrelated consumer's ordinary pass — it may not consume c1's release

    expect(await c1.poll()).toBe(1); // 0 = the release was swallowed; x3 is unreachable forever
    expect(seen1).toContain(POISON);
    expect((await listDeadEvents(work, T1, C1))[0]!.status).toBe('delivered');
  });

  // The realistic version of the same pair, so this file is not only about `a`/`b:c`. A regional
  // topic and a namespaced consumer name are ordinary things to write.
  it('realistic names: billing:eu + emailer vs billing + eu:emailer stay separate', async () => {
    const work = new InMemoryStorage().work;
    await emit(work, 'billing:eu', { region: 'eu' }, { id: 'inv-1' });
    await emit(work, 'billing', { region: 'global' }, { id: 'inv-1' });

    const eu: any[] = [];
    const global: any[] = [];
    const cEu = createConsumer(work, 'billing:eu', (p: any) => void eu.push(p), { name: 'emailer' });
    const cGlobal = createConsumer(work, 'billing', (p: any) => void global.push(p), { name: 'eu:emailer' });

    expect(await cGlobal.poll()).toBe(1);
    expect(await cEu.poll()).toBe(1);
    expect(eu).toEqual([{ region: 'eu' }]);
    expect(global).toEqual([{ region: 'global' }]);
  });

  // The boundary between the CONSUMER and the EVENT ID, on one topic. Escaping the topic alone
  // separates every pair above, so this is the case that says the consumer component is escaped in
  // its own right: consumer `b:c` + event `d` and consumer `b` + event `c:d` are the same
  // `evtack:t:b:c:d` otherwise. Event ids are caller-chosen too (an order key, a URN), so this is
  // the same "reasonable name" argument one component over.
  it('the consumer/event-id boundary is not ambiguous either', async () => {
    const work = new InMemoryStorage().work;
    await emit(work, 't', { id: 'd' }, { id: 'd' });
    await emit(work, 't', { id: 'c:d' }, { id: 'c:d' });

    const seen1: string[] = [];
    const seen2: string[] = [];
    const c1 = createConsumer(work, 't', (p: any) => void seen1.push(p.id), { name: 'b:c' });
    const c2 = createConsumer(work, 't', (p: any) => void seen2.push(p.id), { name: 'b' });

    expect(await c1.poll()).toBe(2);
    expect(await c2.poll()).toBe(2); // 1 = c1's marker for event 'd' hid event 'c:d' from c2
    expect(seen2.sort()).toEqual(['c:d', 'd']);
  });

  // Guard on the FIX rather than a repro of the original bug (this one was green before the escape
  // existed): an escape is only worth having if it is INJECTIVE, so the escape character itself has
  // to be escaped too. A `%`-blind escape maps the literal name `p%3Aq` and the name `p:q` onto the
  // same key and re-creates the collision one level down. Contrived on purpose — it pins the
  // property, not a scenario.
  it('a consumer name containing the escape sequence itself stays distinct (fan-out is intact)', async () => {
    const work = new InMemoryStorage().work;
    await emit(work, 'x', { n: 1 }, { id: 'e1' });

    const a: any[] = [];
    const b: any[] = [];
    const ca = createConsumer(work, 'x', (p: any) => void a.push(p), { name: 'p%3Aq' }); // literal text
    const cb = createConsumer(work, 'x', (p: any) => void b.push(p), { name: 'p:q' });

    expect(await ca.poll()).toBe(1);
    expect(await cb.poll()).toBe(1); // 0 = 'p:q' escaped onto the other consumer's literal name
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
