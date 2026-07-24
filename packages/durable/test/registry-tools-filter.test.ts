// Playground tool allow-list: `RunOptions.tools` restricts which of the agent's resolved tools reach
// the model this run (Studio Playground config panel switches). The model's doGenerate captures the
// tool set it was handed → we assert exactly the allowed subset is present.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('registry: Playground tool allow-list (opts.tools)', () => {
  const mkTool = () => tool({ description: 't', inputSchema: z.object({ q: z.string().optional() }), execute: async () => 'ok' });

  function setup() {
    let seen: string[] = [];
    const model = createMockModel(async (options: any) => {
      seen = (options.tools ?? []).map((t: any) => t?.name).sort();
      return finalTextResult('done');
    });
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { multi: { model, tools: { alpha: mkTool(), beta: mkTool() } } },
    });
    return { gnl, getSeen: () => seen };
  }

  it('no allow-list → the model sees ALL of the agent tools', async () => {
    const { gnl, getSeen } = setup();
    await gnl.run('multi', { runId: 'r-all', prompt: 'hi' });
    expect(getSeen()).toEqual(['alpha', 'beta']);
  });

  it('allow-list → only the requested subset reaches the model', async () => {
    const { gnl, getSeen } = setup();
    await gnl.run('multi', { runId: 'r-alpha', prompt: 'hi', tools: ['alpha'] });
    expect(getSeen()).toEqual(['alpha']);
  });

  it('empty allow-list (all tools toggled off) → the model sees NO tools', async () => {
    const { gnl, getSeen } = setup();
    await gnl.run('multi', { runId: 'r-none', prompt: 'hi', tools: [] });
    expect(getSeen()).toEqual([]);
  });
});
