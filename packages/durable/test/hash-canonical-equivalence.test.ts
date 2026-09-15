// THE HASH IS THE PROMISE. `idempotency: 'args'` says the same work never runs twice, and the only
// thing that decides what "the same" means is this function — so every way two arguments can LOOK
// the same and hash apart is a way that promise breaks, silently, in production.
//
// Two were measured with a real tool call before this file existed.
//
//   José (NFC) vs José (NFD)   One code point versus `e` + a combining acute. Unicode calls these
//                              CANONICALLY EQUIVALENT — the same text, by its own definition — and
//                              no screen can tell them apart. macOS and iOS produce NFD; Linux and
//                              web form submission produce NFC. So the same customer arriving from
//                              a phone and from a browser hashed differently and WAS CHARGED TWICE.
//
//   NaN / Infinity /           JSON has no syntax for any of them, so `JSON.stringify` renders all
//   -Infinity / null           three as `null` — and so does `null` itself. Four distinct values,
//                              one journal key: `{amount: Infinity}` was answered from the entry
//                              `{amount: NaN}` wrote, having never run. Neither is a valid charge;
//                              merging them hides an upstream divide-by-zero instead of letting the
//                              second call fail on its own.
//
// What must NOT be collapsed is the other half of the same test: case, whitespace and accents that
// Unicode does not call equivalent are DIFFERENT text, and folding them would merge work nobody
// asked to merge.
import { describe, expect, it } from 'vitest';
import { argsHash, stableStringify } from '../src/hash.js';

const NUL = String.fromCharCode(0);

describe('canonically equivalent text is the same work', () => {
  it('a value in NFC and NFD hashes the same', () => {
    expect('José'.normalize('NFC')).not.toBe('José'.normalize('NFD')); // genuinely different bytes
    expect(argsHash({ customer: 'José'.normalize('NFC') }))
      .toBe(argsHash({ customer: 'José'.normalize('NFD') }));
  });

  it('a KEY in NFC and NFD hashes the same', () => {
    // A key is caller data too — `{ metadata: { 'müşteri-adı': … } }` comes from the user, not the
    // schema.
    expect(argsHash({ ['café'.normalize('NFC')]: 1 }))
      .toBe(argsHash({ ['café'.normalize('NFD')]: 1 }));
  });

  it.each([
    ['Turkish', 'İstanbul'],
    ['French', 'déjà vu'],
    ['Vietnamese', 'Tiếng Việt'],
    ['Korean', '한국어'],
  ])('%s text hashes the same in either normal form', (_lang, text) => {
    expect(argsHash({ v: text.normalize('NFC') })).toBe(argsHash({ v: text.normalize('NFD') }));
  });

  it('normalization is NOT case folding, trimming, or accent stripping', () => {
    const h = (v: unknown) => argsHash(v);
    expect(h({ v: 'José' }), 'case is meaning').not.toBe(h({ v: 'JOSÉ' }));
    expect(h({ v: 'Jose' }), 'an accent is not decoration').not.toBe(h({ v: 'José' }));
    expect(h({ v: ' a' }), 'leading space is data').not.toBe(h({ v: 'a' }));
    expect(h({ v: 'a b' }), 'inner whitespace is data').not.toBe(h({ v: 'ab' }));
  });
});

describe('values JSON cannot tell apart are told apart here', () => {
  it('NaN, Infinity, -Infinity and null are four different keys', () => {
    const hashes = [NaN, Infinity, -Infinity, null].map((amount) => argsHash({ amount }));
    expect(new Set(hashes).size, 'they all collapsed to the same JSON null').toBe(4);
  });

  it('a finite number is untouched — this must not change any existing key', () => {
    expect(stableStringify({ n: 1 })).toBe('{"n":1}');
    expect(stableStringify({ n: -1.5 })).toBe('{"n":-1.5}');
    expect(stableStringify({ n: 0 })).toBe('{"n":0}');
  });

  it('the tag cannot be impersonated by a caller-supplied key', () => {
    // The escape that keeps a literal `gnl:Date` key from serializing as a real Date still applies
    // after normalization, which now runs first.
    expect(argsHash({ [NUL + 'gnl:Date']: 'x' })).not.toBe(argsHash(new Date(0)));
    expect(argsHash({ [NUL + 'gnl:Number']: 'NaN' })).not.toBe(argsHash({ v: NaN }));
  });
});
