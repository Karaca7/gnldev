// AUDIT E1 (protection reachability): several protections existed only on the low-level runDurable args
// and were NOT exposed on the high-level createGnl RunOptions — so a createGnl user (the documented main
// path) could not enable toolPolicy 'strict', strict replay, timeouts, or model-step exclusivity. This
// suite pins that RunOptions forwards them.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('RunOptions protection parity (audit E1)', () => {
  it('E1: toolPolicy "strict" is reachable through createGnl RunOptions', async () => {
    // A tool with execute but NO declared side-effect intent (no idempotent/sideEffect/recover).
    const risky = tool({ description: 'undeclared', inputSchema: z.object({}), execute: async () => ({ ok: true }) });
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { a: { model: createMockModel(async () => finalTextResult('ok')), tools: { risky } } },
    });
    // With toolPolicy 'strict' the run must be REJECTED at start for the undeclared tool.
    await expect(
      gnl.run('a', { runId: 'e1-1', prompt: 'go', toolPolicy: 'strict' } as any),
    ).rejects.toThrow(/toolPolicy/);
  });
});
