// `idempotencyWindow: 'cross-run'` dedupes by a business key (an order id) across runs. It is not a way
// to hand one user another user's result: Mallory naming Ayşe's order got Ayşe's home address back,
// replayed as `origin: 'self'`, and the tool never ran for him. A record now says whose it is; a user
// replays only their own, and anyone else's is a conflict — neither her output nor a second execution.
import { describe, it, expect } from 'vitest';
import { stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { STAFF, gnlOf, userIdOf } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function setup() {
  const journal = new InMemoryJournal();
  const executedFor: Array<string | undefined> = [];
  const lookup = Object.assign(tool({
    description: 'look up an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }, o: any) => { executedFor.push(userIdOf(gnlOf(o))); return { orderId, address: `ADDRESS-OF-${userIdOf(gnlOf(o)) ?? 'staff'}` }; },
  }), { idempotencyWindow: 'cross-run' as const });
  async function call(runId: string, resourceId?: string) {
    let seen = '';
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('lookup', `c-${runId}`, { orderId: 'ORD-1' });
      seen = JSON.stringify(prompt);
      return finalTextResult('done');
    });
    await runDurable({ runId, journal, model, tools: { lookup }, prompt: 'x', stopWhen: stepCountIs(4), ...(resourceId ? { resourceId } : { principal: STAFF }) } as never);
    return seen;
  }
  return { call, executedFor };
}

describe('a cross-run record belongs to whoever made it', () => {
  it('another user gets neither the output nor a second execution', async () => {
    const { call, executedFor } = setup();
    expect(await call('r-ayse', 'ayse')).toContain('ADDRESS-OF-ayse');
    const mallory = await call('r-mal', 'mallory');
    expect(mallory).not.toContain('ADDRESS-OF-ayse');
    expect(executedFor).toEqual(['ayse']);
  });

  it('the owner replays her own; staff replay anyone\'s, as before', async () => {
    const { call, executedFor } = setup();
    await call('r-ayse', 'ayse');
    expect(await call('r-ayse-2', 'ayse')).toContain('ADDRESS-OF-ayse');
    expect(await call('r-staff')).toContain('ADDRESS-OF-ayse');
    expect(executedFor).toEqual(['ayse']);
  });

  it('a record staff made is not replayed to a user', async () => {
    const { call, executedFor } = setup();
    await call('r-staff');
    expect(await call('r-ayse', 'ayse')).not.toContain('ADDRESS-OF-staff');
    expect(executedFor).toEqual([undefined]);
  });
});
