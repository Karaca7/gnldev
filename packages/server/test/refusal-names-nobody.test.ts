// A refusal may say what the CALLER sent. It may not say who the other party is.
//
// The edge gates already hold that line and say so: `ownershipDenied`'s own comment — "The message
// names neither the real owner nor whether the run exists — a caller guessing ids would otherwise
// learn both from the refusal." But the typed conflicts that come back from the ENGINE carry a
// `detail` object, and four of the eight name a party the caller is not:
//
//   RunActorMismatchError   { runId, ownerActor, requestedActor }
//   RunOwnerMismatchError   { runId, owner, requested }
//   ThreadOwnerMismatchError{ threadId, owner, requested }
//   RunThreadMismatchError  { runId, startedForThread, requestedThread }
//
// `callerConflictResponse` serialised `detail` verbatim, so being refused told you the victim's name.
// Measured on 0.6.0: an application credential naming `u-mallory`, re-driving `u-ayse`'s runId,
// answered 409 with `"ownerActor":"u-ayse"` in the body. The guess-an-id oracle the edge gates were
// written to close, reopened one layer down.
//
// The redaction lives in @gnldev/durable beside `CALLER_CONFLICT_CODES`, not here, for the reason
// that map is already there: callerConflictResponse's own comment records THREE consumers (server,
// chat-adapter, agui) and that "a literal copy per consumer is exactly the drift that left one route
// unmapped". A redaction list copied per consumer would drift the same way.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const VICTIM = 'u-ayse';

/** A thread with a recorded owner — the gate has nothing to compare against without one. */
function memoryWithOwners() {
  const owners = new Map<string, string>([['t-ayse', VICTIM]]);
  return () => ({
    loadContext: async () => ({ messages: [] as unknown[] }),
    append: async () => {},
    getMessages: async () => [],
    getThreadResource: async (t: string) => owners.get(t),
    listThreads: async () => [],
  });
}

const makeWf = () => workflow<string>().then(step('s1', async () => 'ok'));

/**
 * `/workflows/:name/run` is the route that reaches the ENGINE's thread gate rather than the edge's.
 * Measured: the two agent routes call `threadOwnershipDenied` (index.ts:1301, :1637) and answer a
 * 403 that names nothing; this one does not call it at all, so the refusal comes back from
 * `registry.ts` as a typed 409 — and that error's `detail` carries the owner.
 */
function api() {
  const app = createRestApi(
    { journal: new InMemoryJournal(), memoryFactory: memoryWithOwners() as never, workflows: { w: makeWf() } } as never,
    { auth: roleAuth({ client: { token: 'C', orgId: 'acme' } }) },
  );
  return (body: unknown) => app(new Request('http://x/workflows/w/run', {
    method: 'POST',
    headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('a refusal names nobody', () => {
  it('the thread-owner refusal does not carry the owner\'s name', async () => {
    const res = await api()({ runId: 'r1', input: 'x', threadId: 't-ayse', resourceId: 'u-mallory' });
    const text = await res.text();

    expect(res.status, 'the refusal must still happen').toBe(409);
    expect(text, 'being refused told the caller whose thread it is — the id-guessing oracle, reopened')
      .not.toContain(VICTIM);
  });

  it('the refusal still says WHAT went wrong and what the caller sent', async () => {
    // The control: redaction must not turn a typed, actionable refusal back into a bare sentence.
    const body = await (await api()({ runId: 'r2', input: 'x', threadId: 't-ayse', resourceId: 'u-mallory' })).json() as Record<string, unknown>;
    expect(body.code, 'the machine-readable code is what a consumer branches on').toBe('thread_owner_mismatch');
    const detail = JSON.stringify(body.detail ?? {});
    expect(detail, 'the caller\'s OWN name is not a disclosure — it is what it sent').toContain('u-mallory');
    expect(detail, 'and the thread it named is its own input too').toContain('t-ayse');
  });
});
