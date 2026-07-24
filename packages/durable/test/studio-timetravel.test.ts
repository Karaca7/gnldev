// M3 studio: GET /api/runs/:id/state (reconstructState + :input seed) + POST .../fork (fork+resume).
// fork → 501 on a read-only studio. (Test lives in durable: ai/zod are here.)
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { createStudioApp } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('M3 studio time-travel', () => {
  it('state endpoint + fork (live tail); read-only fork 501', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const tools = () => ({ charge: { execute: async () => ({ charged: (charges.n++, 20) }) } });
    const src = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('SRC'),
      );
    await runDurable({ runId: 'o1', journal, model: src(), tools: tools(), stopWhen: stepCountIs(6), prompt: 'x' });
    expect(charges.n).toBe(1);

    // read-only studio: fork disabled → 501
    const ro = createStudioApp(journal);
    expect((await (await ro.request('/api/capabilities')).json()).fork).toBe(false);
    const ro501 = await ro.request('/api/runs/o1/fork', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 1 }),
    });
    expect(ro501.status).toBe(501);

    // embedded studio: resume closure → fork enabled
    const app = createStudioApp({
      reader: journal,
      resume: async (runId, approvals) => {
        const r = await resumeRun(runId, {
          journal,
          model: createMockModel(async ({ prompt }: any) =>
            countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('FORK'),
          ),
          tools: tools(),
          approvals,
          stopWhen: stepCountIs(6),
        });
        return { text: r.text, interrupts: r.interrupts };
      },
    });
    expect((await (await app.request('/api/capabilities')).json()).fork).toBe(true);

    // GET state @ step 1 → :input seed (user message) + assistant(tool-call)
    const st = await (await app.request('/api/runs/o1/state?step=1')).json();
    expect(st.step).toBe(1);
    expect(st.messages.some((m: any) => m.role === 'user')).toBe(true);

    // POST fork @ step 1 → tail runs LIVE ('FORK'), prefix charge replay (no increase)
    const fr = await (
      await app.request('/api/runs/o1/fork', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 1, newRunId: 'o1-fork' }),
      })
    ).json();
    expect(fr.ok).toBe(true);
    expect(fr.newRunId).toBe('o1-fork');
    expect(fr.text).toBe('FORK'); // step 1 ran live
    expect(charges.n).toBe(1); // step 0 replay → no re-charge
  });
});
