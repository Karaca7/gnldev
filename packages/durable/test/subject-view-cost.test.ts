// The subject view's key rule costs O(1) owner reads per run per request, not one per key (R10:
// 1.3 s for 401 keys at 15e10409, one read per key per ':').
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withSubjectJournal } from '../src/subject-view.js';
import { claimRunOwner, user } from '../src/run-identity.js';

function counting(base: InMemoryJournal) {
  const c = { gets: 0 };
  const j = new Proxy(base as any, { get(t, p) {
    if (p === 'get') return async (k: string) => { c.gets++; return t.get(k); };
    const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v;
  } });
  return { j, c };
}

describe('subject view cost', () => {
  it('listKeys over 401 keys of one run costs one owner read', async () => {
    const base = new InMemoryJournal();
    await claimRunOwner(base, 'run-1', user('u'), { prompt: 'x' });
    for (let i = 0; i < 400; i++) await base.put(`run-1:tool:c${i}:args`, { i });
    const { j, c } = counting(base);
    const keys = await withSubjectJournal(j, 'u').listKeys!('run-1:');
    expect(keys.length).toBe(401);
    expect(c.gets).toBeLessThanOrEqual(2);
  });

  it('sibling: a get of a deep key reads each candidate run\'s owner once', async () => {
    const base = new InMemoryJournal();
    await claimRunOwner(base, 'r', user('u'), { prompt: 'x' });
    const key = 'r:' + Array.from({ length: 80 }, (_, i) => `s${i}`).join(':');
    await base.put(key, { v: 1 });
    const { j, c } = counting(base);
    const v = withSubjectJournal(j, 'u');
    expect(await v.get(key)).toEqual({ v: 1 });
    const first = c.gets;
    c.gets = 0;
    await v.get(key);
    expect(c.gets).toBeLessThan(first); // the owner reads are cached for the view's lifetime
  });
});
