// @gnldev/events — durable event/notification bus on top of WorkStore. emit writes to an append-only log;
// each consumer processes an event with its own ack marker (ackOnce=CAS): exactly-once MARKING +
// at-least-once DELIVERY. The marker is written AFTER the handler SUCCEEDS → if the handler throws/the
// process dies, the event isn't lost — a later poll retries it, spaced out by `retryDelayMs` (default
// exponential 60s→1h) so a short downstream outage can't burn the whole attempt budget in a second.
// Cost: a crash between handler success
// and ackOnce (or a concurrent poll race) → redelivery is possible. Write the handler idempotently, or
// use durable (runDurable/claim) inside the handler. Fan-out: N consumers → each gets every event at least once.
// (WorkStore keeps it in its own namespace → doesn't pollute the RunJournal/replay reader.)
// A handler that keeps throwing does NOT hold the topic hostage: other events keep being delivered
// in the same pass, and after `maxAttempts` the event is QUARANTINED (dead-letter) rather than
// retried forever — listDeadEvents() shows it, retryDeadEvent() hands it back. Quarantine is not an
// ack: a quarantined event is never counted as delivered, because the consumer never saw it.
import { createPollLoop } from '@gnldev/durable';
import type { WorkStore } from '@gnldev/durable';

export interface EventMeta {
  id: string;
  topic: string;
}

export type EventHandler = (payload: any, meta: EventMeta) => Promise<void> | void;

export interface ConsumerOptions {
  /** Consumer identity — ack markers are separated by this (fan-out). */
  name: string;
  /** start() poll interval (also the base for backoff growth on an empty queue). */
  pollMs?: number;
  /**
   * Empty-poll exponential backoff (default ON): if poll() delivers 0 events, the next poll
   * interval grows ×2 (ceiling: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty
   * queries per second on an empty topic with many consumers (poll storm, audit finding). Once
   * something is delivered, the interval resets to `pollMs`. `false` → old behavior (fixed `pollMs` interval).
   */
  backoff?: boolean;
  /** Backoff ceiling (default `pollMs*32`). Only meaningful when `backoff !== false`. */
  maxPollMs?: number;
  /**
   * How many FAILED delivery attempts before an event is quarantined (dead-lettered) for THIS
   * consumer. Default 8, spread over ~2 hours by `retryDelayMs` — the same evtatt→evtdead shape as
   * @gnldev/queue's qatt→qfail, so an operator learns one dead-letter ontology, not two. (The number
   * is 8 rather than queue's 5 because these attempts are TIME-spaced: see `retryDelayMs`.)
   * `Infinity` = never quarantine (retry forever): delivery of OTHER events is still not blocked
   * (see the `frozen` cursor below), but this consumer's cursor stays parked behind the poison event
   * forever, so every poll re-scans the whole log from that point (the O(n) marker-check cost this
   * package spent 5.1 removing). Opt into that knowingly.
   */
  maxAttempts?: number;
  /**
   * How long to WAIT after a failed attempt before the event may be handed to the handler again.
   * Default: exponential from 60s, ×2 per attempt, capped at 1h — the same
   * `Math.min(base * 2 ** (attempt - 1), cap)` shape @gnldev/scheduler uses for its retries, with an
   * events-sized base/cap. A number = fixed spacing; `0` = retry on the very next poll.
   *
   * Why this exists: `maxAttempts` counts POLLS, not time. With the default 200ms poll interval a
   * 5-attempt budget burned out in about one second, so a one-second downstream blip quarantined
   * every in-flight event — permanently, needing an operator's `retryDeadEvent`. A retry budget is
   * only a real budget if the attempts are spread over the kind of outage it is meant to survive:
   * 8 attempts × this schedule = ~2h (60+120+240+480+960+1920+3600 seconds of waiting).
   *
   * A not-yet-due event is SKIPPED (not handed to the handler) but still FREEZES the consumer's
   * cursor — it is retryable, so nothing behind it may be marked as passed. Waiting is not giving up.
   *
   * CONTRACT for the function form: it must return a FINITE number of milliseconds. If it throws, or
   * returns Infinity/NaN/a non-number, the default schedule is used for that attempt and a warning is
   * logged — the delivery of every OTHER event on the topic is not the place to pay for a broken
   * schedule (a throw here used to escape poll() and stop the whole pass), and Infinity is not
   * storable: it survives in memory as "never due again" but a SQLite/Postgres WorkStore round-trips
   * it through JSON to null → 0 → due immediately, i.e. the same code behaving oppositely per adapter.
   * "Retry forever" is `maxAttempts: Infinity`, not a delay of Infinity.
   */
  retryDelayMs?: number | ((attempt: number) => number);
}

/**
 * The `evtatt:*` record. Was a bare `number` before retry spacing existed; a bare number is still
 * READ (treated as "n failures, due now") because a store written by an older build costs one branch
 * to keep readable — nothing is published yet, so this is courtesy, not a compatibility contract.
 */
interface StoredAttempts {
  /** Failed attempts in the CURRENT streak (a release resets this to 0). */
  n: number;
  /** When the streak started — "how long has this been failing", which `n` alone can't answer. */
  firstAt: number;
  /** Earliest time the next attempt may run. `0` = due now. */
  nextAt: number;
  /**
   * The RELEASE GENERATION this streak belongs to (`releaseStamp` of the dead record that handed it
   * back). Absent = never released, which is why it is omitted rather than written as the `0@0`
   * default: a first-failure record then keeps the exact shape it always had.
   *
   * It exists because the write below is a compare-and-swap on the record's VALUE, and value CAS is
   * ABA-blind: `retryDeadEvent` resets the counter to `{n:0, firstAt:0, nextAt:0}` EVERY time, so two
   * successive releases produce byte-identical records. A poll that read the first release's record,
   * ran the handler, and had the second release land underneath it would find its "expected" value
   * still matching and overwrite the new release anyway — measured: the CAS alone left the
   * "a release means NOW" case red. The stamp makes each release's record distinguishable, which is
   * the only thing a value CAS can detect.
   */
  gen?: string;
}

/** A delivery that reached `maxAttempts` failures for one consumer, as stored under `evtdead:*`. */
interface StoredDead {
  error: string;
  attempts: number;
  at: number;
  /** Set by `retryDeadEvent` — released back for delivery, not yet succeeded. */
  releasedAt?: number;
  /** How many times it has been released (quarantine → release → quarantine again). */
  releases?: number;
}

/** An event that has been quarantined for a consumer at least once — the operator-facing view. */
export interface DeadEvent extends StoredDead {
  id: string;
  topic: string;
  consumer: string;
  payload: unknown;
  /**
   * `quarantined` = parked, will NOT be delivered until released. `released` = `retryDeadEvent` has
   * handed it back, awaiting the next poll. `delivered` = it eventually succeeded; the record is kept
   * as history (same choice as queue's qfail: an append-only log, dead-letter history is permanent for audit).
   */
  status: 'quarantined' | 'released' | 'delivered';
}

export interface Consumer {
  /**
   * Deliver this consumer's not-yet-marked events to the handler. Returns the count of
   * successfully marked (ackOnce won) deliveries. Delivery is at-least-once: if the handler
   * throws, the event is skipped (marker not written) and retried on a later poll, once its
   * `retryDelayMs` backoff has elapsed → the handler should be idempotent. Until then the event is
   * skipped but the cursor stays frozen behind it (waiting is not giving up, and not loss either).
   * After `maxAttempts` failures an event is QUARANTINED (`evtdead:*`,
   * visible via `listDeadEvents`) and stops being redelivered until `retryDeadEvent` releases it.
   */
  poll(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * Phase 8 (audit finding: unbounded accumulation): if `maxDepth` is given — throws if, before
 * publishing, the topic depth (the TOTAL record count in the `evt:<topic>` namespace: delivered +
 * undelivered, an append-only log can't distinguish these without pruning) has reached/exceeded `maxDepth`.
 */
export class EventDepthExceededError extends Error {
  constructor(
    message: string,
    public readonly detail: { topic: string; depth: number; maxDepth: number },
  ) {
    super(message);
    this.name = 'EventDepthExceededError';
  }
}

/**
 * Counts records in the `ns` namespace only UP TO `limit` (early exit). WorkStore.list is paged
 * (default page size e.g. 50) — an exact count would read O(depth/pageSize) pages; here it's enough
 * to know "was the limit exceeded", so it stops once it reaches `limit` → cost is
 * O(min(actual depth, maxDepth)) pages, NOT the ENTIRE log. Unless `maxDepth` is given (default
 * behavior), this function is NEVER called → existing unbounded-topic behavior is preserved.
 */
async function countUpTo(work: WorkStore, ns: string, limit: number): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list(ns, { cursor });
    count += page.items.length;
    if (count >= limit || !page.nextCursor) return count;
    cursor = page.nextCursor;
  }
}

/** Publish an event to a topic (idempotent: same id → a single event again). Returns eventId. */
export async function emit(
  work: WorkStore,
  topic: string,
  payload: unknown,
  opts: { id?: string; maxDepth?: number } = {},
): Promise<string> {
  if (opts.maxDepth != null) {
    const depth = await countUpTo(work, logNsOf(topic), opts.maxDepth);
    if (depth >= opts.maxDepth) {
      throw new EventDepthExceededError(
        `@gnldev/events: topic depth limit exceeded (${depth} >= ${opts.maxDepth}) — event rejected (topic='${topic}').`,
        { topic, depth, maxDepth: opts.maxDepth },
      );
    }
  }
  return work.append(logNsOf(topic), payload, opts.id);
}

/**
 * Escapes ONE component of a `:`-delimited marker key, so that different components can never
 * produce the same key.
 *
 * WHY: the keys below are built by concatenation, and every component — topic, consumer name, event
 * id — is a string the CALLER chose. `:` is a perfectly ordinary character in all three
 * (`billing:eu`, `orders:created`, an URN as an event id), and it is also the delimiter. Measured
 * without this: topic `a` + consumer `b:c` and topic `a:b` + consumer `c` both produce
 * `evtack:a:b:c:order-42`, so the first consumer's ack marker made the second one's event
 * invisible — `poll()` returned 0 forever, `listDeadEvents` was empty, nothing was logged. Silent,
 * permanent loss of exactly the at-least-once delivery this package is for, from two name pairs
 * that are each entirely reasonable on their own. (Pinned per key family in key-ambiguity.test.ts.)
 *
 * Only `:` (the delimiter) and `%` (the escape character itself) are rewritten. That makes the
 * escape INJECTIVE — the two escape sequences are the only way a `%` can appear in the output, so a
 * key decomposes back to exactly one component triple — and injective is the whole requirement.
 *
 * NOT `encodeURIComponent`: it throws `URIError` on a lone surrogate, which a truncated UTF-16
 * string yields, and these key builders run inside `poll()` where `createPollLoop` swallows throws.
 * That would make a key escape a new way to silently stop the poll loop — the same failure
 * `delayFor` exists to keep caller input from causing. This escape is TOTAL: every string has one.
 *
 * THE `evt:<topic>` LOG NAMESPACE IS ESCAPED TOO, and this note used to say the opposite ("topic is
 * its last and only variable component there, so that name is already unambiguous... a collision that
 * cannot happen"). The name is indeed unambiguous; the reasoning was still wrong, because it argued
 * about the NAME while the failure is in the KEY THE STORE DERIVES FROM IT, which this package cannot
 * see. `WorkStore.list(ns)` is specified as a whole-value match, but RedisWorkStore had no ns column:
 * it stored records at `wl:<ns>:<id>` and read a namespace back with a `SCAN MATCH wl:<ns>:*` PREFIX
 * scan. Measured on a real Redis 7: a consumer of topic `orders` was delivered topic `orders:eu`'s
 * events (it never subscribed), and `emit(topic='inv', id='eu:x')` returned an event id for a record
 * `SET NX` had silently refused, because topic `inv:eu` + id `x` had already taken the same key — no
 * dead-letter row, no log line, the loss class this escape exists to remove. (Pinned in
 * log-namespace.test.ts.)
 *
 * The adapter is fixed at its own layer (redis-storage.ts `encNs`) and that fix is the load-bearing
 * one — it restores the port contract for EVERY caller, not just this package. Escaping here changes
 * no behavior on any of the four shipped adapters once it has landed. It stays because `WorkStore` is
 * a PUBLIC port: a store that addresses a record by a concatenated key is an ordinary way to
 * implement it, ours did it for months, and an escaped namespace is self-disambiguating under any of
 * them. A rule with an exception clause is what failed here; this package now has the rule without it.
 *
 * `encNs` is a SECOND IMPLEMENTATION of this same three-line escape, and deliberately so: one escape
 * SHAPE (`%3A`/`%25`), two layers that must be able to fail independently. Sharing a symbol would
 * mean deleting either one silently reconfigures the other — the opposite of the defence in depth
 * the paragraph above argues for. The two are pinned separately, and the `%` half of each is what
 * distinguishes them: log-namespace.test.ts asserts it once through this package (a topic literally
 * named `inv%3Aeu`) and once straight against the adapter (a namespace named `a%3Ab`).
 *
 * COST: a name (or event id) that actually contains `:` or `%` is now stored under a different key
 * than it was, and — since the namespace is escaped as well — a topic containing one is stored in a
 * different NAMESPACE than it was (`evt:orders:eu` → `evt:orders%3Aeu`), which on SQLite/Postgres is
 * a `gnl_work_log.ns` value, i.e. the events themselves move, not just their markers. Nothing is
 * published, so no store holds one yet; on a live deployment the old markers would be orphaned and
 * every event redelivered once, and a colon-topic's existing log would go unread until its `ns` was
 * renamed. Names without `:`/`%` — every test, every example, every documented key in the README —
 * are byte-identical before and after.
 */
const enc = (part: string) => part.replace(/%/g, '%25').replace(/:/g, '%3A');

// Marker keys. Inlined at two places before (the consumer and nothing else); now the management
// functions (listDeadEvents/retryDeadEvent) address the SAME keys, and a key format that two call
// sites have to agree on is a key format that must exist in exactly one place.
/** The append-log namespace an event lives in. The sixth key family — see `enc`. */
const logNsOf = (topic: string) => `evt:${enc(topic)}`;
const ackKey = (topic: string, consumer: string, id: string) => `evtack:${enc(topic)}:${enc(consumer)}:${enc(id)}`;
const attKey = (topic: string, consumer: string, id: string) => `evtatt:${enc(topic)}:${enc(consumer)}:${enc(id)}`;
const deadKey = (topic: string, consumer: string, id: string) => `evtdead:${enc(topic)}:${enc(consumer)}:${enc(id)}`;
const cursorKeyOf = (topic: string, consumer: string) => `evtcursor:${enc(topic)}:${enc(consumer)}`;
const rescanKeyOf = (topic: string, consumer: string) => `evtrescan:${enc(topic)}:${enc(consumer)}`;

/** Reads an `evtatt:*` value in either shape (see StoredAttempts). `undefined` = never failed. */
function readAttempts(raw: unknown): StoredAttempts | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return { n: raw, firstAt: 0, nextAt: 0 }; // pre-spacing bare count → due now
  const r = raw as Partial<StoredAttempts>;
  return {
    n: r.n ?? 0, firstAt: r.firstAt ?? 0, nextAt: r.nextAt ?? 0,
    ...(r.gen !== undefined ? { gen: r.gen } : {}),
  };
}

/**
 * The identity of a RELEASE GENERATION. poll() reads the dead record before calling the handler and
 * writes the quarantine record after — an arbitrarily long window in which `retryDeadEvent` can land.
 * Comparing this stamp before/after is how an intervening release is detected, and it has to be a
 * pair: `releasedAt` alone is a wall clock (two releases in the same millisecond compare equal) and
 * `releases` alone doesn't move on the very first release. `0` for "no record / never released".
 */
const releaseStamp = (rec: StoredDead | undefined) => `${rec?.releases ?? 0}@${rec?.releasedAt ?? 0}`;

/** The default retry schedule: @gnldev/scheduler's backoff shape (src/index.ts:104), events-sized. */
const defaultRetryDelay = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);

export function createConsumer(
  work: WorkStore,
  topic: string,
  handler: EventHandler,
  opts: ConsumerOptions,
): Consumer {
  const ns = logNsOf(topic);
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const maxAttempts = opts.maxAttempts ?? 8;
  const retryDelay: (attempt: number) => number =
    typeof opts.retryDelayMs === 'function' ? opts.retryDelayMs
      : opts.retryDelayMs != null ? () => opts.retryDelayMs as number
        : defaultRetryDelay;
  // Read cursor specific to this consumer (WorkStore KV): persistently holds the position "all
  // events before this are a fully-scanned page for this consumer" → subsequent polls won't list
  // previously (fully processed) pages again (5.1: fixes starvation + O(n)-per-poll at 50+ events).
  // Fan-out is unaffected: each consumer keeps its own cursor + its own ackOnce marker based on its
  // `opts.name`. Old (cursor-less) event logs also stream from the start (cursor=undefined).
  const cursorKey = cursorKeyOf(topic, opts.name);
  const rescanKey = rescanKeyOf(topic, opts.name);

  /**
   * `retryDelayMs` is CALLER CODE called from inside the catch block, where nothing was catching it.
   * A throwing schedule (a config read that blows up, an off-by-one on an array lookup) escaped
   * poll() entirely: measured on a 10-event topic with a throwing delay fn — 1 event delivered, the
   * attempt counter never written, and every later poll dying at the same line. Under `start()`
   * createPollLoop swallows it, so that is a SILENT full stop — the exact head-of-line blocking this
   * package exists to remove, re-entering through the caller's own hook. A bad schedule may cost the
   * caller its schedule; it may not cost the topic its delivery.
   *
   * Non-finite is rejected for a different reason: it is not STORABLE. `Infinity` survives in an
   * InMemory WorkStore (the event is never due again — a permanent freeze that isn't quarantine and
   * isn't visible to listDeadEvents), but a SQLite/Postgres WorkStore round-trips it through JSON to
   * `null` → read back as `0` → due IMMEDIATELY. Same code, same options, opposite behavior per
   * adapter. There is no honest clamp for "infinity" either, so it falls back like a throw does:
   * `maxAttempts: Infinity` is how "retry forever" is spelled here, not a delay of Infinity.
   */
  function delayFor(attempt: number, eventId: string): number {
    let raw: unknown;
    try {
      raw = retryDelay(attempt);
    } catch (e) {
      console.warn(`@gnldev/events: retryDelayMs threw (topic=${topic}, consumer=${opts.name}, event=${eventId}, attempt=${attempt}) — falling back to the default 60s→1h schedule:`, e);
      return defaultRetryDelay(attempt);
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      console.warn(`@gnldev/events: retryDelayMs returned ${String(raw)} (topic=${topic}, consumer=${opts.name}, event=${eventId}, attempt=${attempt}) — a delay must be a finite number of milliseconds (it has to survive the store's JSON round-trip); falling back to the default 60s→1h schedule.`);
      return defaultRetryDelay(attempt);
    }
    return Math.max(0, raw);
  }

  async function poll(): Promise<number> {
    // A release (retryDeadEvent) hands an event back that sits BEHIND the persisted cursor — the
    // cursor moved past it precisely because quarantine made it terminal. One flagged full pass is
    // how it gets back in view. It costs one extra scan of already-acked ids (cheap `get`s, the
    // same cost the old locked cursor paid on EVERY poll) and it is idempotent: the flag is cleared
    // only after a pass completes, so a crash mid-pass just rescans again.
    const rescan = (await work.get<boolean>(rescanKey)) === true;
    // The stored cursor is dropped, not just ignored for one pass. Quarantining the event is what
    // moved the cursor PAST it, so a pass that merely starts from the beginning would re-deliver it
    // and then — because a failed release freezes the cursor and never persists anything — fall back
    // to the same stale forward position on the next poll, leaving the event `released` and
    // unreachable forever. (Found by mutation: no test failed when retryDeadEvent stopped resetting
    // the attempt counter, and writing that test surfaced this instead.) `''` is the "start of log"
    // Sentinel — WorkStore KV has no delete, so a key cannot be returned to absent.
    //
    // This rewind is NOT protected from concurrent writers, and the comment here used to claim it
    // was ("only poll() writes the cursor"). poll() is the only cursor writer, but running two
    // processes under the SAME consumer name is a supported way to scale a consumer (see the
    // "already DELIVERED by another process" branch below), so there are as many cursor writers as
    // there are pollers: another process's pass can persist a forward cursor right after this
    // rewind and put the released event back out of view. That failure mode is the one
    // retryDeadEvent already documents — the release "silently didn't take", the remedy is to
    // release again, and `listDeadEvents` keeps showing it as `released` and undelivered, so it is
    // observable rather than lost. What IS safe here is crashing right after the rewind: a rescan
    // is a superset of a normal pass and skips acked ids by marker.
    if (rescan) await work.put(cursorKey, '');
    let cursor = rescan ? undefined : (await work.get<string>(cursorKey)) || undefined;
    let delivered = 0;
    // Has a RETRYABLE (failed, not yet quarantined) event been seen in this pass? Once true the
    // persisted cursor stops moving — but the pass KEEPS GOING through the remaining pages.
    let frozen = false;
    for (;;) {
      const page = await work.list(ns, { cursor });
      for (const e of page.items) {
        const ack = ackKey(topic, opts.name, e.id);
        // Cheap "already marked?" check (ackOnce markers live in the same work-KV space) →
        // events completed in previous polls don't go to the handler again.
        if ((await work.get(ack)) !== undefined) continue;
        // Quarantined (and not released): TERMINAL for this consumer — not delivered, and
        // deliberately NOT ack-marked, because "we gave up on it" is not "the consumer saw it".
        // It doesn't freeze the cursor either; that is the whole point of quarantining. It is not
        // silent: it was logged at console.error when it happened and it is listed by listDeadEvents.
        const dk = deadKey(topic, opts.name, e.id);
        const dead = await work.get<StoredDead>(dk);
        if (dead && !dead.releasedAt) continue;
        // Failed before and the backoff hasn't elapsed → NOT handed to the handler. The bookmark is
        // frozen all the same: a waiting event is still retryable, so advancing past it would be the
        // same silent loss as advancing past a failing one. (Without this, `maxAttempts` counted
        // polls: at pollMs=200 the whole budget burned in ~1s and a one-second outage dead-lettered
        // everything in flight. See ConsumerOptions.retryDelayMs.) COST: one extra KV `get` per
        // not-yet-acked event per pass (2 → 3, alongside the ack and dead-letter checks). It is paid
        // once per event on a healthy topic — an acked event never reaches this line — and there is
        // no cheaper place to keep it: the due time has to survive a restart, so it lives in the store.
        const attRaw = await work.get(attKey(topic, opts.name, e.id));
        const att = readAttempts(attRaw);
        if (att && att.nextAt > Date.now()) { frozen = true; continue; }
        // Contract: exactly-once MARKING + at-least-once DELIVERY. The marker is written AFTER
        // the handler; a crash between handler success and ackOnce (or a concurrent poll race) →
        // redelivery is possible. Write the handler idempotently, or use durable (runDurable/claim) inside it.
        try {
          await handler(e.payload, { id: e.id, topic });
        } catch (err) {
          // Handler threw → ack marker NOT WRITTEN → the event is not lost. The poll loop doesn't
          // die: this event is skipped, the rest of the page keeps processing.
          //
          // FRESH read of the dead record first. `dead` above was read BEFORE the handler ran, and
          // the handler can take arbitrarily long — long enough for an operator's retryDeadEvent to
          // land. Writing this attempt's bookkeeping from the stale read would undo that release
          // (drop `releasedAt` → back to `quarantined`, rewind `releases`, overwrite the attempt
          // reset) AFTER retryDeadEvent had already returned `true` to the operator. An attempt that
          // belongs to the previous release generation may not touch the new one at all.
          const fresh = await work.get<StoredDead>(dk);
          if (releaseStamp(fresh) !== releaseStamp(dead)) {
            frozen = true; // released mid-flight → still live, and it gets the release's fresh budget
            console.warn(`@gnldev/events: handler errored (topic=${topic}, consumer=${opts.name}, event=${e.id}) but the event was RELEASED while it ran — this attempt is discarded, the release stands:`, err);
            continue;
          }
          const now = Date.now();
          const n = (att?.n ?? 0) + 1;
          // An event that reached its LAST attempt is about to become an operator's problem, so it
          // is worth one extra `get` (only on this branch — never on the healthy or the still-
          // retrying path) to check it is still ours to give up on. Two processes under the SAME
          // consumer name is the supported way to scale a consumer: the other one can have delivered
          // and ACKED this event while our attempt was in flight, and our late failure would then
          // print "event QUARANTINED" and file a permanent dead-letter record for a delivery that
          // SUCCEEDED. listDeadEvents reports it honestly as `delivered` and retryDeadEvent correctly
          // refuses it, so nothing is lost — but an operator with an alarm on that line is paged for
          // a non-event, and an alarm that cries wolf is worse than no alarm.
          if (n >= maxAttempts && (await work.get(ack)) !== undefined) {
            console.warn(`@gnldev/events: handler errored (topic=${topic}, consumer=${opts.name}, event=${e.id}) but the event was already DELIVERED by another process under the same consumer name — this attempt is discarded, nothing is quarantined:`, err);
            continue; // NOT frozen: it is acked, so the cursor may pass it
          }
          const delay = delayFor(n, e.id); // called ONCE per failure; caller code, may throw (see delayFor)
          // The attempt counter USED TO BE a get→put pair with the comment "quarantine happens a poll
          // or two late, NEVER EARLY, and never turns into loss". The middle claim was false, and
          // measured: `attRaw` is read BEFORE the handler runs, so an operator's retryDeadEvent
          // landing anywhere in the handler's lifetime — a window the stamp check above cannot see,
          // because it compares the dead record read before the release, not this key — was
          // OVERWRITTEN by this put. The release had already returned `true`. Its effects both died:
          // the fresh budget (measured: an 8-attempt release turned into 1 attempt, so the very next
          // failure quarantined — early, not late) and the cleared backoff (measured: `nextAt` put an
          // hour into the future on an event the operator had just said "now" about).
          // So this is a CAS on its own key, exactly as the dead record's write below is — same
          // window, same technique, same standard. Absent key → nothing to race with (a release
          // implies a dead record implies a previous failure implies this key exists) and putIfMatch
          // is false-on-absent, so that case is a plain put. Losing the CAS means someone else moved
          // this event on: their record stands, this attempt is discarded, and nothing is quarantined
          // off a counter we no longer own. What remains from the old comment is the benign half —
          // two concurrent polls can still make an attempt go uncounted, which only ever DELAYS
          // quarantine.
          const ak = attKey(topic, opts.name, e.id);
          const next: StoredAttempts = {
            n,
            firstAt: att?.firstAt || now,
            nextAt: now + delay,
            ...(att?.gen !== undefined ? { gen: att.gen } : {}), // the streak keeps its generation
          };
          const wroteAtt = attRaw === undefined || !work.putIfMatch
            ? (await work.put(ak, next), true)
            : await work.putIfMatch(ak, attRaw, next);
          if (!wroteAtt) {
            frozen = true; // someone else changed the counter under us → theirs stands, not ours
            console.warn(`@gnldev/events: attempt write skipped — the retry record changed concurrently (topic=${topic}, consumer=${opts.name}, event=${e.id}); this attempt is discarded and the event stays live:`, err);
            continue;
          }
          if (n >= maxAttempts) {
            const rec: StoredDead = {
              error: String((err as any)?.message ?? err),
              attempts: n,
              at: now,
              ...(fresh?.releases != null ? { releases: fresh.releases } : {}),
            };
            // Conditional write where the store supports it (8.2 WorkStore.putIfMatch): the fresh
            // read above closes the handler-long window, this closes the sliver after it. If the key
            // doesn't exist yet there is nothing to race with — a release can only exist once a dead
            // record does — and putIfMatch is false-on-absent, so that case is a plain put.
            const wrote = fresh === undefined || !work.putIfMatch
              ? (await work.put(dk, rec), true)
              : await work.putIfMatch(dk, fresh, rec);
            if (!wrote) {
              frozen = true; // someone else changed the record under us → theirs stands, not ours
              console.warn(`@gnldev/events: quarantine write skipped — the dead-letter record changed concurrently (topic=${topic}, consumer=${opts.name}, event=${e.id}); the event stays live.`);
              continue;
            }
            console.error(`@gnldev/events: event QUARANTINED after ${n} failed attempts (topic=${topic}, consumer=${opts.name}, event=${e.id}) — it will NOT be redelivered until retryDeadEvent(); inspect with listDeadEvents():`, err);
          } else {
            frozen = true; // still retryable → the cursor must not move past it
            console.warn(`@gnldev/events: handler errored (topic=${topic}, consumer=${opts.name}, event=${e.id}, attempt=${n}/${maxAttempts}) — retrying in ${delay}ms:`, err);
          }
          continue;
        }
        // Handler SUCCEEDED → mark it now. false = another poll/instance finished the race first
        // (the handler may have run twice — idempotency is the handler's job); don't double-COUNT.
        if (await work.ackOnce(ack)) delivered++;
      }
      if (!page.nextCursor) {
        // End of the log. The last (partial) page's cursor is never persisted — it must be
        // rescanned for new events.
        if (rescan) await work.put(rescanKey, false); // the released event has been back in view for a full pass
        return delivered;
      }
      cursor = page.nextCursor;
      // A retryable (unmarked, un-quarantined) event is still behind us → the PERSISTED cursor
      // cannot advance past it: if it did, that event would never be scanned again = silent loss.
      // But the SCAN continues — freezing the bookmark is not a reason to stop delivering. That
      // conflation was the bug: `if (pageHasFailure) return delivered` stopped the whole pass, so
      // one poison event on page 1 held back every event behind it forever. Measured (real SQLite,
      // 120 events, the 4th always throwing): poll1=49, poll2=0, poll3=0 — events 50..119 were
      // never delivered at all. With the split: poll1=119, and after maxAttempts the poison event
      // is quarantined, which unfreezes the bookmark too.
      // Rejected: advancing the cursor past the failure anyway (a one-line fix) — that is exactly
      // the silent data loss this package refuses; the consumer never saw the event and nothing
      // would record that it had been skipped.
      if (!frozen) await work.put(cursorKey, cursor);
    }
  }

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared
  // createPollLoop (was a triplicate copy across queue/events/scheduler) — behavior is identical:
  // if poll() delivers 0 events, the interval grows ×2 while backoffOn (ceiling maxPollMs); it
  // resets to pollMs once something is delivered. poll() catches handler errors internally (above);
  // remaining errors (store I/O etc.) are logged and swallowed by createPollLoop — the chain doesn't
  // die (an unhandled rejection doesn't crash the process).
  const loop = createPollLoop(async () => (await poll()) > 0, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    poll,
    start: loop.start,
    stop: loop.stop,
  };
}

// ── Dead-letter (quarantine) inspection + release ─────────────────────────────
// The operator-facing half of the fix. A poison event no longer blocks the topic, but "doesn't
// block" is only acceptable if "what happened to it" is answerable. These two functions are that
// answer, and they are deliberately the same pair @gnldev/queue exposes for jobs (listJobs /
// retryJob) — one dead-letter vocabulary across the two packages, not two.

/**
 * Every event that has been quarantined for `consumer` on `topic` — including ones later released
 * and delivered (`status`), because dead-letter history is permanent for audit (same choice as
 * queue's qfail: nothing is deleted from an append-only log).
 *
 * MANAGEMENT function: it reads the WHOLE topic log and does one `get` per event. Do NOT call it
 * from a poll loop — the loop reads only the pages it needs, via cursor (5.1).
 */
export async function listDeadEvents(work: WorkStore, topic: string, consumer: string): Promise<DeadEvent[]> {
  const out: DeadEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list(logNsOf(topic), { cursor });
    for (const e of page.items) {
      const rec = await work.get<StoredDead>(deadKey(topic, consumer, e.id));
      if (!rec) continue;
      const acked = (await work.get(ackKey(topic, consumer, e.id))) !== undefined;
      out.push({
        ...rec,
        id: e.id,
        topic,
        consumer,
        payload: e.payload,
        status: acked ? 'delivered' : rec.releasedAt ? 'released' : 'quarantined',
      });
    }
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

/**
 * Releases a quarantined event back for delivery to `consumer` (attempt counter reset to 0, backoff
 * cleared → due immediately). The next `poll()` re-scans the log from the start once — the consumer's
 * cursor had already moved past the event, which is why a flag rather than the cursor is what has to
 * change — and hands it to the handler again. Returns `false` (no-op) if the event was never
 * quarantined or has since been DELIVERED, mirroring `retryJob`, which only acts on jobs that
 * actually reached the dead-letter state — plus the contended case at the bottom of this note.
 *
 * IDEMPOTENT while `released`: calling it again on an already-released, not-yet-delivered event
 * re-asserts the release (re-arms the rescan flag, hands back a fresh attempt budget) and returns
 * `true`. That is not cosmetic — it is the ONLY way out of the race documented below. This function
 * used to return `false` there, which meant a release whose flag was swallowed by an in-flight poll
 * left the event `released` and unscanned forever: never delivered, never failing, never
 * re-quarantined, and refused by the very call its own docstring prescribed as the remedy. A
 * dead-letter that the package's API cannot get an event out of is not a dead-letter, it is a leak.
 * (`releases` counts every release that TOOK EFFECT, so a re-assertion increments it too — the
 * counter answers "how many times was this handed back", not "how many quarantine cycles".)
 *
 * Rejected alternative: re-EMIT the event under a new id (which is literally what queue's retryJob
 * does). It is simpler and needs no rescan flag, but a topic is FAN-OUT: a re-emitted copy is
 * delivered to EVERY consumer, so healing consumer A would force redelivery on healthy consumer B.
 * B's handler is contractually idempotent, so it would not corrupt anything — but manufacturing
 * redelivery for a consumer that never failed is not a repair, it's collateral. Release is
 * per-consumer for the same reason ack markers and cursors are per-consumer.
 *
 * Rejected alternative: have this function rewind the persisted cursor itself, to the released
 * event's page (storing that page cursor in the dead record). Cheaper than a full pass, but it adds
 * another writer to the cursor — one that writes it BACKWARDS, which is the direction that can be
 * lost: a poll already in flight (this consumer name may be run by several processes, see poll())
 * writes it forwards afterwards and the rewind is gone, with the failure mode "the release silently
 * didn't take". A flag is re-assertable and a cursor position is not, which is the whole difference:
 * The flag is not atomic against an in-flight poll either (one that started before the release can
 * clear it at the end of its own pass), but the cost is only that the release needs calling
 * again — which the idempotent re-release above makes possible — and it is observable rather than
 * silent: `listDeadEvents` keeps showing the event as `released` and undelivered.
 *
 * Returns `false` WITHOUT releasing in one further case: the dead record is being rewritten
 * concurrently faster than this function can read-modify-write it (`RELEASE_CAS_TRIES` lost
 * compare-and-swaps in a row). It is logged, and the remedy is to call again — the same remedy as
 * the lost-flag race. A silent overwrite would be the alternative, and that is what the CAS is here
 * to stop.
 */
const RELEASE_CAS_TRIES = 5;

export async function retryDeadEvent(work: WorkStore, topic: string, consumer: string, eventId: string): Promise<boolean> {
  const dk = deadKey(topic, consumer, eventId);
  const ak = attKey(topic, consumer, eventId);
  // Read → modify → write on a record other writers touch, so it is a compare-and-swap for the same
  // reason poll()'s two writes are: measured without it, two releases landing together (an operator
  // double-click, two panels, a retry script racing a human) both read the same record and both
  // wrote `releases: n + 1` from it — `both returned true? true true`, and the record showed
  // `releases: 1`. `releases` is an operator-facing number that answers "how many times was this
  // handed back"; answering it wrongly is worse than not answering. It is also the ABA input `gen`
  // exists to separate: equal `releases` plus (in the same millisecond) equal `releasedAt` is an
  // equal `releaseStamp`, which is precisely what a value CAS cannot see through. Losing the CAS
  // means someone else moved the record on, so this pass re-reads and re-applies on top of theirs
  // rather than clobbering it — a lost release must become a LATER release, not a vanished one.
  for (let tries = 0; tries < RELEASE_CAS_TRIES; tries++) {
    const rec = await work.get<StoredDead>(dk);
    if (!rec) return false; // never quarantined — a still-retrying or never-failed event needs no release
    // DELIVERED is the only terminal state: the ack marker is the single source of truth for "the
    // consumer saw it" (the same marker listDeadEvents reports as `status: 'delivered'`). `releasedAt`
    // being set is NOT terminal — see the idempotency note above. Re-read each pass: a concurrent
    // delivery is exactly the kind of thing that can land while a CAS is being retried.
    if ((await work.get(ackKey(topic, consumer, eventId))) !== undefined) return false;
    const released: StoredDead = { ...rec, releasedAt: Date.now(), releases: (rec.releases ?? 0) + 1 };
    // Order matters: the attempt reset and the dead record are written BEFORE the rescan flag, so a
    // poll that reacts to the flag can never see a half-applied release.
    //
    // The reset carries this release's STAMP. Without it the reset is `{n:0, firstAt:0, nextAt:0}` for
    // every release, byte-identical each time, and the poll's compare-and-swap on this key cannot tell
    // "nobody touched it" from "a second release put it back to the same value" — so a poll holding the
    // previous release's record would overwrite this one and its CAS would report success. See StoredAttempts.gen.
    await work.put(ak, { n: 0, firstAt: 0, nextAt: 0, gen: releaseStamp(released) } satisfies StoredAttempts);
    // The record always exists here (it was just read), so unlike poll()'s writes there is no
    // absent-key branch — only the documented drop for a store predating WorkStore.putIfMatch,
    // which keeps the old unconditional put and therefore the old race.
    const wrote = !work.putIfMatch ? (await work.put(dk, released), true) : await work.putIfMatch(dk, rec, released);
    if (!wrote) continue; // someone else wrote it between the read and here → re-read and re-apply
    await work.put(rescanKeyOf(topic, consumer), true);
    return true;
  }
  console.warn(`@gnldev/events: release abandoned — the dead-letter record kept changing under it (topic=${topic}, consumer=${consumer}, event=${eventId}, tries=${RELEASE_CAS_TRIES}); nothing was overwritten, call retryDeadEvent() again.`);
  return false;
}
