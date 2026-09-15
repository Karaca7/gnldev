// The IMPURE half of prompt.ts — checkboxPrompt/selectPrompt: raw-stdin wiring, the ANSI redraw,
// and the cleanup path. prompt.test.ts covers the pure reducer; this covers the shell around it by
// swapping process.stdin/stdout for fakes, so the terminal contract (raw mode restored, cursor shown
// again, listener removed) is asserted instead of assumed.
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { checkboxPrompt, selectPrompt } from '../src/prompt.js';

const ESC = '\x1b';

class FakeStdin extends EventEmitter {
  isRaw = false;
  rawCalls: boolean[] = [];
  resumed = 0;
  paused = 0;
  encoding: string | undefined;
  setRawMode(v: boolean): this {
    this.isRaw = v;
    this.rawCalls.push(v);
    return this;
  }
  resume(): this {
    this.resumed++;
    return this;
  }
  pause(): this {
    this.paused++;
    return this;
  }
  setEncoding(e: string): this {
    this.encoding = e;
    return this;
  }
}

// An EventEmitter, because a real stdout is one and the prompt now listens to it for 'resize'.
// It was a plain object, so `output.on?.('resize', …)` silently did nothing here — the optional call
// that makes the fake work is also the one that would have hidden a missing listener.
class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  columns = 80;
  rows = 24;
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  /** What a terminal does when the window changes: new size, then the event. */
  resizeTo(columns: number, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

const items = [
  { id: 'memory', label: 'Memory' },
  { id: 'rag', label: 'RAG', hint: 'vector store' },
  { id: 'auth', label: 'Auth' },
];

const originals = { stdin: process.stdin, stdout: process.stdout };
function install(): { input: FakeStdin; output: FakeStdout } {
  const input = new FakeStdin();
  const output = new FakeStdout();
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process, 'stdout', { value: output, configurable: true });
  return { input, output };
}
afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: originals.stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: originals.stdout, configurable: true });
});

/** Feeds keys one per microtask turn so each redraw completes before the next key. */
async function type(input: FakeStdin, keys: string[]): Promise<void> {
  for (const k of keys) {
    input.emit('data', k);
    await Promise.resolve();
  }
}

describe('checkboxPrompt (TTY shell)', () => {
  it('space toggles under the cursor, enter resolves the selection in item order', async () => {
    const { input } = install();
    const p = checkboxPrompt(items, { title: 'Features' });
    await type(input, [' ', `${ESC}[B`, `${ESC}[B`, ' ', '\r']); // check memory, ↓↓, check auth, enter
    expect(await p).toEqual(['memory', 'auth']);
  });

  it('q cancels → undefined (NOT an empty selection, which would mean "chose nothing")', async () => {
    const { input } = install();
    const p = checkboxPrompt(items);
    await type(input, [' ', 'q']);
    expect(await p).toBeUndefined();
  });

  it('preChecked seeds the initial state; enter with no keypress returns it unchanged', async () => {
    const { input } = install();
    const p = checkboxPrompt(items, { preChecked: ['rag'] });
    await type(input, ['\r']);
    expect(await p).toEqual(['rag']);
  });

  it("'a' toggles all on, then all off", async () => {
    const { input } = install();
    const p = checkboxPrompt(items);
    await type(input, ['a', '\r']);
    expect(await p).toEqual(['memory', 'rag', 'auth']);

    const { input: i2 } = install();
    const p2 = checkboxPrompt(items);
    await type(i2, ['a', 'a', '\r']);
    expect(await p2).toEqual([]);
  });

  it('unrecognized keys are ignored and do not redraw or resolve', async () => {
    const { input, output } = install();
    const p = checkboxPrompt(items);
    const before = output.chunks.length;
    await type(input, ['z', '\x07', 'Z']);
    expect(output.chunks.length).toBe(before); // no redraw for a key the decoder doesn't know
    await type(input, ['\r']);
    expect(await p).toEqual([]);
  });

  it('renders the title, the key hints, and a marked row for every item', async () => {
    const { input, output } = install();
    const p = checkboxPrompt(items, { title: 'Pick features' });
    await type(input, ['\r']);
    await p;
    const text = output.text;
    expect(text).toContain('Pick features');
    expect(text).toContain('space toggle');
    for (const it of items) expect(text).toContain(it.label);
    expect(text).toContain('vector store'); // the hint is rendered
    expect(text).toContain(`${ESC}[?25l`); // cursor hidden on entry
  });

  it('restores the terminal on exit: raw mode back to its previous value, cursor shown, stdin paused, listener removed', async () => {
    const { input, output } = install();
    input.isRaw = false;
    const p = checkboxPrompt(items);
    expect(input.rawCalls[0]).toBe(true); // raw mode entered
    expect(input.resumed).toBe(1);
    expect(input.encoding).toBe('utf8');
    await type(input, ['\r']);
    await p;
    expect(input.rawCalls.at(-1)).toBe(false); // restored to the PREVIOUS value, not hardcoded
    expect(input.paused).toBe(1);
    expect(input.listenerCount('data')).toBe(0); // no leaked listener for the next prompt
    expect(output.text.endsWith(`${ESC}[?25h`)).toBe(true); // cursor shown again
  });

  it('an already-raw stdin is restored to RAW, not to cooked', async () => {
    const { input } = install();
    input.isRaw = true;
    const p = checkboxPrompt(items);
    await type(input, ['\r']);
    await p;
    expect(input.rawCalls.at(-1)).toBe(true);
  });
});

describe('selectPrompt (single-select on top of the same shell)', () => {
  it('returns the first (and only) picked id', async () => {
    const { input } = install();
    const p = selectPrompt(items, { title: 'Pick one' });
    await type(input, [`${ESC}[B`, ' ', '\r']);
    expect(await p).toBe('rag');
  });

  it('enter alone takes what the cursor is on — arrow-then-Enter is an answer', async () => {
    // The contract this replaced: Enter on an unmarked list meant "none of them", and the first
    // person to use `gnl init` outside this repo moved to a row, pressed Enter, and was told all
    // decisions took their default. Every scaffolder they had used answers arrow-then-Enter.
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, ['\r']);
    expect(await p).toBe(items[0]!.id);
  });

  it('…and after moving, it takes THAT row', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, [`${ESC}[B`, '\r']);
    expect(await p).toBe(items[1]!.id);
  });

  it('space still marks, and a marked row wins over the cursor', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    // mark row 0, then move away without marking: the marked one is the answer.
    await type(input, [' ', `${ESC}[B`, '\r']);
    expect(await p).toBe(items[0]!.id);
  });

  it('space is a radio in single mode — the mark moves rather than accumulating', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, [' ', `${ESC}[B`, ' ', '\r']);
    expect(await p).toBe(items[1]!.id);
  });

  it('cancelling → undefined', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, ['\x03']); // Ctrl-C
    expect(await p).toBeUndefined();
  });

  it('if several get checked, the FIRST in item order wins (single-answer contract)', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, ['a', '\r']); // check everything
    expect(await p).toBe('memory');
  });
});

// RESIZING THE WINDOW WHILE THE PROMPT IS OPEN. `draw()` reads the width every time it runs, which
// made the code LOOK resize-aware; nothing ever ran it between keypresses. So widening the terminal
// left every row truncated at the old narrow width, and the reader's reasonable conclusion — the
// program is stuck — was wrong in a way nothing on screen corrected.
//
// Reported by a reader making the window bigger and watching. No test here had ever changed a size.
describe('the window changes while the prompt is open', () => {
  it('a resize repaints, without a key being pressed', async () => {
    const { input, output } = install();
    const p = checkboxPrompt(items, { title: 'pick' });
    await Promise.resolve();
    const before = output.chunks.length;
    output.resizeTo(120);
    await Promise.resolve();
    expect(output.chunks.length, 'nothing was redrawn — the block keeps the old width until a keypress').toBeGreaterThan(before);
    input.emit('data', '\r');
    await p;
  });

  it('widening un-truncates the rows', async () => {
    const { input, output } = install();
    const long = [{ id: 'a', label: 'an option whose label is comfortably longer than forty columns of terminal' }];
    const p = checkboxPrompt(long, { title: 'pick' });
    await Promise.resolve();
    output.chunks.length = 0;
    output.resizeTo(30);
    await Promise.resolve();
    const narrow = output.text;
    output.chunks.length = 0;
    output.resizeTo(200);
    await Promise.resolve();
    const wide = output.text;
    expect(narrow).toContain('…');
    expect(wide, 'the wider frame still shows the truncation from the narrow one').not.toContain('…');
    input.emit('data', '\r');
    await p;
  });

  it('a shrinking block leaves no ghost rows behind it', async () => {
    // Fewer options fit after the window gets shorter — or more fit after it gets taller and the
    // block gets SHORTER because nothing is hidden any more. Either way the previous frame wrote
    // rows below the new one, and they stayed on screen as a second copy of the list.
    const { input, output } = install();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 'i' + i, label: 'option ' + i }));
    const p = checkboxPrompt(many, { title: 'pick' });
    await Promise.resolve();
    output.resizeTo(80, 8);          // tall list → windowed, few rows
    await Promise.resolve();
    output.chunks.length = 0;
    output.resizeTo(80, 30);         // now everything fits: MORE rows, then back to fewer
    await Promise.resolve();
    output.chunks.length = 0;
    output.resizeTo(80, 8);          // block shrinks again — the ghost case
    await Promise.resolve();
    const frame = output.text;
    // Every line the repaint writes is cleared first; the cleanup rows are bare `[2K` with nothing.
    const cleared = (frame.match(/\x1b\[2K/g) ?? []).length;
    const written = (frame.match(/\x1b\[2K[^\n]/g) ?? []).length;
    expect(cleared, 'the rows the taller frame wrote below the new block were never blanked').toBeGreaterThan(written);
    input.emit('data', '\r');
    await p;
  });

  it('the resize listener is removed when the prompt closes', async () => {
    const { input, output } = install();
    const p = checkboxPrompt(items, { title: 'pick' });
    await Promise.resolve();
    expect(output.listenerCount('resize')).toBe(1);
    input.emit('data', '\r');
    await p;
    expect(output.listenerCount('resize'), 'a prompt that closes must not keep repainting').toBe(0);
  });
});
