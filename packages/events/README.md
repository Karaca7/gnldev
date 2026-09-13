# @gnldev/events

A **durable event/notification bus** on top of the journal. `emit` writes to an append-only log; each
consumer processes events with its own ack marker: **exactly-once marking + at-least-once delivery**. The
marker is written **after** the handler succeeds — if the handler throws or the process dies, the event
isn't lost, a later poll retries it (on the backoff schedule below, until `maxAttempts`). The cost: between handler success and marking, a crash (or a
concurrent poll race) can cause redelivery → **write the handler as idempotent**, or use something durable
inside it (`runDurable`/`claim`). Fan-out: N consumers → each gets every event at least once, via its own
marker stream.

> Install: `pnpm add @gnldev/events` — or use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/events   # peer: @gnldev/durable
```

```ts
import { emit, createConsumer } from '@gnldev/events';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');   // emit/createConsumer take the WORK store

// Publish (idempotent: same id → a single event).
await emit(storage.work, 'refunds', { orderId: 'o1', amount: 50 }, { id: 'refund-o1' });

// Consume (each consumer name gets its own marker stream; the handler must be idempotent).
const consumer = createConsumer(storage.work, 'refunds', (payload, meta) => notify(payload), { name: 'emailer' });
await consumer.poll();   // or consumer.start()
```

## API
- `emit(work, topic, payload, { id?, maxDepth? }) → eventId` — `work` is `storage.work`
- `createConsumer(work, topic, handler, { name, pollMs?, backoff?, maxPollMs?, maxAttempts?, retryDelayMs? }) → { poll, start, stop }`
  — `name` is required to separate fan-out acks; `maxAttempts`/`retryDelayMs` govern the dead-letter below.
- `listDeadEvents(work, topic, consumer) → DeadEvent[]` — everything quarantined for that consumer,
  with `status` (`quarantined` | `released` | `delivered`), `attempts`, `error`, `releases` and the
  original `payload`. A management call: it reads the whole topic log, so don't put it in a poll loop.
- `retryDeadEvent(work, topic, consumer, eventId) → boolean` — hands a quarantined event back for
  delivery to that one consumer (fresh attempt budget, no backoff wait). Calling it again on an event
  that is still `released` is safe and re-asserts the release. `false` has **three** causes, and the
  third is not "nothing to do":
  1. the event was never quarantined;
  2. it has already been delivered (the ack marker is the single source of truth for that);
  3. **the release was abandoned** — the dead-letter record kept being rewritten underneath the
     read-modify-write faster than it could complete (5 lost compare-and-swaps in a row: two
     operators, two tabs, a retry script racing a human). Nothing was overwritten, it is logged on
     `console.warn`, and the remedy is to **call it again**. Silently clobbering the other writer is
     the alternative, and the compare-and-swap exists to refuse it: without it, two releases landing
     together both read the same record and both wrote `releases: n + 1` from it — both returned
     `true` and the record showed `releases: 1` (measured). Distinguish it from (1) and (2) by the
     record itself: it is still there and still `quarantined`.

## How it works
An append-only log per topic; consumer ack markers are separated by `name` → the same event flows to
multiple consumers. Since the marker is written after handler success, the delivery guarantee is
at-least-once: on a handler error the marker isn't written, that consumer's page cursor doesn't advance
past the event, and a later poll retries it; marking itself is exactly-once via CAS (`ackOnce`).

One failing event does **not** hold back the ones behind it: the pass keeps going through the rest of
the log, only the persisted bookmark stays parked. That parking is what makes retries safe, and it is
also why retries are finite — see the dead-letter below.

**A `:` in a topic, a consumer name or an event id is fine.** The bookkeeping keys are built by
joining those three on `:` (`evtack:<topic>:<consumer>:<id>`, and the same shape for `evtatt:`,
`evtdead:`, `evtcursor:`, `evtrescan:`), which is also a perfectly ordinary character in all three —
`billing:eu`, `orders:created`, a URN as an event id. Each part is therefore escaped before it is
joined: `:` → `%3A`, `%` → `%25`. Without that, topic `a` + consumer `b:c` and topic `a:b` + consumer
`c` produced the *same* ack key, so one consumer's marker made the other's event invisible — `poll()`
returned 0 forever, `listDeadEvents` was empty, nothing was logged. If you inspect the store by hand,
look for the escaped form (`evtack:refunds:billing%3Aeu:…`), not the literal name.

**The append-log namespace `evt:<topic>` is escaped too**, and that one is not belt-and-braces.
`WorkStore.list(ns)` is specified as a whole-value match — but the key a store *derives* from a
namespace is not something this package can see. The shipped Redis adapter stored records at
`wl:<ns>:<id>` and read a namespace back with a `SCAN MATCH wl:<ns>:*` prefix scan, so on a real
Redis 7 a consumer of topic `orders` was delivered topic `orders:eu`'s events (it never subscribed),
and `emit(topic: 'inv', { id: 'eu:x' })` returned an event id for a record `SET NX` had silently
refused, because topic `inv:eu` + id `x` had already claimed the same key. That adapter is fixed at
its own layer, which is the load-bearing repair; the topic is escaped here as well because
`WorkStore` is a public port, addressing a record by a concatenated key is an ordinary way to
implement it, and an escaped namespace is self-disambiguating under any implementation.

## Retries + dead-letter (`maxAttempts`, `retryDelayMs`)
A handler that keeps throwing is retried on a spaced-out schedule, and after `maxAttempts` failed
attempts the event is **quarantined** (dead-lettered) for that consumer instead of retried forever.

- `maxAttempts` (default **8**) — the same `qatt → qfail` dead-letter shape as
  [@gnldev/queue](../queue/README.md)'s `maxAttempts`, here `evtatt → evtdead`. `Infinity` disables
  quarantine (retry forever) — delivery of other events is still unblocked, but this consumer's
  bookmark stays parked behind the poison event, so every poll rescans the log from that point.
- `retryDelayMs` (default: exponential, 60s doubling to a 1h cap; a number = fixed spacing; `0` =
  retry on the very next poll) — the wait before an event may be handed to the handler again. Without
  it `maxAttempts` would count polls rather than time: at `pollMs: 200` the whole budget burns in about
  a second, so a one-second downstream blip would dead-letter everything in flight. With the defaults
  a failing event is given up on after **~2 hours**, not one second. A waiting event is skipped, never
  lost: the bookmark stays frozen behind it exactly as for a failing one — which is what the
  [load profile](#load-profile-while-an-event-is-failing-or-waiting) below is about.
  The function form must return a finite number of milliseconds; if it throws or returns
  `Infinity`/`NaN`/a non-number, that attempt falls back to the default schedule and logs a warning
  (one consumer's broken schedule must not stop the topic's other deliveries). "Retry forever" is
  `maxAttempts: Infinity`, not a delay of `Infinity`.
- A quarantined event is **not** acked — quarantine records that the consumer never saw it. It is
  logged at `console.error` when it happens, listed by `listDeadEvents`, and comes back only through
  `retryDeadEvent`, which is per-consumer (re-emitting would fan out to healthy consumers too).
  Dead-letter records are kept as history after a successful retry, like queue's `qfail`.

```ts
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '@gnldev/events';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');
await emit(storage.work, 'refunds', { orderId: 'o1' }, { id: 'refund-o1' });

const consumer = createConsumer(
  storage.work,
  'refunds',
  async (payload: { orderId: string }) => {
    await paymentApi.refund(payload.orderId);      // must be idempotent — delivery is at-least-once
  },
  {
    name: 'refunder',
    maxAttempts: 6,                                // quarantine after 6 failed attempts (default 8)
    retryDelayMs: (attempt) => Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000),
  },
);
await consumer.poll();

// The operator surface: what was given up on, and how to hand it back once the cause is fixed.
for (const dead of await listDeadEvents(storage.work, 'refunds', 'refunder')) {
  if (dead.status !== 'quarantined') continue;     // 'released' / 'delivered' are history, not a backlog
  console.error(`refund ${dead.id} failed ${dead.attempts}x: ${dead.error}`);
  await retryDeadEvent(storage.work, 'refunds', 'refunder', dead.id);
}
```

## Load profile while an event is failing or waiting

A consumer's persisted bookmark cannot move past an event that is still retryable — that is what
makes a retry safe rather than a silent skip. The price is that **every poll re-scans the log from
that point to the end**, and this is the *default* path, not something only `maxAttempts: Infinity`
opts into. Plan capacity for it.

Measured (real SQLite, 5 000 events, one failing event at index 10, default page size 50):

| poll | `work.list` | `work.get` | note |
|---|---|---|---|
| pass 1, delivering | 100 | 15 003 | 3 gets per undelivered event (ack + dead-letter + attempt) |
| pass 2–3, idle, **bookmark frozen** | 100 | 5 004 | 1 get per already-acked event, every poll |
| after the event is quarantined | 1 | 52 | only the last partial page — the healthy steady state |

That is a **~96×** difference in reads per poll between a frozen consumer and a healthy one, and it
scales with the length of the topic log, not with the number of events actually waiting. On Postgres
each of those `get`s is a network round-trip.

In wall clock, with two consumers on the same 50 000-event log (file-backed SQLite, one machine): the
healthy consumer's idle poll takes **56–67 ms**, the frozen one's **8.9–10.3 s**. Same log, same
store — the only difference is where the bookmark sits.

Two things make the window longer than you might expect:

- **`retryDelayMs` widened it from ~1 s to ~2 h.** The bookmark stays frozen for the whole retry
  schedule, not just while the handler is actually failing. Before spaced retries the budget burned
  out in about a second; the default now spends 8 attempts over roughly two hours, so a single poison
  event holds the bookmark for that long before quarantine releases it.
- **Empty-poll backoff does not help a busy topic.** It only grows the interval when a poll delivers
  *nothing* (`delivered > 0` resets it), so on a topic that is otherwise healthy the consumer keeps
  polling at `pollMs` — 5 polls per second at the default 200 ms — and pays the full rescan each time.
  On a fully idle topic the interval does reach `pollMs * 32` (6.4 s by default), which does help.

This is not a regression: the old behavior was worse (one poison event blocked every event behind it
indefinitely). It is a documented change in cost. If it matters for your topic: lower `maxAttempts` or
`retryDelayMs` so quarantine arrives sooner, raise `pollMs`, or keep topics short with retention
sweeps so "the rest of the log" stays small.

## Empty-poll backoff (on by default)
If `start()` delivers no events on a given `poll()` call, the next wait starts at `pollMs` and doubles
(cap: `maxPollMs ?? pollMs*32`); it resets to `pollMs` as soon as an event is delivered. This prevents a
large number of consumers on an empty topic from generating tens of thousands of empty queries per second
(a poll storm). `backoff: false` reverts to the old fixed-interval behavior.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
