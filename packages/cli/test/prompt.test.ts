// The checkbox selection logic is a PURE reducer(state, key) → state — tested here with synthetic
// key sequences (no TTY). The impure shell (raw stdin + ANSI render) is exercised by hand.
import { describe, it, expect } from 'vitest';
import { reducer, initState, selection, decodeKey, decodeKeys, decodeStream, renderLines, drawWidth, visibleWindow, type Key, type PromptItem } from '../src/prompt.js';

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
    // ESC USED TO BE HERE, and this assertion is why it survived so long. A lone escape byte is far
    // more often the head of an arrow sequence that arrived split across two reads than it is
    // someone pressing Escape — and decoding it as `cancel` meant an arrow key could abandon
    // `gnl init`. The help line offers `q` and Ctrl-C; it never offered ESC.
    expect(decodeKey('\x1b')).toBeUndefined();
    expect(decodeKey('z')).toBeUndefined();
  });
});

// ── width: one logical line must never take two screen rows ───────────────────────────────────
// The repaint moves the cursor up by the number of lines last written. A line wider than the
// terminal wraps, takes two rows, and the arithmetic silently under-shoots — the header reappears on
// every keypress and walks down the screen. Measured on the preset question in an 80-column
// terminal: nineteen copies of the title. So the invariant is width, and it is asserted on the
// VISIBLE length, since every line here carries colour.
describe('rendered lines fit the terminal', () => {
  const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const longItems = [
    { id: 'a', label: 'A person, on a screen, waiting for the answer', hint: 'a repeat can be turned into a question' },
    { id: 'b', label: 'A scheduler or a queue — nobody is watching', hint: 'nobody to ask, so a repeated payment is refused outright' },
    { id: 'c', label: 'Money or stock moves, and a double is unacceptable', hint: 'the above, plus a run lock, input fingerprinting, tombstones' },
  ];

  it.each([40, 60, 80, 120])('at %i columns every line is within the width', (width) => {
    const state = initState(longItems, [], { single: true });
    for (const line of renderLines(state, 'gnl init — Who sets this work going?', width)) {
      expect(visible(line).length, `"${visible(line)}" is ${visible(line).length} > ${width}`).toBeLessThanOrEqual(width);
    }
  });

  // A TERMINAL THAT DOES NOT KNOW HOW WIDE IT IS. Measured under `script(1)`: `isTTY` true,
  // `columns` 0. The old expression was `(output.columns ?? 80) - 1`, and `??` passes 0 through, so
  // the prompt rendered at width -1 — every row one character and an ellipsis (`g…`, `❯…`). The
  // whole flow was on screen and unreadable, which on a prompt means unanswerable.
  //
  // Nothing here caught it because every test above passes a width in. This one asks the function
  // that decides the width instead, which is why that expression is now a function.
  it.each([
    [0, 'a TTY that never sent a window size'],
    [undefined, 'not a terminal at all'],
    [1, 'a terminal one column wide'],
    [10, 'narrower than anything worth truncating to'],
  ])('a reported width of %s (%s) still renders something readable', (columns) => {
    const width = drawWidth(columns as number | undefined);
    expect(width, 'a width below 20 leaves nothing but punctuation').toBeGreaterThanOrEqual(20);
    const lines = renderLines(initState(longItems, [], { single: true }), 'gnl init — how should this project start?', width);
    for (const line of lines) {
      const v = visible(line);
      // The failure this replaces: every line was exactly "X…". Anything readable is longer.
      if (v.trim().length) expect(v.trim().length, `"${v}" is not a readable row`).toBeGreaterThan(3);
    }
  });

  it('a real width is still used as given — the floor is a floor, not an override', () => {
    expect(drawWidth(120)).toBe(119);
    expect(drawWidth(80)).toBe(79);
  });

  it('a clamped line keeps its colours closed and says it was cut', () => {
    const [, , , first] = renderLines(initState(longItems, [], { single: true }), 'title', 40);
    expect(visible(first!)).toContain('…');
    expect(first!.endsWith('\x1b[0m'), 'an open colour sequence bleeds into the next line').toBe(true);
  });

  it('a line that fits is left exactly alone', () => {
    const short = [{ id: 'x', label: 'ok' }];
    const [, , , row] = renderLines(initState(short, [], { single: true }), 't', 80);
    expect(visible(row!)).toBe('❯ ◯ ok');
  });
});

// A READ IS NOT A KEYSTROKE. Four inputs a real terminal produces, each of which the
// whole-chunk-equality decoder got wrong, and none of which any test here was shaped to send:
// the harness above feeds keys one at a time, a microtask apart, which is the opposite of the
// condition that breaks them.
describe('what the terminal actually delivers', () => {
  it('holding an arrow down arrives as ONE chunk of several sequences', () => {
    // Node coalesces key repeats. Equality matched none of them, so a held key moved nothing.
    expect(decodeKeys('\x1b[B\x1b[B\x1b[B')).toEqual(['down', 'down', 'down']);
    expect(decodeKeys('\x1b[B\x1b[B\r')).toEqual(['down', 'down', 'enter']);
  });

  it('Enter is one Enter whether the pty sends LF, CR, or CRLF', () => {
    expect(decodeKeys('\r')).toEqual(['enter']);
    expect(decodeKeys('\n')).toEqual(['enter']);
    expect(decodeKeys('\r\n'), 'CRLF decoded as nothing at all, so Enter was dead on those ptys').toEqual(['enter']);
  });

  it('arrows work in application cursor mode — what tmux and PuTTY send', () => {
    expect(decodeKeys('\x1bOA')).toEqual(['up']);
    expect(decodeKeys('\x1bOB')).toEqual(['down']);
  });

  it('A LONE ESC DOES NOT CANCEL — it is the first byte of an arrow key', () => {
    // The dangerous one. On a slow or remote pty the escape byte can arrive in its own read, and
    // the old decoder answered `cancel`: pressing an arrow abandoned `gnl init`. Cancelling has two
    // documented keys, both in the help line, and ESC is neither.
    expect(decodeKeys('\x1b')).toEqual([]);
    expect(decodeKeys('\x03'), 'Ctrl-C still cancels').toEqual(['cancel']);
    expect(decodeKeys('q'), 'q still cancels — it is the one the help line names').toEqual(['cancel']);
  });

  it('a left or right arrow is swallowed, not mistaken for a letter', () => {
    // `\x1b[D` ends in `D`; falling through to the letter cases would have read it as something.
    expect(decodeKeys('\x1b[C')).toEqual([]);
    expect(decodeKeys('\x1b[D')).toEqual([]);
  });

  it('nothing after Enter is applied to this prompt', () => {
    // Keys typed ahead belong to whatever comes next, not to the list that just closed.
    let state = initState([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], [], { single: true });
    for (const key of decodeKeys('\r\x1b[B\x1b[B')) {
      state = reducer(state, key);
      if (state.done || state.cancelled) break;
    }
    expect(state.done).toBe(true);
    expect(selection(state), 'the cursor moved after Enter and changed the answer').toEqual(['a']);
  });
});

// THE VERTICAL HALF. `clamp` stopped a too-WIDE row from wrapping and breaking the cursor-up
// arithmetic; a too-TALL list breaks it the same way, by scrolling the terminal instead. Width had
// four test values. Height had none, because `output.rows` was never read — so the six-option
// `gnl add processors` list in a split pane was the same defect, unmeasured.
describe('a list taller than the terminal', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, label: `option ${i}` }));

  it('fits inside the rows it was given, chrome included', () => {
    for (const rows of [8, 10, 14, 24]) {
      const state = { ...initState(items, [], { single: true }), cursor: 6 };
      const lines = renderLines(state, 'pick one', 80, rows);
      expect(lines.length, `${lines.length} lines written into a ${rows}-row terminal`).toBeLessThanOrEqual(rows);
    }
  });

  it('keeps the cursor on screen wherever it is', () => {
    for (const cursor of [0, 1, 5, 6, 10, 11]) {
      const { start, end } = visibleWindow(items.length, cursor, 10);
      expect(cursor, `cursor ${cursor} fell outside [${start}, ${end})`).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
    }
  });

  it('says how many options are out of sight', () => {
    // A list that silently hides rows is worse than one that scrolls: the reader cannot tell
    // "not there" from "not visible".
    const state = { ...initState(items, [], { single: true }), cursor: 6 };
    const lines = renderLines(state, 'pick one', 80, 10);
    expect(lines.join('\n')).toMatch(/above|below/);
  });

  it('a list that fits is not windowed and says nothing about hidden rows', () => {
    const state = initState(items.slice(0, 3), [], { single: true });
    const lines = renderLines(state, 'pick one', 80, 24);
    expect(lines.length).toBe(6);
    expect(lines.join('\n')).not.toMatch(/above|below/);
  });

  it('an unknown height behaves exactly as before — every item, no counter', () => {
    const state = initState(items, [], { single: true });
    expect(renderLines(state, 't', 80, undefined).length).toBe(3 + items.length);
    expect(renderLines(state, 't', 80).length).toBe(3 + items.length);
  });
});

// AN ESCAPE SEQUENCE THAT ARRIVES IN TWO PIECES. `\x1b` then `[B` is one arrow key, split by ssh, a
// loaded machine, or a multiplexer. Three behaviours, in order of how bad they were:
//   the first decoder said `cancel`  — a split arrow quit `gnl init`
//   the second said nothing         — the key vanished and the cursor did not move
//   this one carries the tail       — the key arrives, one read late
describe('a keypress split across two reads', () => {
  const feed = (...chunks: string[]) => {
    let carry = '';
    const keys: string[] = [];
    for (const c of chunks) {
      const r = decodeStream(c, carry);
      carry = r.carry;
      keys.push(...r.keys);
    }
    return { keys, carry };
  };

  it.each([
    [['\x1b', '[B'], ['down']],
    [['\x1b[', 'B'], ['down']],
    [['\x1b', 'OB'], ['down']],      // application mode, also split
    [['\x1b', '[A'], ['up']],
    [['\x1b', '[B\x1b[B'], ['down', 'down']],
    [['a\x1b', '[A'], ['toggleAll', 'up']],
  ])('%j → %j', (chunks, expected) => {
    expect(feed(...(chunks as string[])).keys).toEqual(expected);
  });

  it('holds at most a real prefix, so a stray escape cannot wedge the prompt', () => {
    expect(feed('\x1b').carry).toBe('\x1b');
    expect(feed('\x1b[').carry).toBe('\x1b[');
    expect(feed('\x1bO').carry).toBe('\x1bO');
    expect(feed('\x1b', 'z').carry, 'an orphan escape is discarded once the next read disagrees').toBe('');
    expect(feed('hello').carry).toBe('');
  });

  it('a complete chunk behaves exactly as it did before', () => {
    expect(feed('\x1b[B').keys).toEqual(['down']);
    expect(feed('\r').keys).toEqual(['enter']);
    expect(feed('q').keys).toEqual(['cancel']);
  });
});
