// Zero-dependency multi-select checkbox for the TTY (no inquirer/prompts/enquirer).
//
// The SELECTION LOGIC is a pure reducer(state, key) → state — fully unit-testable without a TTY.
// A thin shell (checkboxPrompt) does the impure parts: put stdin in raw mode, decode keypresses into
// Key events, render the list with the shared ANSI helpers, and loop until the reducer says done.

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
}

export function initState(items: PromptItem[], preChecked: Iterable<string> = []): SelectState {
  return { items, cursor: 0, checked: new Set(preChecked), done: false, cancelled: false };
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
      const checked = new Set(state.checked);
      if (checked.has(item.id)) checked.delete(item.id);
      else checked.add(item.id);
      return { ...state, checked };
    }
    case 'toggleAll': {
      // If everything is already checked → clear all; otherwise → check all.
      const allChecked = n > 0 && state.items.every((it) => state.checked.has(it.id));
      const checked = new Set(allChecked ? [] : state.items.map((it) => it.id));
      return { ...state, checked };
    }
    case 'enter':
      return { ...state, done: true };
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

// ---- Impure shell (TTY render + raw stdin) — cannot be unit-tested; exercised by hand. ----

const ESC = '\x1b';

function renderLines(state: SelectState, title: string): string[] {
  const lines = [bold(title), dim('  ↑/↓ move · space toggle · a all/none · enter confirm · q cancel'), ''];
  state.items.forEach((it, i) => {
    const on = state.checked.has(it.id);
    const pointer = i === state.cursor ? cyan('❯') : ' ';
    const box = on ? green('◉') : '◯';
    const hint = it.hint ? ' ' + dim(`(${it.hint})`) : '';
    const label = i === state.cursor ? bold(it.label) : it.label;
    lines.push(`${pointer} ${box} ${label}${hint}`);
  });
  return lines;
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
  opts: { title?: string; preChecked?: Iterable<string> } = {},
): Promise<string[] | undefined> {
  const title = opts.title ?? 'Select features';
  const input = process.stdin;
  const output = process.stdout;

  let state = initState(items, opts.preChecked);
  let prevLineCount = 0;

  const draw = (): void => {
    if (prevLineCount > 0) output.write(`${ESC}[${prevLineCount}A`); // cursor up to the block start
    const lines = renderLines(state, title);
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
