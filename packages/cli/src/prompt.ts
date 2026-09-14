// Zero-dependency multi-select checkbox for the TTY (no inquirer/prompts/enquirer).
//
// The SELECTION LOGIC is a pure reducer(state, key) → state — fully unit-testable without a TTY.
// A thin shell (checkboxPrompt) does the impure parts: put stdin in raw mode, decode keypresses into
// key events, render the list with the shared ANSI helpers, and loop until the reducer says done.

import { bold, cyan, dim, green } from './ansi.js';

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
 */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
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
  const visible = visibleLength(line);
  if (visible <= width) return line;
  let out = '';
  let seen = 0;
  const budget = Math.max(1, width - 1); // room for the ellipsis
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\x1b') {                    // copy the whole escape, it costs no columns
      const end = line.indexOf('m', i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (seen >= budget) break;
    out += ch;
    seen++;
  }
  return `${out}…${ESC}[0m`;
}

export function renderLines(state: SelectState, title: string, width = 80): string[] {
  const lines = [
    bold(title),
    dim(state.single
      ? '  ↑/↓ move · enter choose · q cancel'
      : '  ↑/↓ move · space toggle · a all/none · enter confirm · q cancel'),
    '',
  ];
  state.items.forEach((it, i) => {
    const on = state.checked.has(it.id);
    const pointer = i === state.cursor ? cyan('❯') : ' ';
    const box = on ? green('◉') : '◯';
    const hint = it.hint ? ' ' + dim(`(${it.hint})`) : '';
    const label = i === state.cursor ? bold(it.label) : it.label;
    lines.push(`${pointer} ${box} ${label}${hint}`);
  });
  return lines.map((l) => clamp(l, width));
}

/** Maps a raw stdin chunk to a Key (or undefined if it isn't a recognized control). */
export function decodeKey(chunk: string): Key | undefined {
  if (chunk === '\x03' || chunk === 'q' || chunk === '\x1b') return 'cancel'; // Ctrl-C / q / Esc
  if (chunk === '\r' || chunk === '\n') return 'enter';
  if (chunk === ' ') return 'space';
  if (chunk === 'a' || chunk === 'A') return 'toggleAll';
  if (chunk === `${ESC}[A` || chunk === 'k') return 'up';
  if (chunk === `${ESC}[B` || chunk === 'j') return 'down';
  return undefined;
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
    const lines = renderLines(state, title, (output.columns ?? 80) - 1);
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
    const onData = (chunk: string): void => {
      const key = decodeKey(chunk);
      if (!key) return;
      state = reducer(state, key);
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
