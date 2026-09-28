// One MCP server, two organizations, the same end-user id in both.
//
// The work id was derived from `(tool, subject, workKey)` and written to ONE journal. Two organizations
// can each have a user called `u1`, and `inv-7` is an ordinary invoice number, so both derived the same
// id. Measured on 13f0fde2: acme/u1 charged 900; globex/u1 then asked to charge 1 and got acme's
// `{charged: 900}` back — its own charge never ran. One tenant read another's result and lost its own
// work, without an error. @gnldev/server never had this because it scopes each organization's journal
// (`withOrg`); this surface did not.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, purgeResource, withOrg } from '@gnldev/durable';
import { createMcpServer } from '../src/server.js';
import { byToken, subject } from './principals.js';

function server() {
  const journal = new InMemoryJournal();
  const effects: string[] = [];
  const s = createMcpServer({
    journal,
    identify: byToken({ A: subject('u1', 'acme'), B: subject('u1', 'globex'), N: subject('u1') }),
    workKey: (req) => String((req.arguments as { ref?: string } | undefined)?.ref),
    tools: {
      charge: {
        execute: async ({ amount }: { amount: number }) => {
          effects.push(String(amount));
          return { charged: amount };
        },
      },
    },
  });
  const call = (token: string, amount: number) =>
    s.callTool({ name: 'charge', arguments: { amount, ref: 'inv-7' }, caller: { authInfo: { token } } });
  return { journal, effects, call };
}

describe('MCP: an organization is a boundary', () => {
  it('the same user id and work name in two organizations are two pieces of work', async () => {
    const { effects, call } = server();
    expect(await call('A', 900)).toEqual({ charged: 900 });
    expect(await call('B', 1), 'globex got acme\'s result').toEqual({ charged: 1 });
    expect(effects).toEqual(['900', '1']);
  });

  it('a retry inside ONE organization is still one piece of work', async () => {
    const { effects, call } = server();
    await call('A', 900);
    expect(await call('A', 900)).toEqual({ charged: 900 });
    expect(effects).toEqual(['900']);
  });

  it('the record lands in that organization\'s journal, where its purge finds it', async () => {
    const { journal, call } = server();
    await call('A', 900);
    await call('B', 1);
    expect(await purgeResource(withOrg(journal, 'globex'), 'u1')).toBeGreaterThan(0);
    // acme's is untouched by globex's purge.
    expect(await call('A', 900)).toEqual({ charged: 900 });
  });

  it('an identity with no organization keeps the shared journal, as before', async () => {
    const { effects, call } = server();
    await call('N', 5);
    await call('N', 5);
    expect(effects).toEqual(['5']);
  });
});
