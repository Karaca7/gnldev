// @gnldev/memory presets: defaultEmbed is deterministic/normalized + memoryPreset produces a working AgentMemory.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory, defaultEmbed, createDefaultEmbed, memoryPreset } from '../src/index.js';

describe('defaultEmbed', () => {
  it('deterministic + L2-normalize', async () => {
    const a = await defaultEmbed('hello world');
    const b = await defaultEmbed('hello world');
    expect(a).toEqual(b);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5);
    const c = await defaultEmbed('a completely different sentence');
    expect(c).not.toEqual(a);
  });

  it('createDefaultEmbed with a custom size', async () => {
    const v = await createDefaultEmbed(16)('hi');
    expect(v).toHaveLength(16);
  });

  it('empty text → zero vector (normalize does not blow up)', async () => {
    const v = await defaultEmbed('');
    expect(v.every((x) => x === 0)).toBe(true);
  });
});

describe('memoryPreset', () => {
  it('chat / recall → AgentMemory', () => {
    expect(memoryPreset(new InMemoryStorage(), 'chat')).toBeInstanceOf(AgentMemory);
    expect(memoryPreset(new InMemoryStorage(), 'recall')).toBeInstanceOf(AgentMemory);
  });

  it("the old 'assistant' value throws, and the message says what to write instead", () => {
    // Renamed because the word was carrying two unrelated axes. `preset: 'assistant'` on a gnl config
    // decides what a REPEATED SIDE EFFECT does; this one decided how much conversation history is
    // recalled. Two switches, one word, no relationship — and a reader who had just learned the first
    // meaning had every reason to assume the second.
    //
    // A throw rather than a silent alias: an alias keeps the collision alive in every project that
    // uses it, which is the state this rename exists to end. The value was a config-time argument, so
    // the failure is at wiring time, not mid-run.
    expect(() => memoryPreset(new InMemoryStorage(), 'assistant' as never)).toThrow(/renamed to 'recall'/);
  });

  it('preset thread CRUD + append + getMessages works', async () => {
    const mem = memoryPreset(new InMemoryStorage(), 'chat');
    const t = await mem.createThread({ resourceId: 'u1', title: 't' });
    await mem.append(t.id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const msgs = await mem.getMessages(t.id, {});
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});
