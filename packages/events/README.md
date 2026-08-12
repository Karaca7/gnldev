# @gnldev/events

A **durable event/notification bus** on top of the journal. `emit` writes to an append-only log; each
consumer processes events with its own ack marker: **exactly-once marking + at-least-once delivery**. The
marker is written **after** the handler succeeds — if the handler throws or the process dies, the event
isn't lost, the next poll retries it. The cost: between handler success and marking, a crash (or a
concurrent poll race) can cause redelivery → **write the handler as idempotent**, or use something durable
inside it (`runDurable`/`claim`). Fan-out: N consumers → each gets every event at least once, via its own
marker stream.

```bash
npm i @gnldev/events   # peer: @gnldev/durable
```

```ts
import { emit, createConsumer } from '@gnldev/events';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const journal = new SqliteStorage('runs.db').runs;

// Publish (idempotent: same id → a single event).
await emit(journal, 'refunds', { orderId: 'o1', amount: 50 }, { id: 'refund:o1' });

// Consume (each consumer name gets its own marker stream; the handler must be idempotent).
const consumer = createConsumer(journal, 'refunds', (payload, meta) => notify(payload), { name: 'emailer' });
await consumer.poll();   // or consumer.start()
```

## API
- `emit(journal, topic, payload, { id? }) → eventId`
- `createConsumer(journal, topic, handler, { name, pollMs?, backoff?, maxPollMs? }) → { poll, start, stop }`
  — `name` is required to separate fan-out acks.

## How it works
An append-only log per topic; consumer ack markers are separated by `name` → the same event flows to
multiple consumers. Since the marker is written after handler success, the delivery guarantee is
at-least-once: on a handler error the event is skipped (the marker isn't written, the page cursor doesn't
advance) and the next poll retries it; marking itself is exactly-once via CAS (`ackOnce`).

## Empty-poll backoff (on by default)
If `start()` delivers no events on a given `poll()` call, the next wait starts at `pollMs` and doubles
(cap: `maxPollMs ?? pollMs*32`); it resets to `pollMs` as soon as an event is delivered. This prevents a
large number of consumers on an empty topic from generating tens of thousands of empty queries per second
(a poll storm). `backoff: false` reverts to the old fixed-interval behavior.
