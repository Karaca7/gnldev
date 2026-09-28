// 0.7.0 release panel D-3: a thread upgraded from 0.6 has no owner record. When its runs were deleted
// and its messages remain, no owner can be derived — and the first named user who named it became its
// owner, with the history: mallory read AYSE-SECRET-HISTORY, the record became hers, ayse was refused.
//
// A thread with history and no derivable owner is now CLOSED to end users: it is staff's until an
// operator gives it to a user (`assignThreadOwner`). The one exception stays open on purpose — a thread
// whose only runs were born `unknown` in this release (an anonymous first turn, R11) is claimed by the
// first named user, as before.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl, user, toJournal, threadOwnerOf, threadOwnerKey, assignThreadOwner, withSubjectMemory, STAFF } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

function world() {
  const storage = new InMemoryStorage();
  const seen: string[] = [];
  const model = createMockModel(async ({ prompt }: any) => { seen.push(JSON.stringify(prompt)); return finalTextResult('ok'); });
  const memory = new BasicMemory(storage.runs as never);
  const gnl = createGnl({ storage, memory, agents: { a: { model } } } as never);
  return { storage, seen, gnl, memory, j: toJournal(storage.runs as never) as any };
}
const attempt = (gnl: any, o: object) => gnl.run('a', o).then(() => 'ADMITTED', (e: Error) => `REFUSED:${e.name}`);

describe('D-3: a thread with history and no derivable owner is closed to end users', () => {
  it('messages only (0.6 thread, runs deleted): the first named user does not become its owner', async () => {
    const { gnl, seen, memory, j } = world();
    await memory.append('T', [{ role: 'user', content: 'AYSE-SECRET-HISTORY' }, { role: 'assistant', content: 'ok' }] as never);
    expect(await attempt(gnl, { runId: 'm1', prompt: 'hi', threadId: 'T', caller: user('u-mallory') })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(seen.join('')).not.toContain('AYSE-SECRET-HISTORY');
    expect(await threadOwnerOf(j, memory, 'T')).toEqual({ exists: true, staffClaimed: true });
    // nobody's claim moved it: ayse is refused too, until an operator says it is hers
    expect(await attempt(gnl, { runId: 'a1', prompt: 'mine?', threadId: 'T', caller: user('u-ayse') })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(await withSubjectMemory(memory as never, 'u-mallory', { journal: j }).getMessages('T')).toEqual([]);
  });

  it('staff still reaches it, and an operator\'s assignment gives it to the user', async () => {
    const { gnl, seen, memory, j } = world();
    await memory.append('T', [{ role: 'user', content: 'AYSE-SECRET-HISTORY' }] as never);
    expect(await attempt(gnl, { runId: 's1', prompt: 'x', threadId: 'T', caller: STAFF })).toBe('ADMITTED');
    await assignThreadOwner(j, 'T', 'u-ayse');
    expect(await threadOwnerOf(j, memory, 'T')).toEqual({ exists: true, owner: 'u-ayse' });
    seen.length = 0;
    expect(await attempt(gnl, { runId: 'a1', prompt: 'hi', threadId: 'T', caller: user('u-ayse') })).toBe('ADMITTED');
    expect(seen.join('')).toContain('AYSE-SECRET-HISTORY');
    expect(await attempt(gnl, { runId: 'm1', prompt: 'hi', threadId: 'T', caller: user('u-mallory') })).toBe('REFUSED:ThreadOwnerMismatchError');
  });

  it('sibling: runs remain but name two users (no record) — closed, not the first claimant\'s', async () => {
    const { gnl, seen, j } = world();
    await j.put('r-a:input', { _v: 2, at: 1, resourceId: 'u-ayse', threadId: 'T2', prompt: 'AYSE-SECRET' });
    await j.put('r-a:model:0', { text: 'x' });
    await j.put('r-b:input', { _v: 2, at: 2, resourceId: 'u-bob', threadId: 'T2', prompt: 'BOB-SECRET' });
    await j.put('r-b:model:0', { text: 'x' });
    expect(await threadOwnerOf(j, undefined, 'T2')).toEqual({ exists: true, staffClaimed: true });
    expect(await attempt(gnl, { runId: 'm1', prompt: 'hi', threadId: 'T2', caller: user('u-mallory') })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(await attempt(gnl, { runId: 'a1', prompt: 'hi', threadId: 'T2', caller: user('u-ayse') })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(seen.join('')).not.toContain('SECRET');
  });

  it('sibling: runs remain but are ownerless staff runs (no record) — closed', async () => {
    const { gnl, j } = world();
    await j.put('r-s:input', { _v: 2, at: 1, ownerKind: 'staff', threadId: 'T3', prompt: 'STAFF-NOTE' });
    await j.put('r-s:model:0', { text: 'x' });
    expect(await attempt(gnl, { runId: 'm1', prompt: 'hi', threadId: 'T3', caller: user('u-mallory') })).toBe('REFUSED:ThreadOwnerMismatchError');
  });

  it('control (R11): an anonymous first turn in this release is still claimed by the first named user', async () => {
    const { gnl, j } = world();
    await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 'T4' });
    expect(await attempt(gnl, { runId: 'r1', prompt: 'my PIN', threadId: 'T4', caller: user('u-ayse') })).toBe('ADMITTED');
    expect((await j.get(threadOwnerKey('T4')))?.resourceId).toBe('u-ayse');
    expect(await attempt(gnl, { runId: 'r2', prompt: 'x', threadId: 'T4', caller: user('u-mallory') })).toBe('REFUSED:ThreadOwnerMismatchError');
  });

  it('control (R12): one derivable owner is still written as the record', async () => {
    const { gnl, j } = world();
    await gnl.run('a', { runId: 'r1', prompt: 'x', threadId: 'T5', caller: user('u-ayse') });
    await j.deletePrefix(threadOwnerKey('T5'));
    expect(await threadOwnerOf(j, undefined, 'T5')).toEqual({ exists: true, owner: 'u-ayse' });
  });
});
