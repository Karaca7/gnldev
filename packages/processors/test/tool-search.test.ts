// toolSearch — semantic tool-search (Skills/ToolSearchProcessor parity).
// Tested: topK selection, always/minScore, not narrowing when there's no query, journal memoization
// (embed doesn't run on resume), skipping a tool no longer present in the journaled selection.
import { describe, it, expect } from 'vitest';
import { toolSearch } from '../src/index.js';
import { InMemoryJournal, createProcessorCtx } from '@gnl/durable';

/** Fake embed: axis based on keyword in the text — 'weather' → [1,0], 'currency' → [0,1], neutral → [0.5,0.5]. */
const fakeEmbed = (calls?: { n: number }) => async (t: string): Promise<number[]> => {
  if (calls) calls.n++;
  if (t.includes('weather')) return [1, 0];
  if (t.includes('currency') || t.includes('rate')) return [0, 1];
  return [0.5, 0.5];
};

const TOOLS = {
  weather: { description: 'gets the weather forecast' },
  currencyRate: { description: 'converts currency rates' },
  calendar: { description: 'creates a calendar event' },
  email: { description: 'sends an email' },
};

const ctxOf = (journal: InMemoryJournal, runId: string, input?: any) =>
  ({ ...createProcessorCtx(journal, runId), input });

describe('toolSearch', () => {
  it('selects the topK tools most relevant to the last user message; always is included every time', async () => {
    const journal = new InMemoryJournal();
    const p = toolSearch({ embed: fakeEmbed(), topK: 1, always: ['email'] });
    const out = await p.processTools!(TOOLS, ctxOf(journal, 'r1', {
      messages: [{ role: 'user', content: 'what will the weather be like today?' }],
    }));
    expect(Object.keys(out).sort()).toEqual(['email', 'weather']); // 1 selection + always
  });

  it('does NOT NARROW when there is no query signal or the tool count is within topK (safe side)', async () => {
    const journal = new InMemoryJournal();
    const p = toolSearch({ embed: fakeEmbed(), topK: 2 });
    // No query:
    expect(Object.keys(await p.processTools!(TOOLS, ctxOf(journal, 'r2', {})))).toHaveLength(4);
    // Tool count is already small:
    const two = { a: { description: 'x' }, b: { description: 'y' } };
    expect(Object.keys(await p.processTools!(two, ctxOf(journal, 'r2b', { prompt: 'weather' })))).toHaveLength(2);
  });

  it('minScore: below-threshold tools are eliminated even if topK isn\'t filled', async () => {
    const journal = new InMemoryJournal();
    const p = toolSearch({ embed: fakeEmbed(), topK: 3, minScore: 0.9 });
    const out = await p.processTools!(TOOLS, ctxOf(journal, 'r3', { prompt: 'what is the currency rate?' }));
    expect(Object.keys(out)).toEqual(['currencyRate']); // only the exact-matching axis >= 0.9
  });

  it('the selection is journaled: on resume embed is NEVER called, the same subset is returned', async () => {
    const journal = new InMemoryJournal();
    const calls = { n: 0 };
    const mk = () => toolSearch({ embed: fakeEmbed(calls), topK: 1 });
    const input = { prompt: 'weather forecast' };
    const first = await mk().processTools!(TOOLS, ctxOf(journal, 'r4', input));
    const callsAfterFirst = calls.n;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await mk().processTools!(TOOLS, ctxOf(journal, 'r4', input)); // resume
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(calls.n).toBe(callsAfterFirst); // embed did NOT run again
  });

  it('a tool no longer present in the journaled selection is silently skipped (replay doesn\'t break)', async () => {
    const journal = new InMemoryJournal();
    const p = toolSearch({ embed: fakeEmbed(), topK: 2 });
    await p.processTools!(TOOLS, ctxOf(journal, 'r5', { prompt: 'weather and currency' }));
    const { weather, ...withoutWeather } = TOOLS as any; // tool set changed
    const out = await p.processTools!(withoutWeather, ctxOf(journal, 'r5', { prompt: 'weather and currency' }));
    expect(out.weather).toBeUndefined();
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });

  it('topK < 1 → early error', () => {
    expect(() => toolSearch({ embed: fakeEmbed(), topK: 0 })).toThrow(/topK must be >= 1/);
  });
});
