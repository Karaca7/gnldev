// The types a user of @gnldev/events writes code against, as the published declarations (dist) state
// them: `emit` and `createConsumer` take the work store, a handler written inline gets
// `meta: EventMeta` without annotations — whose owner fields are optional, because a system event has
// none — a consumer needs its `name`, the dead-letter view's `status` is a closed set, and
// `eventEraser` is something `eraseSubject` accepts. A widening — to `any`, or to a bare `string` —
// keeps every runtime test green, so it is held here.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` or
// a `@ts-expect-error` here would pass whatever the types said. Every negative case is its positive
// case with ONE mutation, and asserts the exact TypeScript error code that mutation must produce — a
// negative that only counted errors would also pass on a typo'd import (TS2305).
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** The base with exactly one occurrence of `from` replaced; throws if `from` is not there exactly once. */

const codes = (d: TypeDiagnostic[]) => d.map((x) => x.code);
const TIMEOUT = 60_000;

const HELPERS = `
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
`;

// ─── emit, consumers, the dead-letter surface ──────────────────────────────────────────────────

// The README's quickstart, with the one name it assumes (`notify`, the reader's own) declared.
const README_QUICKSTART = `
import { emit, createConsumer } from '@gnldev/events';
import { SqliteStorage } from '@gnldev/durable/sqlite';
declare const notify: (payload: unknown) => void;

const storage = new SqliteStorage('runs.db');   // emit/createConsumer take the WORK store

// Publish (idempotent: same id → a single event).
await emit(storage.work, 'refunds', { orderId: 'o1', amount: 50 }, { id: 'refund-o1' });

// Consume (each consumer name gets its own marker stream; the handler must be idempotent).
const consumer = createConsumer(storage.work, 'refunds', (payload, meta) => notify(payload), { name: 'emailer' });
await consumer.poll();   // or consumer.start()
`;

// The README's dead-letter sample, with `paymentApi` (the reader's own) declared.
const README_DEAD_LETTER = `
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '@gnldev/events';
import { SqliteStorage } from '@gnldev/durable/sqlite';
declare const paymentApi: { refund(orderId: string): Promise<void> };

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
  console.error(\`refund \${dead.id} failed \${dead.attempts}x: \${dead.error}\`);
  await retryDeadEvent(storage.work, 'refunds', 'refunder', dead.id);
}
`;

// A handler written inline, with no annotation: meta must be inferred as EventMeta.
const INLINE_HANDLER = `
import { emit, createConsumer } from '@gnldev/events';
import type { Consumer, EventMeta } from '@gnldev/events';
import { InMemoryStorage } from '@gnldev/durable';
${HELPERS}
const storage = new InMemoryStorage();

const id: Promise<string> = emit(storage.work, 'orders', { n: 1 }, { id: 'o1', resourceId: 'ayse', orgId: 'acme', maxDepth: 1000 });

const consumer: Consumer = createConsumer(storage.work, 'orders', async (payload, meta) => {
  const metaIsEventMeta: Same<typeof meta, EventMeta> = true;
  const where: [string, string] = [meta.id, meta.topic];
  const who: string | undefined = meta.resourceId;
  const org: string | undefined = meta.orgId;
  void [payload, metaIsEventMeta, where, who, org];
}, { name: 'billing', pollMs: 500, backoff: false, retryDelayMs: 0 });
const delivered: Promise<number> = consumer.poll();
export { id, delivered };
`;

describe('@gnldev/events emit, consumers and the dead-letter surface', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      readmeQuickstart: README_QUICKSTART,
      readmeDeadLetter: README_DEAD_LETTER,
      inline: INLINE_HANDLER,
      // A system event has no owner: meta.resourceId may be absent.
      ownerIsOptional: mutate(INLINE_HANDLER, 'const who: string | undefined = meta.resourceId;', 'const who: string = meta.resourceId;'),
      // Fan-out acks are separated by the consumer's name: it is required.
      nameIsRequired: mutate(INLINE_HANDLER, "{ name: 'billing', pollMs: 500,", '{ pollMs: 500,'),
      // A dead event's status is a closed set: a misspelt one is caught.
      statusIsClosed: mutate(README_DEAD_LETTER, "dead.status !== 'quarantined'", "dead.status !== 'quarantine'"),
      // retryDelayMs is milliseconds or a function of the attempt, nothing else.
      retryDelayIsTyped: mutate(INLINE_HANDLER, 'retryDelayMs: 0', "retryDelayMs: 'fast'"),
      // emit takes the WORK store, not the storage.
      emitTakesWork: mutate(INLINE_HANDLER, "emit(storage.work, 'orders'", "emit(storage, 'orders'"),
    });
  }, TIMEOUT);

  it('the README quickstart compiles', () => expect(d.readmeQuickstart).toEqual([]));
  it('the README dead-letter sample compiles', () => expect(d.readmeDeadLetter).toEqual([]));
  it('an inline handler gets meta: EventMeta', () => expect(d.inline).toEqual([]));
  it("meta's owner is optional (TS2322)", () => expect(codes(d.ownerIsOptional)).toEqual([2322]));
  it('a consumer needs its name (TS2345)', () => {
    expect(codes(d.nameIsRequired)).toEqual([2345]);
    expect(d.nameIsRequired[0].message).toContain("'name'");
  });
  it("a dead event's status is a closed set (TS2367)", () => expect(codes(d.statusIsClosed)).toEqual([2367]));
  it('retryDelayMs is a number or a function (TS2322)', () => expect(codes(d.retryDelayIsTyped)).toEqual([2322]));
  it('emit refuses the storage in place of its work store (TS2345)', () => expect(codes(d.emitTakesWork)).toEqual([2345]));
});

// ─── eventEraser, and nothing is any ───────────────────────────────────────────────────────────

const ERASE = `
import { eventEraser } from '@gnldev/events';
import { InMemoryStorage, eraseSubject } from '@gnldev/durable';
import type { EraseReport, SubjectEraser } from '@gnldev/durable';
const storage = new InMemoryStorage();

const eraser: SubjectEraser = eventEraser(storage.work);
const report: EraseReport = await eraseSubject(storage, 'ayse', { orgId: 'acme', erasers: [eventEraser(storage.work!)] });
export { eraser, report };
`;

// Nothing a user touches is `any`. The handler's payload is `any` by design (EventHandler), and a dead
// event's payload is `unknown`, so neither is in this list.
const NOTHING_IS_ANY = `
import type {
  emit, createConsumer, listDeadEvents, retryDeadEvent, eventEraser,
  EventHandler, EventMeta, ConsumerOptions, Consumer, DeadEvent,
} from '@gnldev/events';
${HELPERS}
const meta: IsAny<Parameters<EventHandler>[1]> = false;
const metaOwner: IsAny<EventMeta['resourceId']> = false;
const metaId: IsAny<EventMeta['id']> = false;
const emitWork: IsAny<Parameters<typeof emit>[0]> = false;
const emitOpts: IsAny<Parameters<typeof emit>[3]> = false;
const emitted: IsAny<Awaited<ReturnType<typeof emit>>> = false;
const consumerOpts: IsAny<Parameters<typeof createConsumer>[3]> = false;
const consumerHandler: IsAny<Parameters<typeof createConsumer>[2]> = false;
const consumer: IsAny<ReturnType<typeof createConsumer>> = false;
const polled: IsAny<Awaited<ReturnType<Consumer['poll']>>> = false;
const retryDelay: IsAny<ConsumerOptions['retryDelayMs']> = false;
const dead: IsAny<Awaited<ReturnType<typeof listDeadEvents>>[number]> = false;
const deadStatus: IsAny<DeadEvent['status']> = false;
const deadError: IsAny<DeadEvent['error']> = false;
const retried: IsAny<Awaited<ReturnType<typeof retryDeadEvent>>> = false;
const eraser: IsAny<ReturnType<typeof eventEraser>> = false;
const eraserArg: IsAny<Parameters<typeof eventEraser>[0]> = false;
export { meta, metaOwner, metaId, emitWork, emitOpts, emitted, consumerOpts, consumerHandler, consumer, polled, retryDelay, dead, deadStatus, deadError, retried, eraser, eraserArg };
`;

describe('@gnldev/events eventEraser, and nothing public is any', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => {
    d = typeDiagnostics(__dirname, {
      erase: ERASE,
      nothingIsAny: NOTHING_IS_ANY,
      // The control for the list above: an `any` in it is caught.
      anyIsCaught: mutate(NOTHING_IS_ANY, 'IsAny<Parameters<EventHandler>[1]>', 'IsAny<any>'),
      // eventEraser takes the root work store, not the storage.
      eraserTakesWork: mutate(ERASE, 'eventEraser(storage.work)', 'eventEraser(storage)'),
    });
  }, TIMEOUT);

  it('eventEraser is accepted by eraseSubject, as the durable README passes it', () => expect(d.erase).toEqual([]));
  it('nothing public is any', () => expect(d.nothingIsAny).toEqual([]));
  it('the any check can fail (TS2322)', () => expect(codes(d.anyIsCaught)).toEqual([2322]));
  it('eventEraser refuses the storage in place of the work store (TS2345)', () => expect(codes(d.eraserTakesWork)).toEqual([2345]));
});
