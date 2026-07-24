// Studio /runs/:id/network endpoint: reads the dynamic tree (route decisions + step results) that
// runNetwork freezes into the journal. (createStudioApp + InMemoryJournal — the studio-side view of
// the flow in network.test.ts.)
import { describe, it, expect } from 'vitest';
import { createStudioApp } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { runNetwork } from '../src/network.js';
import { createMockModel, finalTextResult } from './mock.js';

function scriptedRouter(answers: string[]) {
  let i = 0;
  return createMockModel(async () => finalTextResult(answers[Math.min(i++, answers.length - 1)]!));
}

describe('studio network trace endpoint', () => {
  it('returns dynamic tree JSON after a network run', async () => {
    const journal = new InMemoryJournal();
    await runNetwork({
      runId: 'net-run', journal,
      routerModel: scriptedRouter([
        JSON.stringify({ action: 'route', agent: 'ara', task: 'find sources' }),
        JSON.stringify({ action: 'final', answer: 'summary' }),
      ]),
      agents: { ara: { description: 'searcher', run: async () => ({ text: '3 sources' }) } },
      task: 'research',
    });

    const app = createStudioApp({ reader: journal });
    const res = (await (await app.request('/api/runs/net-run/network')).json()) as any;
    expect(res.routes).toHaveLength(2);
    expect(res.routes[0].decision).toEqual({ action: 'route', agent: 'ara', task: 'find sources' });
    expect(res.routes[1].decision.action).toBe('final');
    expect(res.steps).toEqual([{ i: 0, agent: 'ara', task: 'find sources', text: '3 sources' }]);
  });

  it('run with no network record → empty tree (not an error)', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const res = (await (await app.request('/api/runs/none-at-all/network')).json()) as any;
    expect(res).toEqual({ routes: [], steps: [] });
  });
});
