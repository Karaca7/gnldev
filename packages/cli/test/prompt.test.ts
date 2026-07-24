// The checkbox selection logic is a PURE reducer(state, key) → state — tested here with synthetic
// key sequences (no TTY). The impure shell (raw stdin + ANSI render) is exercised by hand.
import { describe, it, expect } from 'vitest';
import { reducer, initState, selection, decodeKey, type Key, type PromptItem } from '../src/prompt.js';

const items: PromptItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

/** Fold a sequence of keys through the reducer from a fresh state. */
function run(keys: Key[], pre: string[] = []) {
  return keys.reduce((s, k) => reducer(s, k), initState(items, pre));
}

describe('checkbox reducer', () => {
  it('down,down,space,space,enter → checks the item under the cursor path', () => {
    // start cursor=0 → down→1 → down→2 → space checks c → space unchecks c ... let's assert precisely:
    // down (cursor1), down (cursor2), space (check c), enter (done).
    const s = run(['down', 'down', 'space', 'enter']);
    expect(s.done).toBe(true);
    expect(selection(s)).toEqual(['c']);
  });

  it('space,down,space,enter → checks the first two in input order', () => {
    const s = run(['space', 'down', 'space', 'enter']);
    expect(selection(s)).toEqual(['a', 'b']);
  });

  it('selection() preserves item (input) order regardless of toggle order', () => {
    // check c first (cursor 0→2), then a → selection should still be [a, c].
    const s = run(['down', 'down', 'space', 'up', 'up', 'space', 'enter']);
    expect(selection(s)).toEqual(['a', 'c']);
  });

  it('toggleAll checks everything, then again clears everything', () => {
    const all = run(['toggleAll']);
    expect(selection(all)).toEqual(['a', 'b', 'c']);
    const none = run(['toggleAll', 'toggleAll']);
    expect(selection(none)).toEqual([]);
  });

  it('toggleAll clears when everything is already checked (via space)', () => {
    const s = run(['space', 'down', 'space', 'down', 'space', 'toggleAll']);
    expect(selection(s)).toEqual([]);
  });

  it('up wraps from the top to the bottom, down wraps from the bottom to the top', () => {
    expect(reducer(initState(items), 'up').cursor).toBe(2);
    const bottom = run(['down', 'down']); // cursor 2
    expect(reducer(bottom, 'down').cursor).toBe(0);
  });

  it('cancel sets cancelled and freezes further keys', () => {
    const c = run(['space', 'cancel']);
    expect(c.cancelled).toBe(true);
    expect(c.done).toBe(false);
    // further keys are no-ops
    const after = reducer(c, 'space');
    expect(after).toBe(c);
  });

  it('enter freezes further keys (terminal state)', () => {
    const d = run(['space', 'enter']);
    expect(d.done).toBe(true);
    expect(reducer(d, 'space')).toBe(d);
  });

  it('pre-checked ids start selected', () => {
    const s = run(['enter'], ['b']);
    expect(selection(s)).toEqual(['b']);
  });

  it('reducer never mutates the input state', () => {
    const s0 = initState(items);
    const s1 = reducer(s0, 'space');
    expect(s0.checked.size).toBe(0); // original untouched
    expect(s1.checked.has('a')).toBe(true);
    expect(s1).not.toBe(s0);
  });
});

describe('decodeKey', () => {
  it('maps arrows / vi keys / space / a / enter / cancel bytes', () => {
    expect(decodeKey('\x1b[A')).toBe('up');
    expect(decodeKey('\x1b[B')).toBe('down');
    expect(decodeKey('k')).toBe('up');
    expect(decodeKey('j')).toBe('down');
    expect(decodeKey(' ')).toBe('space');
    expect(decodeKey('a')).toBe('toggleAll');
    expect(decodeKey('\r')).toBe('enter');
    expect(decodeKey('\n')).toBe('enter');
    expect(decodeKey('q')).toBe('cancel');
    expect(decodeKey('\x03')).toBe('cancel'); // Ctrl-C
    expect(decodeKey('\x1b')).toBe('cancel'); // Esc
    expect(decodeKey('z')).toBeUndefined();
  });
});
