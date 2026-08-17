// The cross-run idempotency key leaves this process, so the org has to be in it.
//
// Organization isolation is implemented as a journal key prefix (withOrg), which is enough for
// STORAGE: two orgs keep separate records and neither can read the other's. But the key handed to the
// tool as `options.idempotencyKey` is forwarded to the PROVIDER — examples/stripe-idempotency
// instructs passing that exact string to Stripe — and in the 'cross-run' window it was
// `toolName:hash`, with nothing org-specific in it.
//
// So two isolated orgs charging the same orderId produced the same Stripe idempotency key. The second
// charge is deduped against the first: org B is told it succeeded, org A's money moved, and both
// journals record success. Nothing throws, nothing logs, and the two tenants are separate customers
// whose orderIds have no reason to be globally unique.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withOrg, orgScopeOf } from '../src/organization.js';
import { runDurable } from '../src/run.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

/** A tool that records the provider key it was handed, instead of charging anything. */
function keyCapturingTool() {
  const seen: string[] = [];
  const tools = {
    charge: {
      idempotency: 'args' as const,
      idempotencyWindow: 'cross-run' as const,
      execute: async (_args: unknown, options?: { idempotencyKey?: string }) => {
        seen.push(options?.idempotencyKey ?? '<none>');
        return { ok: true };
      },
    },
  };
  return { tools, seen };
}

const model = () => {
  let call = 0;
  return createMockModel(async () => {
    call++;
    if (call === 1) return toolCallResult('charge', 'c-1', { orderId: 'ORD-1' });
    return finalTextResult('done');
  });
};

describe('cross-run idempotency key under organization scope', () => {
  it('two orgs charging the same orderId get DIFFERENT provider keys', async () => {
    const base = new InMemoryJournal();
    const { tools, seen } = keyCapturingTool();

    for (const org of ['acme', 'globex']) {
      await runDurable({
        runId: 'bill', journal: withOrg(base, org), model: model(), tools, prompt: 'charge ORD-1',
      } as never);
    }

    expect(seen.length, 'both orgs executed — isolation kept the records apart').toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toContain('acme');
    expect(seen[1]).toContain('globex');
    // Both still carry the cross-run part, so a retry WITHIN an org still dedups at the provider.
    for (const k of seen) expect(k).toContain('charge:');
  });

  it('within one org the key is stable across runs — that is what cross-run means', async () => {
    const base = new InMemoryJournal();
    const { tools, seen } = keyCapturingTool();
    const journal = withOrg(base, 'acme');

    await runDurable({ runId: 'bill-1', journal, model: model(), tools, prompt: 'charge ORD-1' } as never);
    // A different run, same arguments: cross-run dedup means the tool does NOT execute again, so the
    // journaled result is replayed and no second key is produced.
    await runDurable({ runId: 'bill-2', journal, model: model(), tools, prompt: 'charge ORD-1' } as never);

    expect(seen.length, 'the second run replayed instead of executing').toBe(1);
  });

  it('a single-tenant deployment\'s keys are unchanged — no org part at all', async () => {
    // Load-bearing for a different reason: a key format that shifts under an in-flight retry is
    // itself a double-charge. Someone with no org scope must see byte-identical keys.
    const { tools, seen } = keyCapturingTool();
    await runDurable({
      runId: 'bill', journal: new InMemoryJournal(), model: model(), tools, prompt: 'charge ORD-1',
    } as never);

    expect(seen).toEqual(['charge:' + seen[0]!.split('charge:')[1]]);
    expect(seen[0], 'no org prefix when no org is scoped').not.toContain('org:');
    expect(seen[0]!.startsWith('charge:'), 'exactly the historical format').toBe(true);
  });

  it('orgScopeOf reports the scope, and does not leak into the journal\'s data shape', () => {
    const base = new InMemoryJournal();
    const scoped = withOrg(base, 'acme');
    expect(orgScopeOf(scoped)).toBe('acme');
    expect(orgScopeOf(base), 'an unscoped journal has no scope').toBeUndefined();
    expect(orgScopeOf(undefined)).toBeUndefined();
    // A marker that showed up in a spread or a JSON round-trip would end up in stored records.
    expect(Object.keys({ ...scoped })).not.toContain('orgScope');
    expect(JSON.stringify(scoped)).not.toContain('acme');
  });
});
