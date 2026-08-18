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

  it('re-wrapping replaces it, so a copy never carries a stale org', () => {
    const acme = withOrg(new InMemoryJournal(), 'acme');
    const globex = withOrg({ ...acme } as never, 'globex');
    expect(orgScopeOf(globex)).toBe('globex');
  });

  it('still does not leak into any data shape', () => {
    const scoped = withOrg(new InMemoryJournal(), 'acme');
    expect(Object.keys(scoped)).not.toContain('orgScope');
    expect(JSON.stringify(scoped)).not.toContain('acme');
    const forIn: string[] = [];
    for (const k in scoped) forIn.push(k);
    expect(forIn.join(',')).not.toContain('acme');
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
