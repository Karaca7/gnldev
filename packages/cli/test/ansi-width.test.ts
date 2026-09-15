// COLUMNS ARE NOT CODE UNITS, and everything that aligns output in this package assumed they were.
//
// `stripAnsi(s).length` counts UTF-16 code units. Three ways that is wrong on a terminal:
//
//   支払い完了   five code points, five units, TEN columns  — under-counted by five
//   🎉           one code point, TWO units, two columns     — over-counted by one, and a cut at an
//                odd offset lands between the surrogates and emits half a character
//   é (e + U+0301)  two units, ONE column                   — over-counted by one
//
// It shows up in two places a user meets. `gnl runs` prints THREAD and WORK KEY, which are the
// user's own strings: one Japanese thread title stepped every column after it to the right. And the
// prompt's clamp used the same count, so a wide label measured as fitting, wrapped on screen, and
// put the repaint back into the marching-header state the clamp exists to prevent — for anyone
// whose language is not Latin.
//
// No test in this package had ever passed a non-ASCII string.
import { describe, expect, it } from 'vitest';
import { displayWidth, truncateToWidth } from '../src/ansi.js';

const ESC = '\x1b';

describe('displayWidth counts what the terminal draws', () => {
  it('ASCII is one column each', () => {
    expect(displayWidth('hello')).toBe(5);
  });

  it('colour costs nothing', () => {
    expect(displayWidth(`${ESC}[32mok${ESC}[0m`)).toBe(2);
  });

  it('CJK costs two columns, not one', () => {
    expect(displayWidth('支払い完了'), 'five characters, ten columns').toBe(10);
    expect(displayWidth('한글'), 'Hangul is wide too').toBe(4);
  });

  it('an emoji is two columns and one character', () => {
    expect(displayWidth('🎉')).toBe(2);
    expect('🎉'.length, 'and this is why .length was wrong').toBe(2);
  });

  it('a combining mark costs nothing', () => {
    expect(displayWidth('é'), 'e + combining acute is one column').toBe(1);
  });

  it('Turkish stays exactly as wide as it looks', () => {
    // The language this project is written in. Latin-1 supplement is narrow, and a regression here
    // would be noticed by nobody in English and by everybody here.
    expect(displayWidth('çalışıyor — şu ana kadar')).toBe('çalışıyor — şu ana kadar'.length);
  });
});

describe('truncateToWidth never cuts a character in half', () => {
  it('stops before a wide character that would not fit', () => {
    const out = truncateToWidth('支払い完了', 7);
    expect(displayWidth(out)).toBeLessThanOrEqual(7);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never leaves half a surrogate pair', () => {
    // The concrete failure: an offset-based cut ended between the halves of 🎉 and the terminal
    // received `\ud83d` on its own.
    for (let w = 1; w <= 12; w++) {
      const out = truncateToWidth('a🎉b🎉c🎉', w);
      const body = out.replace(/…$/, '');
      expect(/[\uD800-\uDBFF]$/.test(body), `width ${w} left a lone high surrogate`).toBe(false);
      expect(displayWidth(out), `width ${w} overflowed`).toBeLessThanOrEqual(w);
    }
  });

  it('a string that already fits is returned untouched', () => {
    expect(truncateToWidth('支払い', 10)).toBe('支払い');
  });

  it('colour sequences are copied whole, never counted, never split', () => {
    const out = truncateToWidth(`${ESC}[32m支払い完了${ESC}[0m`, 5);
    expect(out).toContain(`${ESC}[32m`);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
  });
});
