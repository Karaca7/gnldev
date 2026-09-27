// The actor lock refuses a stranger without telling the stranger whose run it is.
//
// `RunActorMismatchError` said "run 'st-4' belongs to actor 'ayse' — 'mehmet' may not re-drive it":
// being refused answered "whose is this id?", the id-guessing oracle. `FOREIGN_PARTY_DETAIL_FIELDS`
// strips `ownerActor` from `detail` on the public surfaces, but the MESSAGE travelled whole — and the
// chat, AG-UI and MCP surfaces hand engine messages to end users. The owner stays in `detail`, where
// an operator's log still has it and a public surface already redacts it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

const gnlOf = (journal: InMemoryJournal) =>
  createGnl({ journal, agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } } });

describe('RunActorMismatchError', () => {
  it('names the caller, not the owner — the owner stays in `detail`', async () => {
    const gnl = gnlOf(new InMemoryJournal());
    await gnl.run('a', { runId: 'st-4', prompt: 'x', context: sealRequestContext({}, { resourceId: 'ayse' }) });
    const err = await gnl.run('a', { runId: 'st-4', prompt: 'x', context: sealRequestContext({}, { resourceId: 'mehmet' }) })
      .then(() => undefined, (e: unknown) => e as { name: string; message: string; detail: Record<string, unknown> });
    expect(err?.name).toBe('RunActorMismatchError');
    expect(err!.message, 'the refusal told the stranger whose run it is').not.toContain('ayse');
    expect(err!.message).toContain('mehmet');
    expect(err!.detail).toMatchObject({ ownerActor: 'ayse', requestedActor: 'mehmet' });
  });
});
