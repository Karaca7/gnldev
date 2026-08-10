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

class FakeStdout {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
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

  it('picking nothing → null (distinct from cancelling)', async () => {
    const { input } = install();
    const p = selectPrompt(items);
    await type(input, ['\r']);
    expect(await p).toBeNull();
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
