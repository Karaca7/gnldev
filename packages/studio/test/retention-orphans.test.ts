// GET /retention/orphans — the read-only half of the orphan report.
//
// The happy path is already covered by the cross-org conformance suite (acme sees its own orphan,
// globex does not). What that suite cannot reach is the two failure branches, and they are the ones
// that decide whether this endpoint can be trusted as a diagnostic:
//
//   501  the journal has no listKeys → the question cannot be asked at all
//   500  the scan threw → the question was asked and did not come back
//
// Both exist because the alternative is the defect this whole field was added to remove: answering
// `count: 0` to a question that was never answered. "There is none" and "I could not look" must not
// arrive in the same shape, or the number is worse than no number — it reads as reassurance.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

/** A reader with no listKeys at all — a bare custom Journal, which the port allows. */
function readerWithoutListKeys() {
  const j = new InMemoryJournal() as unknown as Record<string, unknown>;
  return new Proxy(j, {
    get(t, k) {
      if (k === 'listKeys') return undefined;
      return Reflect.get(t, k);
    },
    has(t, k) { return k === 'listKeys' ? false : Reflect.has(t, k); },
  }) as never;
}

/** A reader whose listKeys works for everything EXCEPT the scan this endpoint needs. */
function readerThatThrowsOnScan() {
  const j = new InMemoryJournal() as unknown as Record<string, unknown> & { listKeys(p: string): Promise<string[]> };
  return new Proxy(j, {
    get(t, k) {
      if (k !== 'listKeys') return Reflect.get(t, k);
      return async (prefix: string) => {
        if (prefix.startsWith('mem:') || prefix.startsWith('xthr:')) throw new Error('connection reset');
        return (t as { listKeys(p: string): Promise<string[]> }).listKeys(prefix);
      };
    },
  }) as never;
}

describe('GET /retention/orphans — the branches the happy path cannot reach', () => {
  it('answers with a count when the scan succeeds', async () => {
    const journal = new InMemoryJournal();
    await journal.put('xthr:th-orphan:sem-pay-h1', { v: 1, canonical: 'pay: x' });
    const api = createStudioApi({ reader: journal });
    const res = await call(api, '/retention/orphans');
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; threadIds: string[]; unrecognisedKeys: string[] };
    expect(body).toEqual({ count: 1, threadIds: ['th-orphan'], unrecognisedKeys: [] });
  });

  it('501 when the journal cannot list keys — not a zero count', async () => {
    const api = createStudioApi({ reader: readerWithoutListKeys() });
    const res = await call(api, '/retention/orphans');
    expect(res.status).toBe(501);
    const body = await res.json() as { error?: string; count?: number };
    expect(body.error).toMatch(/listKeys/);
    // The assertion that carries the point: no count field at all. A `0` here would be indistinguishable
    // from a clean deployment, on a journal that is structurally unable to answer.
    expect(body.count).toBeUndefined();
  });

  it('500 when the scan throws — not a zero count', async () => {
    const api = createStudioApi({ reader: readerThatThrowsOnScan() });
    const res = await call(api, '/retention/orphans');
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string; count?: number };
    expect(body.error).toMatch(/could not scan/);
    expect(body.count, 'a failed scan reported itself as "no orphans"').toBeUndefined();
  });

  it('reports unrecognised keys separately from the orphan count', async () => {
    // Two different unknowns, and summing them would make both unactionable: one is state whose
    // owner is gone, the other is state written under a family this build cannot parse.
    const journal = new InMemoryJournal();
    await journal.put('xthr:th-orphan:sem-pay-h1', { v: 1 });
    await journal.put('xthr:th-future:newfam-pay-h2', { v: 1 });
    const api = createStudioApi({ reader: journal });
    const body = await (await call(api, '/retention/orphans')).json() as
      { count: number; threadIds: string[]; unrecognisedKeys: string[] };
    expect(body.count).toBe(1);
    expect(body.threadIds).toEqual(['th-orphan']);
    expect(body.unrecognisedKeys).toEqual(['xthr:th-future:newfam-pay-h2']);
  });
});
