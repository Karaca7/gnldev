// Regression suite for the `stableStringify` blind spot: `Date` / `Map` / `Set` / `RegExp` / `URL`
// have NO enumerable own keys, so the old `Object.keys()`-based normalizer flattened every one of
// them to `{}` — they all hashed identically. With `idempotency: 'args'` that made
// `{ when: new Date('2020-01-01') }` and `{ when: new Date('2030-06-06') }` the SAME logical call,
// so the second charge was silently swallowed as a duplicate and NEVER ran.
//
// The other half of this file guards the fix itself: `argsHash` feeds the journal key
// (`durable-tool.ts` → `runKeys.toolByArgs` / `runKeys.toolCrossRun`), so the hash of PLAIN JSON
// arguments must not move — otherwise in-flight runs lose their records on resume.
import { describe, it, expect } from 'vitest';
import { argsHash, stableStringify } from '../src/hash.js';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';

describe('stableStringify — plain-JSON hashes are FROZEN (journal-key compatibility)', () => {
  // Golden vectors captured from the PREVIOUS build before the fix landed. Any diff here means
  // in-flight runs would fail to resume — treat a failure as a breaking change, not a stale test.
  const GOLDEN: ReadonlyArray<readonly [string, unknown, string]> = [
    ['null', null, '74234e98afe7498f'],
    ['true', true, 'b5bea41b6c623f7c'],
    ['number', 42, '73475cb40a568e8d'],
    ['float', 3.14, '2efff1261c25d94d'],
    ['string', 'hello', '5aa762ae383fbb72'],
    ['empty-string', '', '12ae32cb1ec02d01'],
    ['empty-object', {}, '44136fa355b3678a'],
    ['empty-array', [], '4f53cda18c2baa0c'],
    ['flat-object', { amount: 20, currency: 'USD' }, 'df7e1558dbe016c9'],
    ['key-order-A', { a: 1, b: 2, c: 3 }, 'e6a3385fb77c287a'],
    ['key-order-B', { c: 3, b: 2, a: 1 }, 'e6a3385fb77c287a'],
    ['nested', { user: { id: 'u1', tags: ['a', 'b'] }, ok: true, n: null }, '8eac35b0c929caa7'],
    ['array-of-objects', [{ b: 1, a: 2 }, { d: 3, c: 4 }], 'b7674d3bc235a66d'],
    ['deep-nested', { l1: { l2: { l3: { l4: [1, 'two', false, null] } } } }, '3192f91ccaee8edf'],
    ['orderId-shape', { orderId: 'o1', note: 'first' }, 'a018e4293c5096eb'],
    ['mixed-array', [1, 'a', true, null, { z: 9, y: 8 }], '397c278e3605c335'],
    ['unicode', { msg: 'merhaba dünya 🌍' }, '0ca9240058cf3a5c'],
    ['numeric-keys', { 2: 'b', 10: 'c', 1: 'a' }, '6a441cd0d8f044b7'],
    ['nested-empty', { a: {}, b: [] }, 'aeeba1e56a144077'],
    // Keys starting with the TAG's leading characters. Without these the suite could not tell
    // ordinary keys from tag keys: an earlier shape derived the escape character from `TAG[0]`, so
    // rewriting the tag as `'gnl:'` turned the escape character into `'g'` and quietly rewrote every
    // key beginning with `g` (`{greeting:'hi'}` → `{"ggreeting":"hi"}`) — with all 47 tests green,
    // because not one frozen vector had such a key. These cover `g`, `n`, `l` and `:`.
    ['greeting', { greeting: 'hi' }, '5becb8c5090f7265'],
    ['tag-first-chars', { g: 1, n: 2, l: 3, ':': 4, gnl: 5, a: 6, Z: 7, 0: 8 }, '3e92f087daff5c76'],
    ['g-keys', { gateway: 'x', group: ['y'], gnl: { greeting: 'z' } }, 'ec9f522944140ba3'],
  ];

  it.each(GOLDEN.map(([name, value, hash]) => ({ name, value, hash })))(
    'argsHash($name) is unchanged',
    ({ value, hash }) => {
      expect(argsHash(value)).toBe(hash);
    },
  );

  it('key order still does not matter for plain objects', () => {
    expect(argsHash({ a: 1, b: 2, c: 3 })).toBe(argsHash({ c: 3, b: 2, a: 1 }));
  });

  it('escaping leaves ordinary keys alone — only a leading NUL is escaped', () => {
    // The readable statement of what the `g`/`n`/`l`/`:` vectors above enforce numerically.
    expect(stableStringify({ greeting: 'hi' })).toBe('{"greeting":"hi"}');
    expect(stableStringify({ gnl: 1, name: 2, limit: 3 })).toBe('{"gnl":1,"limit":3,"name":2}');
  });
});

// The tags are a WIRE FORMAT: `argsHash` over them becomes a journal key, and the impersonation
// tests further down hand-write `\u0000gnl:…` to build a forgery. If the tag text drifts, those tests
// go on passing while comparing two things that are both wrong, and every stored key silently moves.
// So the exact serialized form is asserted here, character for character, in ONE place.
describe('stableStringify — the tag namespace is pinned', () => {
  const ISO = '2020-01-01T00:00:00.000Z';

  it.each([
    ['Date', new Date(ISO), `{"\\u0000gnl:Date":"${ISO}"}`],
    ['Map', new Map([['a', 1]]), '{"\\u0000gnl:Map":[["a",1]]}'],
    ['Set', new Set([1]), '{"\\u0000gnl:Set":[1]}'],
    ['RegExp', /a/g, '{"\\u0000gnl:RegExp":["a","g"]}'],
    ['URL', new URL('https://e.com/'), '{"\\u0000gnl:URL":"https://e.com/"}'],
    ['URLSearchParams', new URLSearchParams('a=1'), '{"\\u0000gnl:URLSearchParams":[["a","1"]]}'],
    ['BigInt', 1n, '{"\\u0000gnl:BigInt":"1"}'],
  ])('%s serializes to its exact tagged form', (_name, value, expected) => {
    expect(stableStringify(value)).toBe(expected);
  });

  it('the Date payload keeps full millisecond precision', () => {
    // Truncating the payload (to the day, say) passes every "2020 vs 2030" test in this file while
    // merging the pair that actually shows up on an invoice: two charges on the SAME day.
    expect(stableStringify(new Date('2020-01-01T09:00:00.000Z')))
      .toBe('{"\\u0000gnl:Date":"2020-01-01T09:00:00.000Z"}');
    expect(argsHash({ when: new Date('2020-01-01T09:00:00.000Z') }))
      .not.toBe(argsHash({ when: new Date('2020-01-01T17:30:00.000Z') }));
    expect(argsHash({ when: new Date('2020-01-01T09:00:00.000Z') }))
      .not.toBe(argsHash({ when: new Date('2020-01-01T09:00:00.500Z') }));
  });

  it('Map/Set members are ordered by UTF-16 code units, not by locale collation', () => {
    // `localeCompare` puts `'a'` before `'B'`; code-unit order puts `'B'` first. Swapping the
    // comparator to `localeCompare` leaves every other test in this file green while making the hash
    // depend on the host's locale — i.e. a run resumed on another machine would not find its records.
    expect(stableStringify(new Set(['a', 'B']))).toBe('{"\\u0000gnl:Set":["B","a"]}');
    expect(stableStringify(new Map([['a', 1], ['B', 2]])))
      .toBe('{"\\u0000gnl:Map":[["B",2],["a",1]]}');
  });

  it('Map ordering stays insertion-independent even when two keys serialize alike', () => {
    // `undefined` and a function both serialize to the token "undefined", so the key comparison ties
    // and only the VALUE tie-break keeps the order stable. Drop that tie-break and insertion order
    // leaks into the hash — again with the rest of the suite green.
    const fn = () => 1;
    const a = new Map<unknown, number>([[undefined, 1], [fn, 2]]);
    const b = new Map<unknown, number>([[fn, 2], [undefined, 1]]);
    expect(argsHash(a)).toBe(argsHash(b));
    expect(stableStringify(a)).toBe('{"\\u0000gnl:Map":[[null,1],[null,2]]}');
  });
});

describe('stableStringify — previously-colliding types are now distinguished', () => {
  it('two different Dates hash differently (the reported bug)', () => {
    const a = argsHash({ when: new Date('2020-01-01T00:00:00.000Z') });
    const b = argsHash({ when: new Date('2030-06-06T00:00:00.000Z') });
    expect(a).not.toBe(b);
    // and the old collapse-to-{} value must be gone
    expect(a).not.toBe(argsHash({ when: {} }));
  });

  it('equal Dates still hash the SAME (dedup must keep working)', () => {
    expect(argsHash({ when: new Date('2020-01-01T00:00:00.000Z') }))
      .toBe(argsHash({ when: new Date('2020-01-01T00:00:00.000Z') }));
  });

  it('an invalid Date gets a stable token instead of throwing', () => {
    expect(() => argsHash({ when: new Date('not-a-date') })).not.toThrow();
    expect(argsHash({ when: new Date('not-a-date') })).toBe(argsHash({ when: new Date(NaN) }));
    expect(argsHash({ when: new Date('not-a-date') })).not.toBe(argsHash({ when: new Date(0) }));
  });

  it('Maps with different contents hash differently', () => {
    expect(argsHash({ m: new Map([['a', 1]]) })).not.toBe(argsHash({ m: new Map([['b', 2]]) }));
    expect(argsHash({ m: new Map([['a', 1]]) })).not.toBe(argsHash({ m: new Map([['a', 2]]) }));
  });

  it('Sets with different members hash differently', () => {
    expect(argsHash({ s: new Set([1, 2, 3]) })).not.toBe(argsHash({ s: new Set([4, 5, 6]) }));
    expect(argsHash({ s: new Set([1, 2]) })).not.toBe(argsHash({ s: new Set([1, 2, 3]) }));
  });

  it('RegExps differing in source OR flags hash differently', () => {
    expect(argsHash({ r: /foo/g })).not.toBe(argsHash({ r: /bar/g }));
    expect(argsHash({ r: /foo/g })).not.toBe(argsHash({ r: /foo/i })); // same source, different flags
    expect(argsHash({ r: /foo/g })).toBe(argsHash({ r: /foo/g }));
  });

  it('different URLs hash differently', () => {
    expect(argsHash({ u: new URL('https://a.example.com/x') }))
      .not.toBe(argsHash({ u: new URL('https://b.example.com/y') }));
    // query strings matter too — they are part of the effect's identity
    expect(argsHash({ u: new URL('https://a.example.com/x?q=1') }))
      .not.toBe(argsHash({ u: new URL('https://a.example.com/x?q=2') }));
  });

  it('different URLSearchParams hash differently', () => {
    // Left out of the first pass, which was an inconsistency rather than a decision: `URL` was fixed
    // while its query-string sibling kept collapsing to `{}`, so a tool called with two different
    // query sets deduplicated into ONE billable call.
    expect(argsHash({ q: new URLSearchParams('a=1') })).not.toBe(argsHash({ q: new URLSearchParams('a=2') }));
    expect(argsHash({ q: new URLSearchParams('a=1') })).not.toBe(argsHash({ q: {} }));
    expect(argsHash({ q: new URLSearchParams('a=1') })).toBe(argsHash({ q: new URLSearchParams('a=1') }));
  });

  it('URLSearchParams keeps parameter ORDER and duplicates — they are part of the query', () => {
    expect(argsHash(new URLSearchParams('a=1&b=2'))).not.toBe(argsHash(new URLSearchParams('b=2&a=1')));
    expect(argsHash(new URLSearchParams('a=1&a=2'))).not.toBe(argsHash(new URLSearchParams('a=1')));
    expect(argsHash(new URLSearchParams('a=1&a=2'))).not.toBe(argsHash(new URLSearchParams('a=2&a=1')));
  });

  it('BigInt hashes instead of throwing, and different values differ', () => {
    expect(() => argsHash({ n: 123n })).not.toThrow();
    expect(argsHash({ n: 123n })).not.toBe(argsHash({ n: 124n }));
  });

  it('every exotic type lands on its OWN hash — no cross-type collisions', () => {
    const hashes = [
      argsHash(new Date('2020-01-01T00:00:00.000Z')),
      argsHash(new Map([['a', 1]])),
      argsHash(new Set(['a'])),
      argsHash(/a/),
      argsHash(new URL('https://example.com/')),
      argsHash(new URLSearchParams('a=1')),
      argsHash(1n),
      argsHash({}),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('a URLSearchParams does not collide with the plain data that spells it', () => {
    expect(argsHash(new URLSearchParams('a=1'))).not.toBe(argsHash([['a', '1']]));
    expect(argsHash(new URLSearchParams('a=1'))).not.toBe(argsHash('a=1'));
    expect(argsHash(new URLSearchParams('a=1'))).not.toBe(argsHash({ a: '1' }));
  });
});

describe('stableStringify — the type tag prevents impersonation by plain JSON', () => {
  it('new Map([["a", 1]]) does NOT collide with { a: 1 }', () => {
    expect(argsHash(new Map([['a', 1]]))).not.toBe(argsHash({ a: 1 }));
  });

  it('a Set does not collide with the equivalent array', () => {
    expect(argsHash(new Set([1, 2, 3]))).not.toBe(argsHash([1, 2, 3]));
  });

  it('a Date does not collide with its own ISO string', () => {
    const iso = '2020-01-01T00:00:00.000Z';
    expect(argsHash(new Date(iso))).not.toBe(argsHash(iso));
  });

  it('a BigInt does not collide with the same digits as a string or number', () => {
    expect(argsHash(123n)).not.toBe(argsHash('123'));
    expect(argsHash(123n)).not.toBe(argsHash(123));
  });

  it('a URL does not collide with its href string', () => {
    expect(argsHash(new URL('https://example.com/'))).not.toBe(argsHash('https://example.com/'));
  });

  // The tags introduce a collision class that did NOT exist before them: a caller can put the tag
  // itself in a key, because JSON allows a NUL there. "No real caller would do that" is a statement
  // about likelihood, and this hash deduplicates BILLABLE calls, so the keys are escaped instead.
  // If escapeKey() is ever dropped, these go red.
  describe('a hand-built tag key cannot impersonate the real type', () => {
    const NUL = String.fromCharCode(0);
    const withKey = (key: string, value: unknown) => ({ [key]: value });
    const ISO = '2020-01-01T00:00:00.000Z';

    it('a plain object carrying the Date tag differs from a real Date', () => {
      expect(argsHash(withKey(`${NUL}gnl:Date`, ISO))).not.toBe(argsHash(new Date(ISO)));
    });

    it('the same holds for the Map and Set tags', () => {
      expect(argsHash(withKey(`${NUL}gnl:Map`, [['a', 1]]))).not.toBe(argsHash(new Map([['a', 1]])));
      expect(argsHash(withKey(`${NUL}gnl:Set`, [1, 2]))).not.toBe(argsHash(new Set([1, 2])));
    });

    it('escaping is injective — every depth of NUL stays distinct', () => {
      const hashes = [1, 2, 3].map((depth) => argsHash(withKey(NUL.repeat(depth) + 'gnl:Date', ISO)));
      hashes.push(argsHash(new Date(ISO)));
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it('escaping reaches nested objects and object keys of a Map', () => {
      expect(argsHash({ o: withKey(`${NUL}gnl:Date`, ISO) })).not.toBe(argsHash({ o: new Date(ISO) }));
      expect(argsHash(new Map<unknown, number>([[withKey(`${NUL}gnl:Date`, 'x'), 1]]))).not.toBe(
        argsHash(new Map<unknown, number>([[new Date(ISO), 1]])),
      );
    });

    it('an escaped key still hashes deterministically', () => {
      expect(argsHash(withKey(`${NUL}gnl:Date`, ISO))).toBe(argsHash(withKey(`${NUL}gnl:Date`, ISO)));
    });

    // `escapeKey` only guards the OBJECT-KEY path. An object with its own `toJSON` used to hand its
    // return value straight to the final `JSON.stringify`, unescaped — so a forged tag came back out
    // intact and every one of the six types could be impersonated (measured). Normalizing the
    // `toJSON` result closes it; these fail if that call ever stops being recursive.
    it('a forged tag returned from toJSON cannot impersonate the real type either', () => {
      const forge = (type: string, payload: unknown) => ({ toJSON: () => withKey(`${NUL}gnl:${type}`, payload) });
      expect(argsHash(forge('Date', ISO))).not.toBe(argsHash(new Date(ISO)));
      expect(argsHash(forge('Map', [['a', 1]]))).not.toBe(argsHash(new Map([['a', 1]])));
      expect(argsHash(forge('Set', [1, 2]))).not.toBe(argsHash(new Set([1, 2])));
      expect(argsHash(forge('RegExp', ['foo', 'g']))).not.toBe(argsHash(/foo/g));
      expect(argsHash(forge('URL', 'https://e.com/'))).not.toBe(argsHash(new URL('https://e.com/')));
      expect(argsHash(forge('BigInt', '123'))).not.toBe(argsHash(123n));
    });
  });
});

describe('stableStringify — toJSON is honored, the way JSON.stringify honors it', () => {
  const ISO = '2020-01-01T00:00:00.000Z';

  class Hidden {
    #state: string;
    constructor(state: string) { this.#state = state; }
    toJSON() { return { state: this.#state }; }
  }

  it('an object whose state is reachable only through toJSON no longer collapses to {}', () => {
    // `toJSON` normally lives on the PROTOTYPE, and the generic branch copies own enumerable keys
    // only — so it was dropped and the instance flattened to `{}`. Two instances with different
    // state then shared one hash: the same collapse-to-`{}` defect the type tags exist to fix,
    // reached from another direction. `JSON.stringify` always distinguished these.
    expect(argsHash(new Hidden('AAA'))).not.toBe(argsHash(new Hidden('BBB')));
    expect(argsHash(new Hidden('AAA'))).not.toBe(argsHash({}));
    expect(stableStringify(new Hidden('AAA'))).toBe('{"state":"AAA"}');
    expect(argsHash(new Hidden('AAA'))).toBe(argsHash(new Hidden('AAA')));
  });

  it('the toJSON result is normalized too — key order inside it no longer leaks', () => {
    // Previously the returned object went to `JSON.stringify` verbatim, so the module's central
    // promise (key order does not matter) did NOT hold across a toJSON boundary: the same logical
    // arguments produced two journal keys, and the second call ran again instead of deduplicating.
    expect(argsHash({ toJSON: () => ({ b: 1, a: 2 }) })).toBe(argsHash({ toJSON: () => ({ a: 2, b: 1 }) }));
  });

  it('exotic values returned from toJSON get tagged like any other', () => {
    expect(argsHash({ toJSON: () => ({ when: new Date(ISO) }) }))
      .not.toBe(argsHash({ toJSON: () => ({ when: ISO }) }));
  });

  it('the property name is still passed to toJSON, as JSON.stringify does', () => {
    const probe = { toJSON: (key: string) => `key=${JSON.stringify(key)}` };
    expect(stableStringify(probe)).toBe('"key=\\"\\""');
    expect(stableStringify({ k: probe })).toBe('{"k":"key=\\"k\\""}');
    expect(stableStringify([probe])).toBe('["key=\\"0\\""]');
  });

  it('Date and friends are NOT delegated to their own toJSON', () => {
    // `Date.prototype.toJSON` returns a bare ISO string; deferring to it would re-collide a Date with
    // the string that spells it — exactly the distinction the tags create. The built-in branches must
    // stay ahead of the toJSON branch.
    expect(argsHash(new Date(ISO))).not.toBe(argsHash(ISO));
    expect(stableStringify(new Date(ISO))).toBe(`{"\\u0000gnl:Date":"${ISO}"}`);
  });

  it('toJSON REPLACES the object — an accepted consequence, not an oversight', () => {
    // Standard JavaScript semantics: a caller that defines `toJSON` is declaring what the value IS,
    // so siblings are not part of its identity. Unreachable from the wire regardless — it takes a
    // callable property, and `JSON.parse` cannot produce one.
    expect(argsHash({ toJSON: () => 1, secret: 'AAA' })).toBe(argsHash({ toJSON: () => 1, secret: 'BBB' }));
    expect(typeof (JSON.parse('{"toJSON":"x"}') as { toJSON: unknown }).toJSON).toBe('string');
    // ...while an ordinary function-valued property is simply invisible, and siblings still count.
    expect(argsHash({ f: () => 1, secret: 'AAA' })).not.toBe(argsHash({ f: () => 1, secret: 'BBB' }));
  });
});

describe('argsHash — values JSON cannot represent', () => {
  it('undefined has a stable hash: "no arguments" is a legitimate argument', () => {
    // `stableStringify(undefined)` is `undefined`, which used to reach `createHash().update()` and
    // fail with `The "data" argument must be of type string...`. Nothing can regress here — every
    // input in this block threw before, so no journal record was ever written under one.
    expect(argsHash(undefined)).toBe(argsHash(undefined));
    expect(argsHash(undefined)).not.toBe(argsHash(null));
    expect(argsHash(undefined)).not.toBe(argsHash({}));
    expect(argsHash(undefined)).not.toBe(argsHash('undefined'));
  });

  it('a function or symbol is a caller mistake and says so', () => {
    expect(() => argsHash(() => 1)).toThrow(/type "function" has no JSON representation/);
    expect(() => argsHash(Symbol('s'))).toThrow(/type "symbol" has no JSON representation/);
  });
});

describe('stableStringify — the flattening that REMAINS, stated on purpose', () => {
  it('types with no canonical JSON form still share the empty-object hash', () => {
    // Not an oversight and not a silent one. `Error` carries its data in non-enumerable own
    // properties and its `stack` is machine-dependent, so hashing it would make the key unstable;
    // the others have no serializable content at all. None of them is a plausible tool argument, and
    // unlike `Date`/`URL`/`URLSearchParams` none has an obvious canonical form to tag. If that ever
    // stops being true, this test is the place the decision gets revisited.
    const empty = argsHash({});
    expect(argsHash(new Error('boom'))).toBe(empty);
    expect(argsHash(new ArrayBuffer(4))).toBe(empty);
    expect(argsHash(new WeakMap())).toBe(empty);
  });
});

describe('stableStringify — a circular argument is a caller error, and says so', () => {
  // Measured before this block existed: EVERY case below died with
  // `RangeError: Maximum call stack size exceeded`. Two things were wrong with that. The message
  // named nothing — not the package, not the argument, not the path — so a caller reading a
  // production log had no way to tell a bad argument from a runaway loop somewhere else. And
  // `RangeError` is the wrong SIGNAL: it reads as resource exhaustion (retry later, smaller batch),
  // when the truth is that the argument can never be hashed no matter how much stack there is.
  // `JSON.stringify` has always reported this as a `TypeError`, and so do we now.
  //
  // Nothing here can break journal compatibility: a stack overflow never produced a hash, so no
  // record was ever written under any of these inputs.
  const CIRCULAR = /@gnldev\/durable: circular reference/;

  it('a self-referencing object throws a named TypeError, not a stack overflow', () => {
    const self: Record<string, unknown> = { a: 1 };
    self.self = self;
    expect(() => argsHash(self)).toThrow(TypeError);
    expect(() => argsHash(self)).toThrow(CIRCULAR);
    expect(() => argsHash(self)).not.toThrow(RangeError);
  });

  it('the error names the path that closes the loop', () => {
    // The single most useful thing the message can carry: WHICH argument is circular. Without it a
    // caller holding a large tool-argument payload is left bisecting it by hand.
    const root: Record<string, unknown> = { ok: 1, deep: { inner: {} } };
    (root.deep as { inner: Record<string, unknown> }).inner.back = root;
    expect(() => argsHash(root)).toThrow(/\$\.deep\.inner\.back/);
  });

  it('the cycle is caught through arrays, Maps and Sets too', () => {
    // Each of these has its OWN recursive branch in the normalizer; a cycle check bolted onto the
    // plain-object branch alone would leave all three still overflowing.
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => argsHash(arr)).toThrow(CIRCULAR);
    expect(() => argsHash(arr)).toThrow(/\$\[1\]/);

    const mapValue = new Map<string, unknown>();
    mapValue.set('self', mapValue);
    expect(() => argsHash(mapValue)).toThrow(CIRCULAR);

    const mapKey = new Map<unknown, number>();
    mapKey.set(mapKey, 1);
    expect(() => argsHash(mapKey)).toThrow(CIRCULAR);

    const set = new Set<unknown>();
    set.add(set);
    expect(() => argsHash(set)).toThrow(CIRCULAR);
  });

  it('a mutual cycle between two objects is caught as well', () => {
    const p: Record<string, unknown> = { name: 'p' };
    const q: Record<string, unknown> = { name: 'q', p };
    p.q = q;
    expect(() => argsHash(p)).toThrow(CIRCULAR);
    expect(() => argsHash({ wrapper: [p] })).toThrow(CIRCULAR);
  });

  it('toJSON returning `this` — or a wrapper around it — is caught, not overflowed', () => {
    // The `toJSON` result is re-normalized (that is what closes the forged-tag hole above), so a
    // `toJSON` that hands back the same object loops forever WITHOUT any circular data. Measured as
    // a RangeError before this fix. Note this is one place we deliberately differ from
    // `JSON.stringify`, which calls `toJSON` only once and quietly yields `{}`.
    expect(() => argsHash({ toJSON() { return this; } })).toThrow(CIRCULAR);
    const wrapped: Record<string, unknown> = { toJSON: () => ({ inner: wrapped }) };
    expect(() => argsHash(wrapped)).toThrow(CIRCULAR);
    expect(() => argsHash(wrapped)).toThrow(/toJSON/);
  });

  it('a cycle hiding under a shared reference is still found', () => {
    const shared = { s: 1 };
    const root: Record<string, unknown> = { shared, deep: { shared } as Record<string, unknown> };
    (root.deep as Record<string, unknown>).back = root;
    expect(() => argsHash(root)).toThrow(CIRCULAR);
  });
});

describe('stableStringify — a SHARED reference is not a cycle (do not over-detect)', () => {
  // The obvious implementation of cycle detection — a visited-set that is never cleared — turns
  // every repeated reference into a false alarm. Shared references are ordinary and ALREADY hash
  // today, so rejecting them would be a live regression: `{ x: shared, y: shared }` is what a caller
  // gets from any normalizing/dedup layer that hands the same sub-object to two fields. The set must
  // be kept along the DESCENT PATH and unwound on the way out.
  const shared = { a: 1, b: [1, 2, { deep: true }] };

  it('the same object under two keys hashes fine, and expands twice', () => {
    expect(() => argsHash({ x: shared, y: shared })).not.toThrow();
    expect(stableStringify({ x: shared, y: shared }))
      .toBe('{"x":{"a":1,"b":[1,2,{"deep":true}]},"y":{"a":1,"b":[1,2,{"deep":true}]}}');
  });

  it('sharing survives arrays, Maps, Sets and a diamond', () => {
    expect(() => argsHash([shared, shared, shared])).not.toThrow();
    expect(() => argsHash(new Map<string, unknown>([['a', shared], ['b', shared]]))).not.toThrow();
    expect(() => argsHash(new Set([shared, shared]))).not.toThrow();
    const bottom = { v: 'bottom' };
    expect(() => argsHash({ left: { d: bottom }, right: { d: bottom } })).not.toThrow();
  });

  it('the same object may appear hundreds of times, and sequentially down a path', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = shared;
    expect(() => argsHash(wide)).not.toThrow();
    // ...and repeated at successive DEPTHS, which is the case a naive unwind gets wrong: `shared`
    // sits beside every link of the chain, so it is entered and left 30 times over.
    let chain: unknown = shared;
    for (let i = 0; i < 30; i++) chain = { next: chain, side: shared };
    expect(() => argsHash(chain)).not.toThrow();
    expect(argsHash(chain)).toBe(argsHash(chain));
  });

  it('a deep but acyclic structure is NOT rejected as a cycle', () => {
    // Guards against "fixing" the overflow with a depth cap: 500 levels hash today (the normalizer's
    // measured ceiling on this host is ~1800), so a cap firing below that would newly reject
    // arguments that currently produce a journal key.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 500; i++) deep = { l: deep };
    expect(() => argsHash(deep)).not.toThrow();
  });
});

describe('stableStringify — determinism', () => {
  it('repeated calls on the same value are identical', () => {
    const value = { when: new Date('2021-03-04T05:06:07.000Z'), m: new Map([['b', 2], ['a', 1]]), s: new Set(['y', 'x']) };
    expect(stableStringify(value)).toBe(stableStringify(value));
    expect(argsHash(value)).toBe(argsHash(value));
  });

  it('Map insertion order does not change the hash (parity with object key sorting)', () => {
    expect(argsHash(new Map<string, number>([['a', 1], ['b', 2]])))
      .toBe(argsHash(new Map<string, number>([['b', 2], ['a', 1]])));
  });

  it('Set insertion order does not change the hash', () => {
    expect(argsHash(new Set([3, 1, 2]))).toBe(argsHash(new Set([2, 3, 1])));
  });

  it('exotic values nested inside arrays and objects are normalized too', () => {
    expect(argsHash({ list: [{ when: new Date('2020-01-01T00:00:00.000Z') }] }))
      .not.toBe(argsHash({ list: [{ when: new Date('2030-06-06T00:00:00.000Z') }] }));
    expect(argsHash([new Set([1])])).not.toBe(argsHash([new Set([2])]));
  });

  it('Maps/Sets containing exotic values are normalized recursively', () => {
    expect(argsHash(new Map([['k', new Date('2020-01-01T00:00:00.000Z')]])))
      .not.toBe(argsHash(new Map([['k', new Date('2030-06-06T00:00:00.000Z')]])));
  });
});

describe('end-to-end: durableTool + idempotency "args" with Date arguments', () => {
  it('two different Dates → the underlying execute runs TWICE (the second charge is no longer swallowed)', async () => {
    const journal = new InMemoryJournal();
    const charged: string[] = [];
    const dt = durableTool(
      {
        idempotency: 'args' as const,
        execute: async (args: any) => {
          charged.push(args.when.toISOString());
          return { ok: true, when: args.when.toISOString() };
        },
      },
      { journal, runId: 'r-date-args' },
      'charge',
    );

    const o1 = await dt.execute!({ amount: 10, when: new Date('2020-01-01T00:00:00.000Z') }, { toolCallId: 'c1' });
    const o2 = await dt.execute!({ amount: 10, when: new Date('2030-06-06T00:00:00.000Z') }, { toolCallId: 'c2' });

    expect(charged).toEqual(['2020-01-01T00:00:00.000Z', '2030-06-06T00:00:00.000Z']);
    expect(o1).toEqual({ ok: true, when: '2020-01-01T00:00:00.000Z' });
    expect(o2).toEqual({ ok: true, when: '2030-06-06T00:00:00.000Z' });
  });

  it('the SAME Date is still deduped — the fix does not weaken exactly-once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotency: 'args' as const,
        execute: async () => { calls++; return { ok: true, seq: calls }; },
      },
      { journal, runId: 'r-date-dedup' },
      'charge',
    );

    const o1 = await dt.execute!({ when: new Date('2020-01-01T00:00:00.000Z') }, { toolCallId: 'c1' });
    const o2 = await dt.execute!({ when: new Date('2020-01-01T00:00:00.000Z') }, { toolCallId: 'c2' });

    expect(calls).toBe(1);
    expect(o2).toEqual(o1); // second call served from the journal
  });

  it('different Maps/Sets/URLs also get their own journal records', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      { idempotency: 'args' as const, execute: async () => { calls++; return { seq: calls }; } },
      { journal, runId: 'r-exotic-args' },
      'sync',
    );

    await dt.execute!({ tags: new Set(['a']) }, { toolCallId: 'c1' });
    await dt.execute!({ tags: new Set(['b']) }, { toolCallId: 'c2' });
    await dt.execute!({ target: new URL('https://a.example.com/') }, { toolCallId: 'c3' });
    await dt.execute!({ target: new URL('https://b.example.com/') }, { toolCallId: 'c4' });

    expect(calls).toBe(4);
  });
});
