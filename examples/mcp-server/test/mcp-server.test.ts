// The example, asserted instead of printed.
//
// Same reasoning as examples/incident-proofs: `pnpm demo` prints a table for a human and `pnpm typecheck`
// proves it compiles, and neither would notice if a claim in the README stopped being true. These call the
// SAME functions the demo calls, so the printed table and the assertions cannot disagree.
//
// Assertions are on the NUMBERS rather than on a boolean, so a failure says which one moved. Two of them
// also check the UNPROTECTED direction — a comparison whose baseline never reproduces the problem proves
// nothing about the fix.
import { describe, it, expect, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../src/server.js';
import {
  anonymousIsStopped,
  listIsFiltered,
  forbiddenLooksMissing,
  otherTenantIsRefused,
  concurrentRefundChargesOnce,
  retryCollectsTheResult,
  deletionRequestFindsTheRuns,
  sessionsDoNotLeak,
} from '../src/scenarios.js';

let server: RunningServer | undefined;
const boot = async () => (server ??= await startServer());
afterAll(async () => {
  await server?.close();
});

describe('a multi-tenant MCP server over real HTTP', () => {
  it('① an unauthenticated request is refused before any MCP handler runs', async () => {
    const r = await anonymousIsStopped(await boot());
    expect(r.outcome).toBe('HTTP 401');
    expect(r.detail).toContain('Bearer');
  }, 60_000);

  it('③ two tokens with different scopes are shown different tool lists', async () => {
    const r = await listIsFiltered(await boot());
    expect(r.full, 'the full-scope token sees both').toEqual(['read_invoice', 'refund']);
    expect(r.reduced, 'the reporting integration may only read').toEqual(['read_invoice']);
  }, 60_000);

  it('③ a forbidden tool is indistinguishable from one that does not exist', async () => {
    // Filtering the list is a claim that the caller does not see these tools. A call door that confirms
    // them turns an empty list into an enumeration oracle.
    const r = await forbiddenLooksMissing(await boot());
    expect(r.same, 'an empty list must not be contradicted by the call door').toBe(true);
    expect(r.detail).toContain('no such tool');
  }, 60_000);

  it('④ one tenant cannot read another’s invoice — and the tool is what refuses', async () => {
    const r = await otherTenantIsRefused(await boot());
    expect(r.outcome).toBe('refused by the tool');
    // The baseline half: its OWN invoice must actually come back, or the refusal above proves nothing.
    expect(JSON.stringify(r.own), 'the caller must still be able to read its own').toContain('TR44');
    expect(JSON.stringify(r.theirs)).not.toContain('TR33');
  }, 60_000);

  it('five simultaneous refunds of one invoice produce ONE side effect', async () => {
    const r = await concurrentRefundChargesOnce(await boot());
    expect(r.effects, 'at-most-once under concurrency').toBe(1);
    expect(r.succeeded, 'exactly one caller gets the result').toBe(1);
    expect(r.retryable, 'the other four are told to retry, by code').toBe(4);
    expect(r.thrown, 'nothing may escape as a transport-level exception').toBe(0);
  }, 60_000);

  it('and retrying the same key collects that result without running again', async () => {
    // Asserting the ADVICE, not just the message. A retryable error that is not actually retryable is
    // worse than a plain failure.
    const r = await retryCollectsTheResult(await boot());
    expect(r.extraEffects, 'the retry must not be a second refund').toBe(0);
    expect(r.refunded, 'and it must return the first call’s result').toBe(true);
  }, 60_000);

  it('sessions are dropped — and a close hook alone is not enough', async () => {
    // The SDK's own examples keep a Map of transports by session id, and the obvious fix is
    // `onsessionclosed`. It is necessary and NOT sufficient: measured against this server,
    // `client.close()` left the session in place (1 → 1) and only `terminateSession()` dropped it
    // (2 → 1). A client that crashes or loses the network sends neither, so the idle sweep is what
    // actually bounds the map. Both paths are asserted.
    const r = await sessionsDoNotLeak(await boot());
    expect(r.afterOpen, 'six clients, six sessions of this row\u2019s own').toBe(6);
    expect(r.afterOrderly, 'the three that sent DELETE are gone immediately').toBe(3);
    expect(r.afterIdleSweep, 'and after the idle window nothing is left at all').toBe(0);
  }, 60_000);

  it('a deletion request finds the runs, and leaves the other tenant alone', async () => {
    // The scenario gives the other tenant a run of its own, so the last assertion is about a non-empty
    // set. Without that, "untouched" would pass against a journal where globex never appeared.
    const r = await deletionRequestFindsTheRuns(await boot());
    expect(r.owned, 'the journal must know whose runs these are').toBeGreaterThan(0);
    expect(r.deleted, 'a deletion request that deletes nothing is the defect').toBeGreaterThan(0);
    expect(r.leftForSubject, 'and nothing of theirs may survive').toBe(0);
    expect(r.otherTenantRuns, 'while the other tenant is untouched').toBeGreaterThan(0);
  }, 60_000);
});
