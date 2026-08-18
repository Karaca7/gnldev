// An org-scoped journal must still report its org after someone wraps it.
//
// The org marker is a symbol on the journal object. It was non-enumerable, so the most obvious way to
// wrap a journal —
//
//   const logged = { ...journal, put: (k, v) => { console.log(k); return journal.put(k, v); } };
//
// — produced a journal that still WROTE to the org's prefixed keys (the closures carry the prefix) but
// no longer ANSWERED which org it belonged to. durable-tool reads that answer to build the idempotency
// key it hands the provider, so the key lost its `org:<id>:` part while everything else kept working.
// Two isolated organizations charging the same orderId then present the SAME key to Stripe: the second
// charge is deduped against the first, org B is told it succeeded, org A paid, and both journals record
// success. Money-shaped and silent — exactly the failure the marker exists to prevent.
//
// Symbols are invisible to JSON.stringify, Object.keys and for-in regardless of enumerability, so the
// only thing enumerability changed was the spread. These tests pin both halves: it survives wrapping,
// and it still does not leak into any data shape.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { withOrg, orgScopeOf } from '../src/organization.js';
import { runDurable } from '../src/run.js';
import { gnlTool } from '../src/types.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('the org marker under wrapping', () => {
  it('survives a spread — the ordinary way to add behaviour to a journal', () => {
    const scoped = withOrg(new InMemoryJournal(), 'acme');
    expect(orgScopeOf(scoped)).toBe('acme');

    const wrapped = { ...scoped };
    expect(orgScopeOf(wrapped), 'a spread copy forgot which org it belongs to').toBe('acme');

    const logged = { ...scoped, put: (k: string, v: unknown) => scoped.put(k, v) };
    expect(orgScopeOf(logged)).toBe('acme');
  });

  it('REFUSES to scope an already-scoped journal', async () => {
    // The first version of this test wrote exactly this and asserted only that the label had changed —
    // blessing a pattern that breaks the isolation contract. Measured with the nesting allowed:
    //
    //   withOrg({ ...withOrg(base, 'acme') }, 'globex').put('secret', …)
    //   → the real key is `org:acme:org:globex:secret`
    //   → acme.listKeys('')     sees it
    //   → acme.get(…)           reads it
    //   → acme.deletePrefix('') deletes it
    //
    // The marker said 'globex' the whole time, which is why asserting on the label proved nothing.
    const acme = withOrg(new InMemoryJournal(), 'acme');
    expect(() => withOrg({ ...acme } as never, 'globex')).toThrow(/already scoped to organization 'acme'/);
    // Scoping the ROOT journal again is the correct move and stays allowed.
    const base = new InMemoryJournal();
    expect(orgScopeOf(withOrg(base, 'globex'))).toBe('globex');
  });

  it('nesting cannot be reached, so one organization cannot host another\'s data', async () => {
    // The consequence, asserted at the storage layer rather than through the marker.
    const base = new InMemoryJournal();
    const acme = withOrg(base, 'acme');
    await acme.put('secret', { v: 1 });
    const globex = withOrg(base, 'globex');
    await globex.put('secret', { v: 2 });

    expect((await base.listKeys('')).sort()).toEqual(['org:acme:secret', 'org:globex:secret']);
    expect(await acme.listKeys(''), 'acme can see a key that is not its own').toEqual(['secret']);
    expect(await acme.get('org:globex:secret')).toBeUndefined();
  });

  it('does not end up inside a STORED record', async () => {
    // The earlier version of this asserted that the marker is absent from Object.keys, JSON.stringify
    // and for-in. Those hold for a symbol whatever its enumerability — this file's own header says so —
    // so it was an assertion that could not fail in either implementation, dressed as a check on the
    // change. What was actually worth pinning is the thing the old comment feared: the marker reaching
    // persisted DATA. That is measured here, against what the store really holds.
    const base = new InMemoryJournal();
    const scoped = withOrg(base, 'acme');
    await scoped.put('rec', { note: 'hello' });

    const raw = await base.get('org:acme:rec');
    expect(JSON.stringify(raw), 'the org marker reached a stored record').not.toContain('acme');
    expect(Object.getOwnPropertySymbols(raw as object)).toEqual([]);
    // And the wrapper itself still keeps it off the enumerable string keys a serialiser would walk.
    expect(Object.keys(scoped)).not.toContain('orgScope');
  });

  it('the provider-facing idempotency key keeps its org through a wrapped journal', async () => {
    // The consequence, end to end: this is the value that reaches Stripe.
    const seen: string[] = [];
    const charge = gnlTool({
      description: 'charge',
      inputSchema: z.object({ orderId: z.string() }),
      idempotency: 'args',
      execute: async (_a: unknown, ctx: never) => {
        seen.push((ctx as { idempotencyKey?: string })?.idempotencyKey ?? '(none)');
        return { ok: true };
      },
    } as never);

    const model = () => createMockModel(async ({ prompt }: never) => {
      const done = countToolResults(prompt as never);
      return done === 0
        ? toolCallResult('charge', 'c1', { orderId: 'o-1' })
        : finalTextResult('done');
    });

    const scoped = withOrg(new InMemoryJournal(), 'acme');
    const wrapped = { ...scoped, put: (k: string, v: unknown) => scoped.put(k, v) } as never;
    await runDurable({ runId: 'r1', journal: wrapped, model: model(), tools: { charge }, prompt: 'go' } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0], 'the key handed to the provider lost its organization').toContain('org:acme:');
  });
});
