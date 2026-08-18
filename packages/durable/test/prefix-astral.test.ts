// Prefix scans must cover every legal key, including ones a byte-ordered store sorts above U+FFFF.
//
// The upper bound of a prefix range was `prefix + U+FFFF`, on the assumption that nothing can follow
// the prefix and sort higher. That holds in UTF-16 — JS compares code units, and an astral character
// is a surrogate pair beginning at U+D800, below U+FFFF — and it is false in UTF-8, which is what
// SQLite and Postgres compare: U+FFFF is EF BF BF, while any astral character starts at F0.
//
// So an emoji in a run id put the key outside its own prefix range. Measured before the fix, three
// keys under `org:acme:`:
//
//   listKeys('org:acme:')     → 2 of 3
//   deletePrefix('org:acme:') → returned 2, and the third key was still readable afterwards
//
// A GDPR erasure and an organization purge both answered "done" and left data. Same silent-success
// shape as the collation bug, through a different door — and invisible in memory, because
// InMemoryJournal compares in UTF-16 where the old bound happened to work.
//
// The bound is now the prefix with its last code point incremented, which is exact: a key sorting at
// or above it cannot start with the prefix.
import { describe, it, expect } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { prefixUpperBound } from '../src/organization.js';

/** A key that begins with an astral character right after the prefix. */
const EMOJI = 'org:acme:\u{1F600}emoji:model:0';

describe('prefixUpperBound', () => {
  it('increments the last code point rather than appending a sentinel', () => {
    expect(prefixUpperBound('org:acme:')).toBe('org:acme;'); // ':' 0x3A → ';' 0x3B
    expect(prefixUpperBound('a')).toBe('b');
  });

  it('bounds above every astral suffix in UTF-8 byte order', () => {
    const bound = prefixUpperBound('org:acme:');
    const bytes = (s: string) => Buffer.from(s, 'utf8');
    // The property that matters, stated in the encoding the database actually compares.
    expect(Buffer.compare(bytes(EMOJI), bytes(bound)) < 0, 'the emoji key must sort below the bound').toBe(true);
    // ...which the old sentinel did not satisfy.
    expect(Buffer.compare(bytes(EMOJI), bytes('org:acme:￿')) < 0).toBe(false);
  });

  it('handles a prefix whose last code point is itself astral', () => {
    expect(prefixUpperBound('x\u{1F600}')).toBe('x\u{1F601}');
  });

  it('an empty prefix has no bound', () => {
    expect(prefixUpperBound('')).toBe('');
  });
});

describe('SQLite prefix scans over astral keys', () => {
  const seed = async () => {
    const s = new SqliteStorage(':memory:');
    await s.init();
    const j = s.runs;
    await j.put('org:acme:normal:model:0', { a: 1 });
    await j.put(EMOJI, { a: 2 });
    await j.put('org:acme:zzz:model:0', { a: 3 });
    // A neighbour whose id merely starts with the same characters — it must NOT be swept, which is
    // the failure an over-wide bound would produce while fixing the under-wide one.
    await j.put('org:acmeX:neighbour:model:0', { a: 4 });
    return j;
  };

  it('listKeys returns the astral key too', async () => {
    const j = await seed();
    expect((await j.listKeys('org:acme:')).sort()).toEqual(
      ['org:acme:normal:model:0', 'org:acme:zzz:model:0', EMOJI].sort(),
    );
  });

  it('deletePrefix really deletes it, and stops at the prefix boundary', async () => {
    const j = await seed();
    expect(await j.deletePrefix('org:acme:'), 'the count reported to a GDPR caller').toBe(3);
    expect(await j.get(EMOJI), 'an erasure reported success and left this row').toBeUndefined();
    expect(await j.get('org:acme:normal:model:0')).toBeUndefined();
    expect(await j.get('org:acmeX:neighbour:model:0'), 'a neighbouring org was swept').toBeDefined();
  });
});
