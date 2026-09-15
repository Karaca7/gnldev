// Zero-dependency multi-select checkbox for the TTY (no inquirer/prompts/enquirer).
//
// The SELECTION LOGIC is a pure reducer(state, key) → state — fully unit-testable without a TTY.
// A thin shell (checkboxPrompt) does the impure parts: put stdin in raw mode, decode keypresses into
// key events, render the list with the shared ANSI helpers, and loop until the reducer says done.

import { bold, cyan, dim, green, displayWidth, truncateToWidth } from './ansi.js';

export interface PromptItem {
  id: string;
  label: string;
  hint?: string;
}

/** Abstract keys the reducer understands (the raw-stdin decoder maps bytes → these). */
export type Key = 'up' | 'down' | 'space' | 'toggleAll' | 'enter' | 'cancel';

export interface SelectState {
  items: PromptItem[];
  cursor: number;
  checked: Set<string>;
  done: boolean;
  cancelled: boolean;
  /**
   * One answer, not a set. Two behaviours change: SPACE moves the mark instead of adding to it, and
   * ENTER on an unmarked list takes whatever the cursor is on.
   *
   * That second half is a bug fix with a name. Every scaffolder people have used — create-vue,
   * create-next-app, nuxi — answers arrow-then-Enter, so that is what fingers do; here Enter only
   * meant "confirm", and confirming an unmarked list meant "none of them". Measured on the first
   * outside run of this command: the reader moved to "Let me choose", pressed Enter, and got the
   * recommended defaults with a line saying so. The prompt did exactly what it said in its header
   * and exactly not what was asked of it.
   */
  single: boolean;
}

export function initState(
  items: PromptItem[],
  preChecked: Iterable<string> = [],
  opts: { single?: boolean } = {},
): SelectState {
  return { items, cursor: 0, checked: new Set(preChecked), done: false, cancelled: false, single: !!opts.single };
}

/**
 * Pure state transition. Never mutates the input (returns a fresh state) so it's trivially testable.
 * Terminal states: `done` (enter) or `cancelled` (q / Ctrl-C) — further keys are no-ops.
 */
export function reducer(state: SelectState, key: Key): SelectState {
  if (state.done || state.cancelled) return state;
  const n = state.items.length;
  switch (key) {
    case 'up':
      return { ...state, cursor: n === 0 ? 0 : (state.cursor - 1 + n) % n };
    case 'down':
      return { ...state, cursor: n === 0 ? 0 : (state.cursor + 1) % n };
    case 'space': {
      const item = state.items[state.cursor];
      if (!item) return state;
      // Single-answer lists behave like radio buttons: the mark MOVES. Toggling into a second one
      // would let a reader select two answers to "where does the journal live?" and then discover
      // which one won by reading the generated config.
      if (state.single) return { ...state, checked: new Set(state.checked.has(item.id) ? [] : [item.id]) };
      const checked = new Set(state.checked);
      if (checked.has(item.id)) checked.delete(item.id);
      else checked.add(item.id);
      return { ...state, checked };
    }
    case 'toggleAll': {
      // `a` is a multi-select convenience; on a one-answer list it would mean "choose all three
      // presets", so it is simply not a key there.
      if (state.single) return state;
      // If everything is already checked → clear all; otherwise → check all.
      const allChecked = n > 0 && state.items.every((it) => state.checked.has(it.id));
      const checked = new Set(allChecked ? [] : state.items.map((it) => it.id));
      return { ...state, checked };
    }
    case 'enter': {
      // THE FIX: arrow-then-Enter is an answer. Only when nothing is marked, so a reader who did
      // press SPACE still gets exactly what they marked, and a multi-select Enter on an empty list
      // still means "none".
      const item = state.items[state.cursor];
      if (state.single && state.checked.size === 0 && item) {
        return { ...state, checked: new Set([item.id]), done: true };
      }
      return { ...state, done: true };
    }
    case 'cancel':
      return { ...state, cancelled: true };
    default:
      return state;
  }
}

/** The ordered list of selected ids (input order preserved), for a done state. */
export function selection(state: SelectState): string[] {
  return state.items.filter((it) => state.checked.has(it.id)).map((it) => it.id);
}

// --- Impure shell (TTY render + raw stdin) — covered by prompt-shell.test.ts, which swaps
//      process.stdin/stdout for fakes and asserts the terminal contract (raw mode restored to its
// PREVIOUS value, cursor re-shown, stdin paused, no leaked 'data' listener). ----

const ESC = '\x1b';

/**
 * Visible length: ANSI colour sequences cost bytes and no columns, and every line here is coloured.
 *
 * Delegates to `displayWidth`, which also knows that a CJK character costs TWO columns and a
 * combining mark costs none. Counting UTF-16 units here meant a wide label measured as fitting and
 * then wrapped on screen — putting the repaint back into exactly the state `clamp` exists to
 * prevent, for anyone whose language is not Latin.
 */
function visibleLength(s: string): number {
  return displayWidth(s);
}

/**
 * Clamp a line to the terminal width, counting only what is actually visible.
 *
 * THE BUG THIS FIXES, because it is not obvious from the symptom. `draw()` repaints by moving the
 * cursor up by the number of lines it last wrote — which is only correct while one logical line
 * occupies one screen row. A row wider than the terminal WRAPS, taking two rows, so the cursor comes
 * up short and the next repaint lands below the old one: the header reappears on every keypress and
 * marches down the screen. Measured on the preset question, whose longest option + hint is 110
 * characters, in an 80-column terminal — nineteen copies of the title before the reader gave up.
 *
 * Truncating (rather than wrapping deliberately) keeps the arithmetic trivially correct at any width,
 * and the ellipsis tells the reader the sentence continues. The hints are written to be readable to
 * their first clause for exactly this reason.
 */
function clamp(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  // `truncateToWidth` walks code points, so a surrogate pair moves as one unit — the old loop
  // indexed UTF-16 units and could stop between the halves of an emoji, emitting a lone `\ud83d`.
  // The reset is appended here rather than there because this is the caller that guarantees every
  // line is coloured, and an unterminated sequence bleeds into the row below.
  return `${truncateToWidth(line, width)}${ESC}[0m`;
}

/**
 * The width to render into, from a stream that may not know its own.
 *
 * `||` and not `??`: a terminal can report `isTTY: true` with `columns: 0`. Measured under
 * `script(1)`, and the same shape appears in CI runners and container TTYs that allocate a terminal
 * without ever sending a window size. `0 ?? 80` is 0, so the width arrived as -1, `clamp` fell to
 * its one-column floor, and every row of the prompt rendered as one character and an ellipsis —
 * `g…`, `❯…`. An unreadable prompt is an unanswerable one, and it was invisible to every test in
 * this package because they all pass a width in explicitly.
 *
 * The floor covers the other end. Below about twenty columns there is nothing worth truncating to,
 * and a wrapped line is a better failure than a line reduced to punctuation.
 *
 * A function, rather than the expression it replaced, for exactly one reason: the expression could
 * not be tested and this can.
 */
export function drawWidth(columns: number | undefined): number {
  // The ceiling is not decoration: `Infinity` and absurd values both reach here (a stream that
  // reports no size, a mocked stdout, a terminal multiplexer mid-resize), and an infinite width
  // makes `clamp` a no-op — which is how a line gets past the edge and starts the wrapping this
  // whole mechanism exists to stop. Found by attacking this function rather than by using it.
  const cols = Number.isFinite(columns) && (columns as number) > 0 ? (columns as number) : 80;
  return Math.min(400, Math.max(20, cols - 1));
}

/** Title, help line, blank — the rows above the list, which are always drawn. */
const CHROME_ROWS = 3;

/**
 * Which slice of the list fits on screen, and where the cursor sits inside it.
 *
 * THE VERTICAL HALF OF THE WRAPPING BUG. `clamp` fixed the horizontal one: a row wider than the
 * terminal takes two screen rows, so `draw()`'s "move up by the number of lines I wrote" arithmetic
 * comes up short and the header marches down the screen on every keypress. A list TALLER than the
 * terminal does exactly the same thing by a different route — the terminal scrolls, the rows written
 * are no longer the rows on screen, and the cursor-up count is wrong from the first repaint.
 *
 * Width was tested at four values. Height was never read at all: `output.rows` appears nowhere, so
 * `gnl add processors` (six options plus chrome) in a split pane or a small terminal window was the
 * same defect, unmeasured.
 *
 * So the list gets a viewport. The cursor is kept centred where it can be, pinned at the ends where
 * it cannot, and a counter line says what is out of sight — a list that silently hides options is
 * worse than one that scrolls, because the reader cannot tell the difference between "not there"
 * and "not visible".
 */
export function visibleWindow(
  count: number,
  cursor: number,
  rows: number | undefined,
  chromeRows: number = CHROME_ROWS,
): { start: number; end: number } {
  // One row is left unwritten on purpose: writing the last line of a terminal scrolls it on many
  // emulators, which is the thing being avoided.
  const budget = rows && Number.isFinite(rows) ? rows - chromeRows - 1 : Infinity;
  if (!Number.isFinite(budget) || count <= budget) return { start: 0, end: count };
  // `Math.max(1, …)` is NOT a floor to fall back on — it was, and that is how a 4-row terminal got
  // five lines: one forced option plus a counter on top of three chrome rows. When the budget
  // cannot hold even one option and its counter, the honest answer is an empty window; the caller
  // then shows the title and the counter alone, which still tells the reader where they are.
  const capacity = budget - 1; // one row for the "… n above/below" counter
  if (capacity < 1) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(cursor - Math.floor(capacity / 2), count - capacity));
  return { start, end: start + capacity };
}

export function renderLines(state: SelectState, title: string, width = 80, rows?: number): string[] {
  // Below six rows the chrome itself does not fit beside a single option, so it gives way in the
  // order it can be spared: the blank line first, then the help line. Found by attacking this
  // function with every height from 1 to 30 — the first cut treated three chrome rows as fixed and
  // still wrote five lines into a four-row terminal, which is the overflow it was written to stop.
  // A title is the one row that cannot go: without it the reader does not know what is being asked.
  const help = dim(state.single
    ? '  ↑/↓ move · enter choose · q cancel'
    : '  ↑/↓ move · space toggle · a all/none · enter confirm · q cancel');
  const lines = !rows || rows >= 6 ? [bold(title), help, '']
    : rows >= 4 ? [bold(title), help]
    : [bold(title)];
  const { start, end } = visibleWindow(state.items.length, state.cursor, rows, lines.length);
  state.items.slice(start, end).forEach((it, offset) => {
    const i = start + offset;
    const on = state.checked.has(it.id);
    const pointer = i === state.cursor ? cyan('❯') : ' ';
    const box = on ? green('◉') : '◯';
    const hint = it.hint ? ' ' + dim(`(${it.hint})`) : '';
    const label = i === state.cursor ? bold(it.label) : it.label;
    lines.push(`${pointer} ${box} ${label}${hint}`);
  });
  const hiddenAbove = start;
  const hiddenBelow = state.items.length - end;
  if (hiddenAbove || hiddenBelow) {
    const parts = [hiddenAbove ? `${hiddenAbove} above` : '', hiddenBelow ? `${hiddenBelow} below` : ''].filter(Boolean);
    lines.push(dim(`  … ${parts.join(', ')} — ↑/↓ to reach them`));
  }
  // THE LAST WORD ON HEIGHT, and deliberately a dumb one. Everything above computes a fitting
  // window, and a computation that is wrong by one row puts the terminal back into scrolling — the
  // exact failure this file keeps returning to. So the arithmetic is checked by a truncation that
  // cannot be wrong: whatever was decided, the block never exceeds the rows it was given. If this
  // ever actually cuts something, the window maths has a bug — but the reader still gets a prompt
  // that repaints in place instead of a header walking down their screen.
  const fitted = rows && Number.isFinite(rows) ? lines.slice(0, Math.max(1, rows)) : lines;
  return fitted.map((l) => clamp(l, width));
}

/** Maps a raw stdin chunk to a Key (or undefined if it isn't a recognized control). */
/**
 * Every key in one read from the terminal — because a read is not a keystroke.
 *
 * The first version compared the whole chunk for equality, and four real inputs measured as broken:
 *
 *   `\x1b[B\x1b[B`  holding ↓ down. Node coalesces repeats into ONE chunk; equality matched none
 *                   of them, so the cursor did not move at all while the key was held.
 *   `\r\n`          Enter, on a pty that sends CRLF. Equality matched neither `\r` nor `\n`:
 *                   Enter was simply dead there.
 *   `\x1bOB`        ↓ in APPLICATION cursor mode — what tmux and PuTTY send. Unrecognised.
 *   `\x1b` alone    the first byte of an arrow key, arriving in its own chunk on a slow or remote
 *                   pty. This one was the dangerous one: it decoded as `cancel`, so pressing an
 *                   arrow could abandon `gnl init`.
 *
 * So the chunk is SCANNED rather than compared, and a lone ESC no longer cancels. Cancelling has two
 * documented keys — `q` and Ctrl-C, both named in the help line — and ESC is not one of them, so
 * treating a stray escape byte as "the user wants out" was inventing an instruction nobody gave.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    // CSI (`\x1b[A`) and SS3 (`\x1bOA`) — the same arrow, two modes, both in the wild.
    const seq = /^\x1b(?:\[|O)([A-D])/.exec(chunk.slice(i));
    if (seq) {
      if (seq[1] === 'A') keys.push('up');
      else if (seq[1] === 'B') keys.push('down');
      // C/D are left/right: nothing to do in a vertical list, and swallowing them beats
      // letting the bare bytes fall through to the letter cases below (`D` is not `toggleAll`).
      i += seq[0].length;
      continue;
    }
    const ch = chunk[i]!;
    i += 1;
    if (ch === '\x03' || ch === 'q' || ch === 'Q') keys.push('cancel');
    else if (ch === '\r' || ch === '\n') {
      keys.push('enter');
      if (ch === '\r' && chunk[i] === '\n') i += 1;  // CRLF is one Enter, not two
    }
    else if (ch === ' ') keys.push('space');
    else if (ch === 'a' || ch === 'A') keys.push('toggleAll');
    else if (ch === 'k') keys.push('up');
    else if (ch === 'j') keys.push('down');
    // Anything else — including a lone ESC and the tail of a sequence we do not handle — is dropped.
  }
  return keys;
}

/** The first key in a chunk. Kept for callers that read one keystroke at a time. */
export function decodeKey(chunk: string): Key | undefined {
  return decodeKeys(chunk)[0];
}

/**
 * A read that can end mid-sequence, and the piece to hand to the next one.
 *
 * `decodeKeys` is pure and complete over a whole chunk, which leaves one case it cannot answer: an
 * escape sequence SPLIT across two reads. `\x1b` + `[B` is one arrow key arriving in two pieces —
 * which happens over ssh, on a loaded machine, inside some multiplexers. Decoding each piece alone
 * threw the key away, so the cursor simply did not move and nothing said why. (The version before
 * that was worse: the lone `\x1b` decoded as `cancel`, so a split arrow key quit `gnl init`.)
 *
 * So the tail is carried instead of dropped. Only a genuine prefix is held — `\x1b`, `\x1b[`,
 * `\x1bO` — and at most those two characters, so a stray escape byte cannot wedge the prompt: the
 * next read either completes it or produces its own keys with the orphan quietly discarded.
 */
export function decodeStream(chunk: string, carry = ''): { keys: Key[]; carry: string } {
  const all = carry + chunk;
  const m = /(?:\x1b|\x1b\[|\x1bO)$/.exec(all);
  const head = m ? all.slice(0, m.index) : all;
  return { keys: decodeKeys(head), carry: m ? m[0] : '' };
}

/**
 * Interactive multi-select. ONLY call this when stdin/stdout are a TTY (the caller guards on
 * `process.stdin.isTTY`). Resolves to the selected ids, or `undefined` if cancelled.
 */
export async function checkboxPrompt(
  items: PromptItem[],
  opts: { title?: string; preChecked?: Iterable<string>; single?: boolean } = {},
): Promise<string[] | undefined> {
  const title = opts.title ?? 'Select features';
  const input = process.stdin;
  const output = process.stdout;

  let state = initState(items, opts.preChecked, { single: opts.single });
  let prevLineCount = 0;

  const draw = (): void => {
    if (prevLineCount > 0) output.write(`${ESC}[${prevLineCount}A`); // cursor up to the block start
    // Read per draw, not once: a terminal can be resized while the prompt is open, and a stale width
    // puts the repaint arithmetic back in the state this clamp exists to prevent.
    const lines = renderLines(state, title, drawWidth(output.columns), output.rows || undefined);
    for (const line of lines) output.write(`${ESC}[2K${line}\n`); // clear line + write
    prevLineCount = lines.length;
  };

  output.write(`${ESC}[?25l`); // hide cursor
  const wasRaw = input.isRaw ?? false;
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding('utf8');
  draw();

  return await new Promise<string[] | undefined>((resolve) => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write(`${ESC}[?25h`); // show cursor
    };
    // EVERY key in the chunk, not the first: holding ↓ arrives as one read carrying several
    // sequences, and taking only the first made a held key move the cursor by one row and then
    // appear stuck. Redraw once per chunk rather than per key — the intermediate frames are never
    // seen, and drawing them is how a repaint falls behind the input that caused it.
    let carry = '';
    const onData = (chunk: string): void => {
      const decoded = decodeStream(chunk, carry);
      carry = decoded.carry;                    // an escape split across two reads finishes in the next one
      const keys = decoded.keys;
      if (!keys.length) return;
      for (const key of keys) {
        state = reducer(state, key);
        if (state.cancelled || state.done) break;  // a key after Enter belongs to whatever comes next
      }
      draw();
      if (state.cancelled) {
        cleanup();
        resolve(undefined);
      } else if (state.done) {
        cleanup();
        resolve(selection(state));
      }
    };
    input.on('data', onData);
  });
}

/**
 * Interactive single-select, built on the multi-select above rather than beside it.
 *
 * Same keys, same drawing, same cancel path — the only difference is that the answer is one id, and
 * that is enforced by pre-checking nothing and taking the first selection. A second implementation
 * would have been a second set of terminal escape bugs.
 *
 * ONLY call when stdin/stdout are a TTY (the caller guards on `process.stdin.isTTY`). Resolves to the
 * chosen id, `null` when the user picked nothing, or `undefined` if cancelled.
 */
export async function selectPrompt(
  items: PromptItem[],
  opts: { title?: string } = {},
): Promise<string | null | undefined> {
  const picked = await checkboxPrompt(items, { title: opts.title ?? 'Select one', single: true });
  if (picked === undefined) return undefined;
  return picked[0] ?? null;
}
