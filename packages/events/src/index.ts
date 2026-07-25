// @gnldev/events — durable event/notification bus on top of WorkStore. emit writes to an append-only log;
// each consumer processes an event with its own ack marker (ackOnce=CAS): exactly-once MARKING +
// at-least-once DELIVERY. The marker is written AFTER the handler SUCCEEDS → if the handler throws/the
// process dies, the event isn't lost, the next poll retries it. Cost: a crash between handler success
// and ackOnce (or a concurrent poll race) → redelivery is possible. Write the handler idempotently, or
// use durable (runDurable/claim) inside the handler. Fan-out: N consumers → each gets every event at least once.
// (WorkStore keeps it in its own namespace → doesn't pollute the RunJournal/replay reader.)
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
}

export interface Consumer {
  /**
   * Deliver this consumer's not-yet-marked events to the handler. Returns the count of
   * successfully marked (ackOnce won) deliveries. Delivery is at-least-once: if the handler
   * throws, the event is skipped (marker not written) and retried on the next poll → the handler
   * should be idempotent.
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
    const depth = await countUpTo(work, `evt:${topic}`, opts.maxDepth);
    if (depth >= opts.maxDepth) {
      throw new EventDepthExceededError(
        `@gnldev/events: topic depth limit exceeded (${depth} >= ${opts.maxDepth}) — event rejected (topic='${topic}').`,
        { topic, depth, maxDepth: opts.maxDepth },
      );
    }
  }
  return work.append(`evt:${topic}`, payload, opts.id);
}

export function createConsumer(
  work: WorkStore,
  topic: string,
  handler: EventHandler,
  opts: ConsumerOptions,
): Consumer {
  const ns = `evt:${topic}`;
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  // Read cursor specific to this consumer (WorkStore KV): persistently holds the position "all
  // events before this are a fully-scanned page for this consumer" → subsequent polls won't list
  // previously (fully processed) pages again (5.1: fixes starvation + O(n)-per-poll at 50+ events).
  // Fan-out is unaffected: each consumer keeps its own cursor + its own ackOnce marker based on its
  // `opts.name`. Old (cursor-less) event logs also stream from the start (cursor=undefined).
  const cursorKey = `evtcursor:${topic}:${opts.name}`;

  async function poll(): Promise<number> {
    let cursor = await work.get<string>(cursorKey);
    let delivered = 0;
    for (;;) {
      const page = await work.list(ns, { cursor });
      let pageHasFailure = false; // is there an event on this page whose handler failed (no marker)?
      for (const e of page.items) {
        const marker = `evtack:${topic}:${opts.name}:${e.id}`;
        // Cheap "already marked?" check (ackOnce markers live in the same work-KV space) →
        // events completed in previous polls don't go to the handler again.
        if ((await work.get(marker)) !== undefined) continue;
        // Contract: exactly-once MARKING + at-least-once DELIVERY. The marker is written AFTER
        // the handler; a crash between handler success and ackOnce (or a concurrent poll race) →
        // redelivery is possible. Write the handler idempotently, or use durable (runDurable/claim) inside it.
        try {
          await handler(e.payload, { id: e.id, topic });
        } catch (err) {
          // Handler threw → marker NOT WRITTEN → next poll retries it (no loss).
          // The poll loop doesn't die: this event is skipped, the rest of the page keeps processing.
          pageHasFailure = true;
          console.warn(`@gnldev/events: handler errored (topic=${topic}, consumer=${opts.name}, event=${e.id}) — will retry on next poll:`, err);
          continue;
        }
        // Handler SUCCEEDED → mark it now. false = another poll/instance finished the race first
        // (the handler may have run twice — idempotency is the handler's job); don't double-COUNT.
        if (await work.ackOnce(marker)) delivered++;
      }
      if (!page.nextCursor) return delivered; // last (partial) page: cursor isn't advanced → rescanned for new events
      // If a failed (unmarked) event remains on the page, the cursor CANNOT BE ADVANCED — if it
      // were, that event would never be scanned again = permanent loss. Return without advancing;
      // the next poll rescans the page (successes are skipped via the marker check, only failures retry).
      if (pageHasFailure) return delivered;
      // This page was fully consumed (there's a next page) → permanently advance the cursor so it isn't rescanned.
      cursor = page.nextCursor;
      await work.put(cursorKey, cursor);
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
