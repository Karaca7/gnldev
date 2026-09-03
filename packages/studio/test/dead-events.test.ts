// Events dead-letter: GET /dead-events, GET /dead-events/topics, POST /dead-events/release.
//
// The host bridges these to @gnldev/events' `listDeadEvents(work, topic, consumer)` and
// `retryDeadEvent(work, topic, consumer, eventId)` — studio itself has NO dependency on
// @gnldev/events (bridged via the StudioEvents interface), so the fixture below mimics the real
// semantics rather than the package.
//
// WHAT IS DELIBERATELY NOT A COPY OF jobs-retry.test.ts, because the two dead-letters are not the
// same shape:
//   1. ADDRESSING. A queue hands one job to one worker, so `:id` names it. A topic FANS OUT, so an
//      event carries one quarantine record PER CONSUMER and only `(topic, consumer, id)` names one.
//      Half a triple is a 400, not a lookup that happens to miss.
//   2. AFTERMATH. `retryJob` re-queues under a NEW id and leaves TWO rows; `retryDeadEvent` stamps
//      the existing record and leaves ONE, now `released`. Asserted, because it is the difference an
//      operator sees and the reason the action is called `release`.
//   3. IDEMPOTENCY. Releasing an already-`released` event is a real, documented operation (it is the
//      only way out of the rescan-flag race) and must NOT 409. Only `delivered` is terminal.
//   4. ROUTE. `/events` is this API's SSE change stream. The dead-letter must not be reachable there.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi, type StudioDeadEvent, type StudioEvents } from '../src/server.js';
import { call } from './call.js';

/**
 * A fake events host with the same rules @gnldev/events enforces: a release stamps the record in
 * place, `delivered` is the one terminal state, and an already-`released` record may be released
 * again.
 */
function fakeEvents(dead: StudioDeadEvent[]): StudioEvents & { releaseCalls: string[]; listCalls: string[] } {
  const key = (t: string, c: string, id: string) => `${t}|${c}|${id}`;
  const byKey = new Map(dead.map((e) => [key(e.topic, e.consumer, e.id), { ...e }]));
  const releaseCalls: string[] = [];
  const listCalls: string[] = [];
  return {
    releaseCalls,
    listCalls,
    topics: () => {
      const m = new Map<string, Set<string>>();
      for (const e of byKey.values()) m.set(e.topic, (m.get(e.topic) ?? new Set()).add(e.consumer));
      return [...m].map(([topic, cs]) => ({ topic, consumers: [...cs] }));
    },
    listDead: (topic, consumer) => {
      listCalls.push(`${topic}|${consumer}`);
      return [...byKey.values()].filter((e) => e.topic === topic && e.consumer === consumer);
    },
    release: (topic, consumer, id) => {
      releaseCalls.push(key(topic, consumer, id));
      const rec = byKey.get(key(topic, consumer, id));
      // Never quarantined, or already delivered — retryDeadEvent returns false for both.
      if (!rec || rec.status === 'delivered') return false;
      // IN PLACE: the same record, stamped. No second row is created.
      rec.status = 'released';
      rec.releasedAt = 100;
      rec.releases = (rec.releases ?? 0) + 1;
      return true;
    },
  };
}

/** What a real event body looks like: the producer's own data, not configuration. */
const PII = { customerEmail: 'jane@customer.example', ssn: '123-45-6789', message: 'please cancel my order' };

const DEAD: StudioDeadEvent[] = [
  { id: 'e1', topic: 'orders.created', consumer: 'billing', status: 'quarantined', error: 'boom', attempts: 8, at: 10, payload: PII },
  { id: 'e2', topic: 'orders.created', consumer: 'billing', status: 'delivered', error: 'boom', attempts: 8, at: 11 },
  // The SAME event id, quarantined for a different consumer — fan-out in one row. An id-only API
  // could not tell these apart.
  { id: 'e1', topic: 'orders.created', consumer: 'search', status: 'quarantined', error: 'index down', attempts: 8, at: 12 },
];

const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/**
 * A provider that produces principals the scan budget can actually TELL APART, which most of this
 * file's other apps deliberately cannot.
 *
 * Token grammar, so a test can say which shape of caller it means in one string:
 *   `alice`        → `{ id: 'alice' }`                — an operator
 *   `acme/alice`   → `{ id: 'alice', orgId: 'acme' }` — an org-bound operator
 *   `?acme`        → `{ orgId: 'acme' }`              — NO id: the API-key bridge shape. `Principal.id`
 *                                                       is optional, and a provider that only knows
 *                                                       which organization a key belongs to is a
 *                                                       realistic one.
 * Every principal is a full admin: this file is about the scan budget, and a permission denial would
 * answer before the budget is ever consulted.
 */
const identityAuth = () => ({
  authenticate: (req: Request) => {
    const tok = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
    if (!tok) return null;
    const base = { roles: ['admin'], permissions: ['*:read', '*:write'] };
    if (tok.startsWith('?')) return { ...base, orgId: tok.slice(1) };
    const [a, b] = tok.split('/');
    return b ? { ...base, id: b, orgId: a } : { ...base, id: a };
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ rbac: true }),
}) as never;

const as = (app: any, who: string, path: string) => call(app, path, { headers: { authorization: `Bearer ${who}` } });
const asAlice = (app: any, path: string) => as(app, 'alice', path);
/** Long enough for the request under test to reach the host, short enough not to be a wait. */
const tick = () => new Promise((r) => setTimeout(r, 1));

/** A host scan that is still running when the next request arrives — the only interesting case. */
const slowEvents = (delayMs = 30) => {
  let started = 0;
  // PEAK concurrency, not a call count. `started` is incremented on entry, so it reaches 2 whether the
  // two scans overlapped or ran one after the other — an assertion on it cannot tell "concurrency is
  // one" from "concurrency is two", which is the property the queue exists to hold. `inFlight` is
  // decremented on the way out, so its high-water mark answers the question the count only looked
  // like it was answering.
  let inFlight = 0;
  let peak = 0;
  const events: StudioEvents & { started: () => number; peak: () => number } = {
    started: () => started,
    peak: () => peak,
    topics: () => [{ topic: 'orders.created', consumers: ['billing'] }],
    listDead: async (topic, consumer) => {
      started++;
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return DEAD.filter((e) => e.topic === topic && e.consumer === consumer);
      } finally {
        inFlight--;
      }
    },
  };
  return events;
};

/** Echoes back whichever pair it was asked for, so a substituted answer is visible in the rows. */
const rowsFor = (t: string, c: string): StudioDeadEvent[] => [{
  id: `ROW(${t}/${c})`, topic: t, consumer: c, status: 'quarantined',
  error: `SECRET-${t}-${c}`, attempts: 1, at: 1, payload: { secret: `for-${t}-${c}` },
}];

describe('GET /dead-events', () => {
  it('lists the quarantine for ONE topic+consumer pair', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const res = await call(app, '/dead-events?topic=orders.created&consumer=billing');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((e: StudioDeadEvent) => `${e.id}:${e.status}`)).toEqual(['e1:quarantined', 'e2:delivered']);
  });

  it('a different consumer gets its OWN records for the same event id (fan-out is per consumer)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const body = await (await call(app, '/dead-events?topic=orders.created&consumer=search')).json();

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'e1', consumer: 'search', error: 'index down' });
  });

  it('400 without a topic AND a consumer — half a triple names nothing', async () => {
    const events = fakeEvents(DEAD);
    const app = createStudioApi({ reader: new InMemoryJournal(), events });
    for (const qs of ['', '?topic=orders.created', '?consumer=billing']) {
      const res = await call(app, `/dead-events${qs}`);
      expect(res.status, `'${qs}' should not be treated as a complete address`).toBe(400);
    }
    expect(events.listCalls, 'a malformed address still reached the (expensive) host scan').toHaveLength(0);
  });

  it('answers an empty list, not an error, when the host wired no events object', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await call(app, '/dead-events?topic=t&consumer=c');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('the read gate refuses before the host is reached (401 with no credentials presented)', async () => {
    const events = fakeEvents(DEAD);
    const app = createStudioApi({ reader: new InMemoryJournal(), events, auth: { read: () => false } });
    const res = await call(app, '/dead-events?topic=orders.created&consumer=billing');

    // 401, not 403: nothing was presented to reject. The status is @gnldev/auth's, not this route's —
    // what belongs to this route is that the expensive whole-log scan never ran.
    expect(res.status).toBe(401);
    expect(events.listCalls, 'a refused request still scanned the topic log').toHaveLength(0);
  });

  /**
   * The route the briefing called a collision, asserted rather than assumed: `/events` is the SSE
   * change stream and must stay one. If a later refactor moved the dead-letter under it, this is what
   * would notice.
   */
  it('does not live under /events — that path is still the SSE change stream', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const res = await call(app, '/events');
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    await res.body?.cancel();
  });
});

/**
 * The event BODY, which is the one field on this route that is not configuration.
 *
 * `GET /dead-events` requires `catalog:read`, and that permission's own catalogue entry promises
 * "Agents, tools, workflows, policy, providers — no customer data". `StudioDeadEvent.payload` is
 * whatever the producer emitted. Measured against a grant of exactly `['runs:read','catalog:read']`
 * before this gate existed:
 *
 *   GET /threads                        -> 403 {"error":"missing threads:read"}
 *   GET /dead-events?topic=…&consumer=…  -> 200 [{…,"payload":{"customerEmail":"jane@customer.example",
 *                                                 "ssn":"123-45-6789", …}}]
 *
 * Two conditions now have to hold, and they are pinned separately below because either one alone is
 * a hole: the caller must ASK (`?payload=1`) and the caller must be ALLOWED (`events:read`).
 */
describe('the event body', () => {
  /** Minimal RBAC, the same shape as read-permissions.test.ts's (which mirrors @gnldev/auth-ee rbac.ts). */
  const matches = (granted: string, required: string): boolean => {
    if (granted === '*' || granted === required) return true;
    const [gRes, gAct] = granted.split(':');
    const [rRes, rAct] = required.split(':');
    return (gRes === '*' || gRes === rRes) && (gAct === '*' || gAct === rAct);
  };
  const PEOPLE: Record<string, string[]> = {
    // The persona this finding is about: may see that a delivery failed, may not read end-user data.
    support: ['runs:read', 'catalog:read'],
    // The grant every role preset starts from — it must lose nothing.
    everything: ['*:read'],
  };
  const rbacApp = () => createStudioApi({
    reader: new InMemoryJournal(),
    events: fakeEvents(DEAD),
    auth: {
      authenticate: (req: Request) => {
        const tok = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
        return PEOPLE[tok] ? { id: tok, roles: ['viewer'], permissions: PEOPLE[tok] } : null;
      },
      authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string; action: string; path?: string }) => {
        const need = ctx.permission ?? `${ctx.path?.split('/').filter(Boolean)[0] ?? 'unknown'}:${ctx.action}`;
        return (p?.permissions ?? []).some((g) => matches(g, need))
          ? { allow: true } : { allow: false as const, status: 403 as const, reason: `missing ${need}` };
      },
      capabilities: () => ({ rbac: true, multiOrganization: false }),
    } as never,
  });
  const list = (app: unknown, who: string, qs = '') =>
    call(app as never, `/dead-events?topic=orders.created&consumer=billing${qs}`, { headers: { authorization: `Bearer ${who}` } });

  it('is NOT in the default answer, however wide the caller\'s grant', async () => {
    // Not "the narrow grant is filtered": the DEFAULT carries no body at all, so a client that never
    // heard of this parameter cannot receive one by accident.
    const app = rbacApp();
    for (const who of ['support', 'everything']) {
      const body = await (await list(app, who)).text();
      expect(body, `${who} was handed an event body it did not ask for`).not.toContain('123-45-6789');
      // The record must survive the withholding — the guard here is that suppressing data does not
      // suppress the ROW. What stays is the operational half (id/status/attempts); `error` is host
      // text that can quote the payload, so it follows the same grant as the body: `everything`
      // keeps it, `support` is told per record that there was one rather than being left to read an
      // absent field as "this delivery failed for no reason".
      const row = JSON.parse(body)[0];
      expect(row, 'the record itself went missing along with the body').toMatchObject({ id: 'e1' });
      expect(
        who === 'support' ? { errorRestricted: row.errorRestricted, error: row.error } : { error: row.error },
        `${who} got the wrong side of the error gate`,
      ).toEqual(who === 'support' ? { errorRestricted: true, error: undefined } : { error: 'boom' });
    }
  });

  it('reaches a caller that asks AND may — the surface still works', async () => {
    // Without this the test above is satisfied by never sending a body to anyone, which is a
    // different (and undetected) regression.
    const rows = await (await list(rbacApp(), 'everything', '&payload=1')).json();
    expect(rows[0].payload, '`*:read` lost access to something it could read before').toEqual(PII);
    expect(rows[0].payloadRestricted).toBeUndefined();
  });

  it('is withheld from a caller that asks and may NOT — and it is told so, per record', async () => {
    const res = await list(rbacApp(), 'support', '&payload=1');
    // 200, not 403: reading the quarantine IS part of `catalog:read`. Only the bodies are not, so the
    // list survives and the UI can say which of the two happened without a second whole-log scan.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, 'the body reached a grant whose own description promises no customer data').not.toContain('123-45-6789');
    expect(JSON.parse(text)[0]).toMatchObject({ id: 'e1', payloadRestricted: true });
  });

  it('and this is the SAME caller that cannot read /threads — the two answers now agree', async () => {
    // The contradiction, asserted as one pair rather than as two facts in two files. Refusing an
    // end user's own words on one route while handing over their order on another is not a policy.
    const app = rbacApp();
    const threads = await call(app, '/threads', { headers: { authorization: 'Bearer support' } });
    expect(threads.status, 'the premise is gone — this grant reads conversations now').toBe(403);
    const rows = await (await list(app, 'support', '&payload=1')).json();
    expect(rows[0].payload, 'refused the conversation and handed over the event body instead').toBeUndefined();
  });

  it('the free tier is untouched — no provider means no permission model to fail', async () => {
    // The whole `events:read` gate reduces to `action: 'read'` for a coarse provider, and to nothing
    // at all when auth is off. A deployment that never heard of permissions must be unaffected.
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const rows = await (await call(app, '/dead-events?topic=orders.created&consumer=billing&payload=1')).json();
    expect(rows[0].payload).toEqual(PII);
  });
});

/**
 * The only brake on the most expensive read this API serves.
 *
 * MEASURED on real SQLite (20 000-event topic, nothing quarantined) before it existed:
 *   1 request   -> 200, 0 rows, 1 470 ms, 20 400 store calls
 *   10 at once  -> 15 511 ms of wall time, 204 000 store calls
 * Ten 60-byte GETs, and the single-threaded event loop served nobody else for fifteen seconds. After:
 *   10 at once, same triple      -> 1 445 ms, 20 400 store calls, all 200 (they COALESCE)
 *   10 at once, 10 different     -> 1 529 ms, 20 400 store calls, 200 + nine 429s
 * The work is bounded at one scan whatever the request pattern is.
 */
describe('the scan limit', () => {
  it('coalesces identical concurrent requests onto ONE scan, and answers all of them', async () => {
    const events = slowEvents();
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    const res = await Promise.all(Array.from({ length: 10 },
      () => call(app, '/dead-events?topic=orders.created&consumer=billing')));

    expect(res.map((r) => r.status), 'a caller asking the same question was turned away').toEqual(Array(10).fill(200));
    expect(events.started(), 'ten requests bought ten whole-topic-log scans').toBe(1);
    // Coalescing must hand back the real answer, not an empty placeholder.
    expect((await res[8]!.json()).map((e: StudioDeadEvent) => e.id)).toEqual(['e1', 'e2']);
  });

  /**
   * ONE CALLER, TWO DIFFERENT TRIPLES — the admission budget, and the only refusal that is allowed to
   * say "your own scan".
   *
   * AUTHENTICATED, deliberately. This assertion used to run against a providerless app, where every
   * request collapsed into the same `["",""]` admission bucket — so what it actually pinned was the
   * deployment-wide refusal, under a name that claimed the opposite. The budget is per caller, so the
   * test has to have a caller; the anonymous case is the next test and has a different answer.
   */
  it('turns away the SAME caller’s scans past its allowance, with a retryable status', async () => {
    // A CAP, not a lock, and the difference was measured rather than argued. At one, a caller's own
    // in-flight scan spent its whole allowance, so anyone else behind the SAME credential — the shape
    // `gnl add host` scaffolds, one bearer token for a team — was refused on arrival. One shared admin
    // token, one sequential attacker connection: the operator was served 0 of 20, against 20 of 20 on
    // the same deployment with no identity at all. Naming the caller made it worse than not naming it.
    // The flood the allowance exists to stop is CONCURRENT, and a cap bounds that just as well.
    const events = slowEvents();
    const app = createStudioApi({ reader: new InMemoryJournal(), events, auth: identityAuth() });

    const [first, second, third] = await Promise.all([
      asAlice(app, '/dead-events?topic=orders.created&consumer=billing'),
      asAlice(app, '/dead-events?topic=orders.created&consumer=search'),
      asAlice(app, '/dead-events?topic=orders.shipped&consumer=billing'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status, 'a second party behind one credential was refused on arrival').toBe(200);
    expect(third.status, 'the per-caller allowance did not bound anything').toBe(429);
    // 429 and not 503: the caller may do this, just not right now — and it must be told when to come
    // back, or a client has nothing to act on but a guess. The number is the deployment's queue
    // budget until a scan has actually been timed here — see `Retry-After` below.
    expect(third.headers.get('retry-after')).toBe('5');
    expect((await third.json()).code, 'an uncoded 429 is indistinguishable from an upstream rate limit').toBe('dead_scan_busy');
    // Concurrency is still one: the second scan RAN, it just did not run alongside the first.
    expect(events.peak(), 'two whole-log scans ran at once').toBe(1);
    expect(events.started(), 'the refused request reached the host scan anyway').toBe(2);
  });

  /**
   * THE SAME REQUEST PAIR WITH NO AUTH PROVIDER — served, not refused.
   *
   * There is no caller to charge the budget to, so nothing is charged: the second request waits for
   * the slot and gets a real answer a scan later. Concurrency is still one (asserted), which is the
   * property the budget exists to protect; what is gone is the refusal that used to be handed to
   * whoever happened to arrive second on a deployment that has no way to tell its operators apart.
   */
  it('QUEUES a different scan instead, when the deployment cannot tell its callers apart', async () => {
    const events = slowEvents();
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    const [first, second] = await Promise.all([
      call(app, '/dead-events?topic=orders.created&consumer=billing'),
      call(app, '/dead-events?topic=orders.created&consumer=search'),
    ]);

    expect([first.status, second.status], 'an unidentifiable caller was refused for somebody else’s scan')
      .toEqual([200, 200]);
    expect((await second.json())[0], 'the queued caller got the wrong pair’s rows').toMatchObject({ consumer: 'search' });
    // Both scans really happened AND they did not overlap. The count alone reads the same whether the
    // queue held or not — see `slowEvents`, where the second assertion's number comes from.
    expect(events.started(), 'the second scan never reached the host').toBe(2);
    expect(events.peak(), 'the two scans ran at once — concurrency is no longer one').toBe(1);
  });

  it('lets the next scan through once the first finishes — this is a brake, not a lock', async () => {
    const events = slowEvents(5);
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    expect((await call(app, '/dead-events?topic=orders.created&consumer=billing')).status).toBe(200);
    expect((await call(app, '/dead-events?topic=orders.created&consumer=search')).status).toBe(200);
    expect(events.started()).toBe(2);
  });

  it('coalesced callers are still gated INDIVIDUALLY — one scan, two different answers', async () => {
    // The trap this design creates, and the reason the payload decision sits after the `await`: two
    // requests share one result array, so deciding what may leave the process ONCE would hand the
    // narrower caller whatever the wider one was entitled to (or the other way round, depending on
    // who arrived first).
    let started = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: {
        listDead: async () => { started++; await new Promise((r) => setTimeout(r, 30)); return DEAD; },
      },
      auth: {
        authenticate: (req: Request) => {
          const tok = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
          return { id: tok, roles: ['viewer'], permissions: tok === 'wide' ? ['*:read'] : ['catalog:read'] };
        },
        authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string }) => {
          const need = ctx.permission ?? 'unknown:read';
          const ok = (p?.permissions ?? []).some((g) => g === '*:read' ? need.endsWith(':read') : g === need);
          return ok ? { allow: true } : { allow: false as const, status: 403 as const, reason: `missing ${need}` };
        },
        capabilities: () => ({ rbac: true }),
      } as never,
    });

    const url = '/dead-events?topic=orders.created&consumer=billing&payload=1';
    const [wide, narrow] = await Promise.all([
      call(app, url, { headers: { authorization: 'Bearer wide' } }),
      call(app, url, { headers: { authorization: 'Bearer narrow' } }),
    ]);

    expect(started, 'the two requests did not actually share a scan — the test proves nothing').toBe(1);
    expect((await wide.json())[0].payload).toEqual(PII);
    expect((await narrow.json())[0], 'a shared scan leaked the body to the caller that may not read it')
      .toMatchObject({ payloadRestricted: true });
  });

  it('releases the slot when the host scan THROWS, or one failure closes the endpoint forever', async () => {
    let calls = 0;
    const events: StudioEvents = {
      listDead: async () => {
        if (++calls === 1) throw new Error('store unavailable');
        return DEAD;
      },
    };
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    await call(app, '/dead-events?topic=orders.created&consumer=billing').catch(() => {});
    const after = await call(app, '/dead-events?topic=orders.created&consumer=billing');
    expect(after.status, 'a failed scan left the one slot occupied for the life of the process').toBe(200);
  });
});

describe('GET /dead-events/topics', () => {
  it('names the topic/consumer pairs the list can be pointed at', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const body = await (await call(app, '/dead-events/topics')).json();
    expect(body).toEqual([{ topic: 'orders.created', consumers: ['billing', 'search'] }]);
  });

  it('is empty — not an error — when the host does not enumerate them', async () => {
    const events = fakeEvents(DEAD);
    delete (events as { topics?: unknown }).topics;
    const app = createStudioApi({ reader: new InMemoryJournal(), events });
    expect(await (await call(app, '/dead-events/topics')).json()).toEqual([]);
  });
});

describe('POST /dead-events/release', () => {
  it('releases a quarantined event IN PLACE — one row, now released, not a second row', async () => {
    const events = fakeEvents(DEAD);
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    const before = await (await call(app, '/dead-events?topic=orders.created&consumer=billing')).json();
    const res = await post(app, '/dead-events/release', { topic: 'orders.created', consumer: 'billing', id: 'e1' },
      { 'x-gnl-actor': 'ops@acme.co' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(events.releaseCalls).toEqual(['orders.created|billing|e1']);

    const after = await (await call(app, '/dead-events?topic=orders.created&consumer=billing')).json();
    // THE difference from queue.retry, which would leave `['e1','e1-retry','e2']` here.
    expect(after).toHaveLength(before.length);
    expect(after.find((e: StudioDeadEvent) => e.id === 'e1')).toMatchObject({ status: 'released', releases: 1 });
  });

  it('lands in the audit trail with the topic and consumer, since the id alone is ambiguous', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    await post(app, '/dead-events/release', { topic: 'orders.created', consumer: 'search', id: 'e1' },
      { 'x-gnl-actor': 'ops@acme.co' });

    const audit = await (await call(app, '/audit?action=event.release')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      actor: 'ops@acme.co', target: 'e1', detail: { topic: 'orders.created', consumer: 'search' },
    });
  });

  it('releasing an ALREADY-released event succeeds again — that re-assertion is the way out of the rescan race', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    const body = { topic: 'orders.created', consumer: 'billing', id: 'e1' };

    expect((await post(app, '/dead-events/release', body)).status).toBe(200);
    expect((await post(app, '/dead-events/release', body)).status).toBe(200);

    const after = await (await call(app, '/dead-events?topic=orders.created&consumer=billing')).json();
    expect(after.find((e: StudioDeadEvent) => e.id === 'e1')).toMatchObject({ status: 'released', releases: 2 });
  });

  it('a DELIVERED or unknown event → 409, and nothing is audited', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: fakeEvents(DEAD) });
    for (const id of ['e2', 'no-such-event']) {
      const res = await post(app, '/dead-events/release', { topic: 'orders.created', consumer: 'billing', id });
      expect(res.status, `'${id}' is not releasable`).toBe(409);
    }
    // The same id under a consumer that never quarantined it is equally a no-op — the triple is the address.
    expect((await post(app, '/dead-events/release', { topic: 'orders.created', consumer: 'shipping', id: 'e1' })).status).toBe(409);

    const audit = await (await call(app, '/audit?action=event.release')).json();
    expect(audit.items).toHaveLength(0);
  });

  it('400 on a partial address, before the host is reached at all', async () => {
    const events = fakeEvents(DEAD);
    const app = createStudioApi({ reader: new InMemoryJournal(), events });
    for (const body of [{}, { id: 'e1' }, { topic: 'orders.created', id: 'e1' }, { consumer: 'billing', id: 'e1' }, { topic: 'orders.created', consumer: 'billing' }]) {
      expect((await post(app, '/dead-events/release', body)).status).toBe(400);
    }
    expect(events.releaseCalls).toHaveLength(0);
  });

  it('403 without write permission (release is never called)', async () => {
    const events = fakeEvents(DEAD);
    const app = createStudioApi({ reader: new InMemoryJournal(), events, auth: { write: () => false } });
    const res = await post(app, '/dead-events/release', { topic: 'orders.created', consumer: 'billing', id: 'e1' });

    expect(res.status).toBe(403);
    expect(events.releaseCalls).toHaveLength(0);
  });

  it('501 if release is not implemented (listDead only), and also if events was never given', async () => {
    const readOnly = fakeEvents(DEAD);
    delete (readOnly as { release?: unknown }).release;
    const withHost = createStudioApi({ reader: new InMemoryJournal(), events: readOnly });
    const withoutHost = createStudioApi({ reader: new InMemoryJournal() });
    const body = { topic: 'orders.created', consumer: 'billing', id: 'e1' };

    expect((await post(withHost, '/dead-events/release', body)).status).toBe(501);
    // The feature check comes AFTER the write-permission check, same order as /jobs/:id/retry.
    expect((await post(withoutHost, '/dead-events/release', body)).status).toBe(501);
  });
});

describe('capabilities', () => {
  it('deadEvents/eventsManage follow the host object and its optional release method', async () => {
    const caps = async (opts: object) =>
      await (await call(createStudioApi({ reader: new InMemoryJournal(), ...opts } as never), '/capabilities')).json();

    expect(await caps({})).toMatchObject({ deadEvents: false, eventsManage: false });

    const readOnly = fakeEvents(DEAD);
    delete (readOnly as { release?: unknown }).release;
    expect(await caps({ events: readOnly })).toMatchObject({ deadEvents: true, eventsManage: false });

    expect(await caps({ events: fakeEvents(DEAD) })).toMatchObject({ deadEvents: true, eventsManage: true });
  });

  it('is not confused with the /events SSE stream, which needs no host object at all', async () => {
    const c = await (await call(createStudioApi({ reader: new InMemoryJournal() }), '/capabilities')).json();
    expect(c.deadEvents).toBe(false);
    expect('events' in c, 'a bare `events` capability would read as "the SSE stream is off"').toBe(false);
  });
});

/**
 * In-flight scans are shared: two callers asking for the same (org, topic, consumer) wait on ONE
 * whole-log read instead of buying two. That key used to be built by joining the three parts on a
 * NUL — and a caller can put a NUL in a query string as `%00`, so `topic=a%00b&consumer=c` and
 * `topic=a&consumer=b%00c` produced the SAME key. Measured: the second request was served the first
 * one's rows, with a 200 and no indication anything had been substituted.
 *
 * The same ambiguity `@gnldev/events` escapes its own key parts for, one layer up. Delimiters are
 * forgeable; an encoder is not.
 */
describe('the coalescing key cannot be forged from the query string', () => {
  const NUL = String.fromCharCode(0);

  it('a %00 in topic or consumer does not hand one caller the other pair’s answer', async () => {
    // The substitution only exists WHILE a scan is in flight — that is when the key is looked up and
    // a match is joined instead of started. Sequential requests never overlap, so the first version
    // of this test passed against the bug: the collision needs the first scan held open.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started = 0;

    const app = createStudioApi({
      reader: new InMemoryJournal(),
      // Echoes back whichever pair it was asked for, so a substituted answer is visible in the rows.
      events: {
        orgScoped: true,
        listDead: async (t: string, c: string) => {
          if (++started === 1) await held; // hold the FIRST scan open; the second arrives mid-flight
          return rowsFor(t, c);
        },
      },
    });
    const ask = (t: string, c: string) => call(
      app as never,
      `/dead-events?topic=${encodeURIComponent(t)}&consumer=${encodeURIComponent(c)}&payload=1`,
    );

    const first = ask(`a${NUL}b`, 'c');
    await new Promise((r) => setTimeout(r, 0)); // let the first reach the host
    const second = ask('a', `b${NUL}c`);
    release();
    const [ra, rb] = await Promise.all([first, second]);

    const a = await ra.json();
    expect(a[0].id, 'the first caller stopped receiving its own rows').toBe(`ROW(a${NUL}b/c)`);

    // The second names a DIFFERENT pair, so it must not be joined onto the first's scan. Refusing it
    // (429, one scan at a time) is correct; answering it with the first's rows is the bug.
    if (rb.status === 200) {
      const b = await rb.json();
      expect(b[0].id, 'the second caller was handed the first one’s scan').toBe(`ROW(a/b${NUL}c)`);
      expect(JSON.stringify(b), 'the other pair’s body crossed over').not.toContain(`for-a${NUL}b-c`);
    } else {
      expect(rb.status, 'a distinct pair was neither served nor refused').toBe(429);
    }
  });

  /**
   * The NUL above is one forgeable delimiter; `:` is the one a refactor reaches for by reflex, and
   * topic names carry it routinely (`billing:invoices`). The property is that NO single character
   * joins these parts, so it is asserted for a second, ordinary one — otherwise a `parts.join(':')`
   * passes the whole file.
   */
  it('a `:` in topic or consumer does not either — the property is the encoder, not the character', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started = 0;

    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: {
        orgScoped: true,
        listDead: async (t: string, c: string) => {
          if (++started === 1) await held;
          return rowsFor(t, c);
        },
      },
    });
    const ask = (t: string, c: string) => call(
      app as never,
      `/dead-events?topic=${encodeURIComponent(t)}&consumer=${encodeURIComponent(c)}&payload=1`,
    );

    const first = ask('a:b', 'c');
    await tick();
    const second = ask('a', 'b:c');
    release();
    const [ra, rb] = await Promise.all([first, second]);

    expect((await ra.json())[0].id).toBe('ROW(a:b/c)');
    expect(rb.status, 'the distinct pair was refused rather than queued').toBe(200);
    const b = await rb.json();
    expect(b[0].id, 'the second caller was handed the first one’s scan').toBe('ROW(a/b:c)');
    expect(JSON.stringify(b), 'the other pair’s body crossed over').not.toContain('for-a:b-c');
  });
});

/**
 * WHO the scan budget is charged to.
 *
 * The budget refuses a caller its own second concurrent scan. That is only a bound if two requests
 * from two different callers land in two different buckets — and the first version of it hashed
 * `[orgId ?? '', id ?? '']`, so anything the auth provider did not supply collapsed into one bucket
 * shared by everyone. Measured against the shape `gnl init` scaffolds (no auth at all), one attacker
 * connection with ONE request in flight and a fresh triple each round:
 *
 *   precondition — the operator, alone: 200
 *   under attack — 200 in 0 of 20 attempts        *** starvation ***
 *
 * The same attack against the same code with an auth provider: 200 in 20 of 20. So the mechanism was
 * right and the KEY was wrong, and the tests could not see it because every app in this package's
 * suite is unauthenticated. Both halves are pinned below.
 */
describe('the admission budget’s key', () => {
  /** The measured attack: one connection, one request in flight, a fresh (topic, consumer) each round. */
  const starve = async (app: unknown, attacker: (p: string) => Promise<Response>, victim: (p: string) => Promise<Response>) => {
    let served = 0;
    void app;
    for (let i = 0; i < 20; i++) {
      const attack = attacker(`/dead-events?topic=atk${i}&consumer=atk${i}`);
      await tick();
      if ((await victim('/dead-events?topic=ops&consumer=ops')).status === 200) served++;
      await attack;
    }
    return served;
  };

  it('a deployment with NO auth provider does not let one caller starve the rest', async () => {
    const events = slowEvents(15);
    const app = createStudioApi({ reader: new InMemoryJournal(), events });

    // PRECONDITION, printed as its own claim: the victim's request is well-formed and is served when
    // nobody is competing with it. Without this the count below could be 0 for a trivial reason.
    expect((await call(app, '/dead-events?topic=ops&consumer=ops')).status,
      'the victim request is not even valid on an idle deployment').toBe(200);

    const served = await starve(app, (p) => call(app, p), (p) => call(app, p));
    expect(served, 'the operator was refused for a scan it never started').toBe(20);
  });

  it('and neither does one that HAS one — the per-caller budget still holds', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: slowEvents(15), auth: identityAuth() });

    expect((await asAlice(app, '/dead-events?topic=ops&consumer=ops')).status).toBe(200);
    const served = await starve(app, (p) => as(app, 'mallory', p), (p) => as(app, 'alice', p));
    expect(served, 'an identified operator was starved by an identified attacker').toBe(20);
  });

  /**
   * The other side of the same coin, and the assertion that makes the two tests above non-vacuous: a
   * CONSTANT key (the honest description of what `["",""]` was) passes both of them if the refusal is
   * removed altogether. This pins that the refusal is still there and is still per caller.
   */
  it('is the principal — the same caller is refused where a different caller is not', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), events: slowEvents(30), auth: identityAuth() });

    // TWO held, because the allowance is a cap of two rather than a lock on one — see the admission
    // test above for why one was harmful. The point of this test is unchanged: the cap is charged to
    // the PRINCIPAL, so spending alice's does not spend bob's.
    const held = asAlice(app, '/dead-events?topic=t1&consumer=c1');
    const held2 = asAlice(app, '/dead-events?topic=t1b&consumer=c1b');
    await tick();
    expect((await asAlice(app, '/dead-events?topic=t2&consumer=c2')).status,
      'a caller opened scans past its own allowance').toBe(429);
    expect((await as(app, 'bob', '/dead-events?topic=t3&consumer=c3')).status,
      'bob was charged for alice’s scan').toBe(200);
    expect((await held).status).toBe(200);
    expect((await held2).status).toBe(200);
  });

  /**
   * `Principal.id` is optional. A provider that bridges API keys and only knows which organization a
   * key belongs to returns `{ orgId, permissions }` — and under the old key every caller in that
   * organization shared one bucket. Measured, two such callers asking for different triples at once:
   * `200 / 429`. An organization is not a caller, so it buys no admission at all.
   */
  it('is NOT the organization: an id-less principal is queued, not refused', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: { ...slowEvents(20), orgScoped: true } as never,
      auth: identityAuth(),
    });

    const [a, b] = await Promise.all([
      as(app, '?acme', '/dead-events?topic=t1&consumer=c1'),
      as(app, '?acme', '/dead-events?topic=t2&consumer=c2'),
    ]);
    expect([a.status, b.status], 'two callers the provider cannot tell apart shared one budget').toEqual([200, 200]);
  });

  /**
   * `org` configured, NO auth provider — a supported combination (`x-gnl-org` resolves the scope,
   * nothing binds an identity to it).
   *
   * The coalescing key uses `callerOrg`, which reads that header; the admission key did not, so acme
   * and globex were two callers to one map and one caller to the other. Measured: `200 / 429`, and
   * the 429 read "your own dead-letter scan is still running" to an organization that had never
   * started one. Both sides now agree that neither is identified, so neither is admission-refused —
   * and the precondition below is what makes the assertion mean anything, because a 429 that came
   * from coalescing would look identical.
   */
  it('does not charge one organization for another’s scan when the org comes from a header', async () => {
    const seen: string[] = [];
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      org: {},
      events: {
        orgScoped: true,
        listDead: async (t: string, c: string, ctx?: { orgId?: string }) => {
          seen.push(String(ctx?.orgId));
          await new Promise((r) => setTimeout(r, 30));
          return rowsFor(t, c);
        },
      },
    } as never);
    const ask = (org: string) => call(app as never, '/dead-events?topic=orders&consumer=billing',
      { headers: { 'x-gnl-org': org } });

    const [a, b] = await Promise.all([ask('acme'), ask('globex')]);

    // PRECONDITION: the two requests are genuinely two scans of two organizations' logs — same
    // (topic, consumer), different org, so they must NOT coalesce and both must reach the host.
    expect(seen.sort(), 'the two organizations shared one scan — the 429 below would be about coalescing')
      .toEqual(['acme', 'globex']);
    expect([a.status, b.status], 'one organization was told the other’s scan was its own').toEqual([200, 200]);
  });
});

/**
 * The queue in front of the single execution slot: how long a caller may be held, and how many may be
 * held at once.
 */
describe('the scan queue', () => {
  it('refuses with the SATURATION message once the wait budget is spent — never “your own scan”', async () => {
    // No auth: this caller has no admission entry at all, so a 429 can only have come from the queue.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { queueWaitMs: 20 },
      events: slowEvents(300),
    });

    const held = call(app, '/dead-events?topic=t1&consumer=c1');
    await tick();
    const refused = await call(app, '/dead-events?topic=t2&consumer=c2');

    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.code).toBe('dead_scan_busy');
    expect(body.error, 'an anonymous caller was told it had a scan of its own running').not.toMatch(/your own/);
    expect(body.error).toMatch(/saturated/);
    expect((await held).status).toBe(200);
  });

  /**
   * The DEPTH bound, which exists because admission no longer refuses an unidentifiable caller: with
   * nothing charged and nothing capped, one client could hold an arbitrary number of waiter objects.
   */
  it('stops enqueueing past `queueDepth`, and says so', async () => {
    const events = slowEvents(300);
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { queueDepth: 1, queueWaitMs: 5_000 },
      events,
    });

    const running = call(app, '/dead-events?topic=t1&consumer=c1');
    await tick();
    const waiting = call(app, '/dead-events?topic=t2&consumer=c2'); // fills the one queue slot
    await tick();
    const rejected = await call(app, '/dead-events?topic=t3&consumer=c3');

    expect(rejected.status, 'the queue grew past its stated depth').toBe(429);
    expect((await rejected.json()).error).toMatch(/1 requests are already waiting/);
    expect((await running).status).toBe(200);
    expect((await waiting).status, 'the waiter that WAS enqueued was refused too').toBe(200);
    expect(events.started(), 'the rejected request reached the host anyway').toBe(2);
  });
});

/**
 * `Retry-After`, which is the only thing a refused client has to act on.
 *
 * Three separate faults, three separate assertions: the number was global (a cross-tenant size
 * oracle), it was written on the timeout path (so a deadline was recorded as a measurement), and its
 * unmeasured value was a hard-coded `1` the code's own comment called "a decoration".
 */
describe('Retry-After', () => {
  const scanFor = (byOrg: Record<string, number>) => ({
    orgScoped: true,
    listDead: async (_t: string, _c: string, ctx?: { orgId?: string }) => {
      await new Promise((r) => setTimeout(r, byOrg[ctx?.orgId ?? ''] ?? 5));
      return [];
    },
  });

  it('falls back to the deployment’s QUEUE BUDGET before any scan has been timed', async () => {
    // Measured before: `1`, from `Math.max(1, 0)` — the same second whatever the deployment is, and
    // the value a compliant client obeys on the very first refusal it ever sees.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { queueWaitMs: 7_000 },
      events: slowEvents(40),
      auth: identityAuth(),
    });

    // Two held: the per-caller allowance is a cap of two, so the refusal is the third request.
    const held = asAlice(app, '/dead-events?topic=t1&consumer=c1');
    const held2 = asAlice(app, '/dead-events?topic=t1b&consumer=c1b');
    await tick();
    const refused = await asAlice(app, '/dead-events?topic=t2&consumer=c2');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after'), 'the unmeasured Retry-After is still a decoration').toBe('7');
    await Promise.all([held, held2]);
  });

  it('does NOT count a timed-out scan as a measurement of what a scan costs', async () => {
    // `recordDeadScan` used to sit in a `finally`, so the deadline itself was recorded. Measured: one
    // 4 s timeout and the next refused caller was told `Retry-After: 5`, on a deployment whose real
    // scans took 10 ms.
    let n = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { timeoutMs: 1_100, queueWaitMs: 7_000 },
      events: {
        listDead: async () => {
          if (++n === 1) await new Promise(() => {}); // never settles: the deadline fires
          await new Promise((r) => setTimeout(r, 40));
          return [];
        },
      },
      auth: identityAuth(),
    });

    expect((await asAlice(app, '/dead-events?topic=t1&consumer=c1')).status, 'the deadline never fired').toBe(504);

    const held = asAlice(app, '/dead-events?topic=t2&consumer=c2');
    const held2 = asAlice(app, '/dead-events?topic=t2b&consumer=c2b');
    await tick();
    const refused = await asAlice(app, '/dead-events?topic=t3&consumer=c3');

    expect(refused.status).toBe(429);
    // 7 = the queue budget, i.e. STILL nothing measured. A `2` here is the 1 100 ms deadline being
    // quoted back as though a scan had taken that long.
    expect(refused.headers.get('retry-after'), 'a deadline was recorded as a scan time').toBe('7');
    await held;
  });

  it('is PER ORGANIZATION — one tenant’s log size is not reported to another', async () => {
    // The value is "how long a whole-topic-log read takes here", which is proportional to the log's
    // length. A single global number therefore answers "how much traffic does the other tenant have"
    // to anyone who can provoke a 429. Measured, with acme scanning for 2 500 ms: globex, which had
    // never scanned anything, was refused with `Retry-After: 3`.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { queueWaitMs: 7_000 },
      events: scanFor({ acme: 1_500, globex: 30 }),
      auth: identityAuth(),
    });
    const acme = (p: string) => as(app, 'acme/alice', p);
    const globex = (p: string) => as(app, 'globex/bob', p);

    // PRECONDITION: each organization actually completes one scan, so each has a number of its own.
    expect((await acme('/dead-events?topic=t1&consumer=c1')).status).toBe(200);
    expect((await globex('/dead-events?topic=t2&consumer=c2')).status).toBe(200);

    const gHeld = [globex('/dead-events?topic=t3&consumer=c3'), globex('/dead-events?topic=t3b&consumer=c3b')];
    await tick();
    const gRefused = await globex('/dead-events?topic=t4&consumer=c4');
    await Promise.all(gHeld);

    const aHeld = [acme('/dead-events?topic=t5&consumer=c5'), acme('/dead-events?topic=t5b&consumer=c5b')];
    await tick();
    const aRefused = await acme('/dead-events?topic=t6&consumer=c6');
    await aHeld;

    // globex's own scans take 30 ms → 1 s. acme's take 1 500 ms → 2 s. A single global EWMA makes
    // both of them 2, which is how globex learns the size of acme's dead-letter log.
    expect(
      [gRefused.headers.get('retry-after'), aRefused.headers.get('retry-after')],
      'one organization’s scan time was reported to another',
    ).toEqual(['1', '2']);
    // And neither is the 7 s fallback, so these are real measurements rather than "no data" twice.
    expect([gRefused.status, aRefused.status]).toEqual([429, 429]);
  });
});

/**
 * The deadline, and what it costs when the host ignores `ctx.signal`.
 *
 * The deadline stops Studio WAITING; it cannot stop the host reading. So the concurrency-one promise
 * holds only for scans Studio is still watching, and a caller in a loop turns each 504 into another
 * live whole-log read. MEASURED against a host that ignores the signal, one caller, eight sequential
 * requests at a 20 ms deadline: `504×8` and `maxConcurrentHostScans = 8` — against a store that was
 * already not answering.
 */
describe('the scan deadline', () => {
  /** Never settles, and does not look at `ctx.signal` — the shape the measurement above used. */
  const wedged = () => {
    let started = 0;
    return {
      started: () => started,
      listDead: async () => { started++; await new Promise(() => {}); return []; },
    } as StudioEvents & { started: () => number };
  };

  it('answers 504 — not 500 — and releases the slot', async () => {
    const events = wedged();
    const app = createStudioApi({ reader: new InMemoryJournal(), deadEventScan: { timeoutMs: 20 }, events });

    const res = await call(app, '/dead-events?topic=t1&consumer=c1');
    expect(res.status, 'a store that does not answer was reported as a Studio failure').toBe(504);
    const body = await res.json();
    expect(body.code).toBe('dead_scan_timeout');
    expect(body.error).toMatch(/not answering/);
    // The slot really is free: a second request reaches the host rather than queueing behind a scan
    // nobody is waiting for any more.
    await call(app, '/dead-events?topic=t2&consumer=c2');
    expect(events.started()).toBe(2);
  });

  it('stops starting new scans once `maxAbandonedScans` are outstanding', async () => {
    const events = wedged();
    const app = createStudioApi({ reader: new InMemoryJournal(), deadEventScan: { timeoutMs: 20 }, events });

    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await call(app, `/dead-events?topic=t${i}&consumer=c`)).status);

    expect(codes, 'the endpoint kept answering 504 and kept opening reads').toEqual([504, 504, 503, 503, 503, 503, 503, 503]);
    expect(events.started(), 'eight requests bought eight concurrent whole-log reads on a wedged store').toBe(2);
    const last = await call(app, '/dead-events?topic=z&consumer=c');
    expect((await last.json()).code, 'the refusal is indistinguishable from an ordinary busy signal').toBe('dead_scan_store_wedged');
  });

  it('reopens by itself once the abandoned scans settle — it is a brake, not a latch', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    let started = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { timeoutMs: 20 },
      events: { listDead: async () => { started++; await gate; return []; } },
    });

    expect((await call(app, '/dead-events?topic=t1&consumer=c1')).status).toBe(504);
    expect((await call(app, '/dead-events?topic=t2&consumer=c2')).status).toBe(504);
    expect((await call(app, '/dead-events?topic=t3&consumer=c3')).status, 'the cap never engaged').toBe(503);

    unblock();
    await tick();
    expect((await call(app, '/dead-events?topic=t4&consumer=c4')).status,
      'a store that recovered was locked out for the life of the process').toBe(200);
    expect(started).toBe(3);
  });

  it('a host that HONOURS the signal is never counted as abandoned', async () => {
    // The counter tracks reads that are still running, not timeouts that have happened. A cooperative
    // host settles the moment `ctx.signal` fires, so it can time out all day without ever tripping
    // the cap — which is the difference the AbortController is there to make.
    let started = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      deadEventScan: { timeoutMs: 20 },
      events: {
        listDead: (_t, _c, ctx) => new Promise((_res, rej) => {
          started++;
          ctx?.signal?.addEventListener('abort', () => rej(new Error('aborted by Studio')));
        }),
      },
    });

    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(app, `/dead-events?topic=t${i}&consumer=c`)).status);
    expect(codes, 'a cooperative host was penalised as though it had ignored the abort').toEqual([504, 504, 504, 504, 504]);
    expect(started).toBe(5);
  });
});

/**
 * What leaves this process is decided by an ALLOWLIST, on every route in this group.
 *
 * `StudioEvents` and `StudioEventTopic` are HOST duck-types: whatever the host's methods return is
 * what would be serialised. The list route was fixed for this and the inventory beside it was not —
 * measured, a host returning `{topic, consumers, sampleFailure: "ssn '123-45-6789'", dbDsn: …}` handed
 * all four fields to a `catalog:read`-only caller.
 */
describe('host records are projected, not forwarded', () => {
  const catalogOnly = () => ({
    authenticate: () => ({ id: 'support', roles: ['viewer'], permissions: ['catalog:read'] }),
    authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string }) =>
      ((p?.permissions ?? []).includes(ctx.permission ?? '') ? { allow: true } : { allow: false as const, status: 403 as const, reason: 'no' }),
    capabilities: () => ({ rbac: true }),
  }) as never;

  it('/dead-events/topics copies the inventory’s two fields and nothing else', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: catalogOnly(),
      events: {
        topics: () => [{
          topic: 'orders.created', consumers: ['billing'],
          sampleFailure: "ssn '123-45-6789'", dbDsn: 'postgres://u:pw@postgres/db',
        }],
        listDead: () => [],
      } as never,
    });

    const res = await call(app, '/dead-events/topics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, 'a field the host invented reached a caller that may not read customer data').not.toContain('123-45-6789');
    expect(text).not.toContain('postgres://');
    expect(JSON.parse(text)).toEqual([{ topic: 'orders.created', consumers: ['billing'] }]);
  });

  it('/dead-events copies DEAD_EVENT_FIELDS and nothing else, whatever the host attaches', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: catalogOnly(),
      events: {
        listDead: () => [{
          id: 'e1', topic: 'orders.created', consumer: 'billing', status: 'quarantined', attempts: 2, at: 1,
          // Everything below is the host's own, and none of it is this server's schema.
          lastErrorDetail: "ssn '123-45-6789'", rawRow: { email: 'jane@customer.example' }, dbDsn: 'postgres://u:pw@postgres/db',
        }] as never,
      } as never,
    });

    const rows = await (await call(app, '/dead-events?topic=orders.created&consumer=billing')).json();
    expect(Object.keys(rows[0]).sort(), 'an unknown host field was treated as a known-safe one')
      .toEqual(['at', 'attempts', 'consumer', 'id', 'status', 'topic']);
  });

  it('survives a host record that is not an object at all', async () => {
    // `pickFields` already tolerated it; the two lines after it did not, and a `listDead` returning
    // `[null, 42]` answered 500 (measured). Not a denial of service — the slot is released either way
    // — which is exactly why the inconsistency was worth removing rather than arguing about.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: { listDead: () => [null, 42, { id: 'e1', topic: 't', consumer: 'c', status: 'quarantined', attempts: 1, at: 1 }] as never },
    });

    const res = await call(app, '/dead-events?topic=t&consumer=c&payload=1');
    expect(res.status, 'a malformed host row was reported as a Studio bug').toBe(200);
    expect(await res.json()).toEqual([{}, {}, { id: 'e1', topic: 't', consumer: 'c', status: 'quarantined', attempts: 1, at: 1 }]);
  });
});

/**
 * The allowlist names a field AND the shape its declared type gives it.
 *
 * Naming alone was measured to be half a boundary. The projection fixed above moved `dbDsn` out of a
 * host's topic row; putting the SAME data one level in walked back through, because an allowlisted
 * key's VALUE was copied whatever it was — object, array, getter, `toJSON`. `StudioDeadEvent` and
 * `StudioJob` are scalars end to end and `StudioEventTopic.consumers` is `string[]`, so anything else
 * is a host contradicting the type it declares, and the server drops it rather than guessing.
 */
describe('the projection allowlist is a shape, not just a name', () => {
  const SSN = '123-45-6789';
  const DSN = 'postgres://u:pw@postgres/db';

  it('a nested object under an allowlisted TOPIC field does not ride out on it', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: {
        topics: () => [{
          topic: 'orders.created',
          // `consumers: [{name, …}]` is a plausible host shape — and one level below where the
          // sibling-field leak was closed.
          consumers: [{ name: 'billing', dbDsn: DSN, lastFailure: `ValidationError: ssn '${SSN}'` }],
        }] as never,
        listDead: () => [],
      },
    });

    const res = await call(app, '/dead-events/topics');
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body, 'an SSN in a nested consumer record reached the wire').not.toContain(SSN);
    expect(body, 'a database DSN in a nested consumer record reached the wire').not.toContain(DSN);
    // Dropped, not coerced: there is no safe reading of `{name, dbDsn}` as a consumer name.
    expect(await (await call(app, '/dead-events/topics')).json()).toEqual([{ topic: 'orders.created' }]);
  });

  it('a structured value under an allowlisted DEAD-EVENT field does not ride out on it', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: {
        listDead: () => [{
          id: 'e1', topic: 't', consumer: 'c', at: 1,
          status: { code: 'quarantined', lastError: `ValidationError: ssn '${SSN}'` },
          attempts: { n: 8, workerHost: 'worker-3.internal', dsn: DSN },
        }] as never,
      },
    });

    const res = await call(app, '/dead-events?topic=t&consumer=c');
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body, 'an SSN hidden inside `status` reached the wire').not.toContain(SSN);
    expect(body, 'an internal hostname hidden inside `attempts` reached the wire').not.toContain('worker-3.internal');
    expect(body, 'a database DSN hidden inside `attempts` reached the wire').not.toContain(DSN);
    expect(await (await call(app, '/dead-events?topic=t&consumer=c')).json())
      .toEqual([{ id: 'e1', topic: 't', consumer: 'c', at: 1 }]);
  });

  it("a `toJSON` on the field VALUE is not a second way in — the row's own is already skipped", async () => {
    const leaky = { name: 'billing', toJSON: () => ({ name: 'billing', dsn: DSN }) };
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: { topics: () => [{ topic: 'orders.created', consumers: [leaky] }] as never, listDead: () => [] },
    });

    const body = JSON.stringify(await (await call(app, '/dead-events/topics')).json());
    expect(body, 'a DSN produced by the field value’s own toJSON reached the wire').not.toContain(DSN);
  });

  it('a THROWING getter on an allowlisted field is not a 500 — the inventory keeps its readable rows', async () => {
    // `listDead` is already defended against a host row it cannot read (`[null, 42]` above). The
    // inventory beside it is the same duck-type and was not: a getter that threw answered 500
    // `Internal Server Error` with a stack pointing into `pickFields`. Not a denial of service (no
    // slot is held), which is why it is worth fixing rather than arguing about.
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events: {
        topics: () => [
          { get topic(): string { throw new Error('host getter blew up'); }, consumers: ['billing'] },
          { topic: 'orders.shipped', consumers: ['search'] },
        ] as never,
        listDead: () => [],
      },
    });

    const res = await call(app, '/dead-events/topics');
    expect(res.status, 'one unreadable host row was reported as a Studio failure').toBe(200);
    expect(await res.json(), 'the readable topics were lost with it').toEqual([{ topic: 'orders.shipped', consumers: ['search'] }]);
  });
});

/**
 * The abandoned-scan brake is checked at the door AND again once the slot is actually held.
 *
 * The door check alone is walked past by the queue: a request admitted while the counter is 0 can sit
 * in the FIFO until the scans ahead of it time out, and then open a fresh whole-log read against a
 * store already known to be wedged. Unreachable on the defaults (30 s deadline > 5 s queue wait), so
 * the two options have to be set against each other to see it — which nothing documents, and which is
 * the reason this is pinned rather than left to the reader.
 */
describe('the abandoned-scan brake is not bypassable by queueing', () => {
  it('requests already waiting for the slot do not each open a new read on a wedged store', async () => {
    let started = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      // deadline SHORTER than the queue wait: a waiter outlives the scans in front of it.
      deadEventScan: { timeoutMs: 40, queueWaitMs: 4_000, maxAbandonedScans: 2 },
      events: { listDead: async () => { started++; await new Promise(() => {}); return []; } },
    });

    // Fired together, so every one of them passes the DOOR check while the counter is still 0.
    const codes = (await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(app, `/dead-events?topic=t${i}&consumer=c`)),
    )).map((r) => r.status);

    expect(started, `${started} unwatched whole-log reads were opened against a store that never answers`)
      .toBeLessThanOrEqual(2);
    expect(codes.filter((s) => s === 503).length, 'nothing was refused by the brake').toBeGreaterThan(0);
    expect(codes.every((s) => s === 503 || s === 504), `unexpected statuses: ${codes.join(',')}`).toBe(true);
  });
});

/**
 * The per-organization `Retry-After` estimates are evicted LEAST-RECENTLY-USED, not first-seen.
 *
 * WHAT THIS IS NOT: it is not that a busy deployment can never lose a measurement. The map is bounded
 * at 256 by design, so an IDLE tenant that goes quiet while 256 others arrive is evicted under any
 * policy, and a test that flooded exactly 256 strangers past an idle victim would go red on a correct
 * LRU too — it measures the bound, not the order. (Written down because that is the test this file
 * had first, and it read as a failure of the fix.)
 *
 * WHAT IT IS: a plain `Map` keeps INSERTION order, and `set` on an existing key does not move it — so
 * touching a bucket did not protect it. A tenant actively scanning throughout the noise was still
 * evicted in arrival order, and answered from the fallback about its own scans. Re-inserting on touch
 * is what makes "recently used" mean anything.
 */
describe('the Retry-After estimate survives unrelated callers', () => {
  it('a bucket TOUCHED during the noise outlives the strangers that arrived before it', async () => {
    const gates = new Map<string, () => void>();
    const events = {
      // Org-bound identities reach this host, so it must claim its own organization boundary — the
      // same declaration every other org-scoped fixture in this file makes.
      orgScoped: true,
      listDead: async (topic: string) => {
        if (topic === 'held') await new Promise<void>((r) => gates.set('held', r));
        return [];
      },
    } as never;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      // The fallback a bucket with NO measurement gets: 9 s. A measured bucket here scans in ~0 ms and
      // is clamped up to 1 s — so the two answers are far apart and neither can be read as noise.
      deadEventScan: { queueWaitMs: 9_000 },
      events,
      auth: identityAuth() as never,
    });
    const as = (tok: string, path: string) => call(app, path, { headers: { authorization: `Bearer ${tok}` } });
    const scan = async (tok: string, topic: string) =>
      expect((await as(tok, `/dead-events?topic=${topic}&consumer=c`)).status).toBe(200);

    /** Provoke acme's OWN admission refusal, and report the advice it was given. */
    const adviceForAcme = async (n: number): Promise<string | null> => {
      const held = as('acme/alice', `/dead-events?topic=held&consumer=c${n}`);
      const held2 = as('acme/alice', `/dead-events?topic=held2&consumer=c${n}`);
      await tick();
      const refused = await as('acme/alice', `/dead-events?topic=other&consumer=c${n}`);
      expect(refused.status, 'the second request from one caller was not the admission refusal').toBe(429);
      const advice = refused.headers.get('retry-after');
      gates.get('held')?.();
      await Promise.all([held, held2]);
      return advice;
    };

    await scan('acme/alice', 'measured');
    expect(await adviceForAcme(0), 'PRECONDITION: acme is answered from its own measurement, not the fallback').toBe('1');

    // 200 strangers, then acme scans again — its bucket is now more recently used than all of them —
    // then 100 more, taking the map well past its 256 bound so eviction certainly runs.
    for (let i = 0; i < 200; i++) await scan(`org${i}/bob`, `t${i}`);
    await scan('acme/alice', 'measured-again');
    for (let i = 200; i < 300; i++) await scan(`org${i}/bob`, `t${i}`);

    expect(await adviceForAcme(1),
      'a bucket that was refreshed mid-flood was still evicted in arrival order').toBe('1');
  });
});

/**
 * An anonymous flood cannot take the whole scan queue away from an identified operator.
 *
 * FIFO drop-tail is fair only between callers that cost the same. Admission bounds an IDENTIFIED
 * caller to one scan and therefore one waiter, but an unidentified one has no such bound — so with a
 * single shared queue budget one source holding `queueDepth` connections open refused everybody else
 * at the door. Measured before this split, `queueDepth` 64: the operator went from 10/10 at k=2 to
 * 0/20 at k=65. The unnameable pool now gets half the depth and the rest is reserved.
 */
describe('the scan queue reserves capacity for callers it can name', () => {
  it('an identified operator still reaches the queue while anonymous callers hold every slot', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    let served = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      // depth 4 → anonymous callers may hold 2. Small so the test states the rule rather than
      // reproducing the original 65-connection burst.
      deadEventScan: { queueDepth: 4, queueWaitMs: 5_000 },
      events: { listDead: async () => { served++; await gate; return []; } },
      // `authenticate` returns a principal for a bearer token and null otherwise — so the same app
      // serves both an identified operator and anonymous callers, which is the deployment shape the
      // starvation was measured in.
      // Authenticates EVERY request, but only names the one carrying a token: that is the difference
      // the reservation keys on, and both shapes have to reach the queue for the test to mean anything.
      auth: {
        authenticate: (req: Request) => {
          const tok = req.headers.get('authorization')?.replace('Bearer ', '');
          const base = { roles: ['admin'], permissions: ['*:read', '*:write'] };
          return tok ? { ...base, id: tok } : base;
        },
        authorize: () => ({ allow: true }),
        capabilities: () => ({ rbac: true }),
      } as never,
    });

    // One anonymous scan takes the slot; the rest pile into the queue.
    const running = call(app, '/dead-events?topic=t0&consumer=c');
    await tick();
    const flood = Array.from({ length: 6 }, (_, i) => call(app, `/dead-events?topic=f${i}&consumer=c`));
    await tick();

    // The operator arrives with the anonymous pool already over its half of the depth.
    const operator = call(app, '/dead-events?topic=op&consumer=c', { headers: { authorization: 'Bearer alice' } });
    await tick();

    unblock();
    const res = await operator;
    expect(res.status, 'an identified operator was refused for an anonymous flood’s queue slots').toBe(200);
    await Promise.all([running, ...flood]);
    // The flood was bounded at EXACTLY the anonymous budget, not merely "somewhat". `queueDepth: 4`
    // gives the unnameable pool `4 >> 1` = 2 waiter slots, so of six flood requests two queue and four
    // are refused at the door. Asserted as a count rather than "at least one 429", which is what this
    // line said first: a cap that had degraded to bouncing one request in six would have satisfied it.
    const floodCodes = await Promise.all(flood.map(async (p) => (await p).status));
    const refused = floodCodes.filter((s) => s === 429).length;
    expect(refused, `the anonymous pool was not capped at 2 waiters: ${floodCodes.join(',')}`).toBe(4);
    expect(floodCodes.filter((s) => s === 200).length, `served count: ${floodCodes.join(',')}`).toBe(2);
  });
});

/**
 * The real `roleAuth`, end to end — the chain the admission budget actually runs on in a scaffolded
 * deployment, and the one no test in this file covered.
 *
 * `gnl add host` writes ONE bearer token, and `GNL_ADMIN_TOKEN` is one. Every operator behind it is
 * the same principal, so the allowance is shared — that part is unavoidable and honest. What was NOT
 * honest was the mechanism: a single-owner lock meant the first arrival held the whole allowance and
 * everyone else behind the token was refused on sight. Measured, one shared token and one SEQUENTIAL
 * attacker connection: operator served 0 of 20, against 20 of 20 on the same deployment with no
 * identity at all. Naming the caller was worse than not naming it.
 */
describe('a shared bearer token does not let one holder lock out the others', () => {
  it('a second operator behind the SAME roleAuth token is queued, not refused', async () => {
    const events = slowEvents(20);
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      events,
      auth: roleAuth({ admin: { token: 'shared-admin-token' } }),
    });
    const asShared = (p: string) =>
      call(app, p, { headers: { authorization: 'Bearer shared-admin-token' } });

    // PRECONDITION: this really is one principal — `roleAuth` fills `credentialId` from the token, so
    // both requests hash to the same admission key. (If it did not, the test would pass vacuously.)
    const me = await (await asShared('/me')).json();
    expect(me.roles, 'PRECONDITION: the token authenticated at all').toEqual(['admin']);

    const held = asShared('/dead-events?topic=t1&consumer=c1');
    await tick();
    const second = await asShared('/dead-events?topic=t2&consumer=c2');

    expect(second.status, 'a colleague on the same token was refused for a scan it never started').toBe(200);
    expect((await held).status).toBe(200);
    expect(events.peak(), 'the two scans ran at once — concurrency is no longer one').toBe(1);
  });
});
