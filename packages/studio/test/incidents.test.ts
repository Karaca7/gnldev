// GET /runs/:id/incidents — the run's guard incidents (duplicate guard / loop detection) as
// queryable telemetry. Mirrors the /processors contract: listKeys-less journal → empty list.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { recordIncident } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('GET /runs/:id/incidents', () => {
  it('returns the run-scoped incidents oldest-first (and ONLY that run’s)', async () => {
    const journal = new InMemoryJournal();
    await recordIncident(journal, 'r1', {
      at: 2, source: 'loop-detection', action: 'block', toolName: 'charge', toolCallId: 'c-2',
      message: 'loop detected', detail: { repeats: 3 },
    });
    await recordIncident(journal, 'r1', {
      at: 1, source: 'duplicate-guard', action: 'warn', toolName: 'charge', toolCallId: 'c-1',
      message: 'about to EXECUTE AGAIN',
    });
    await recordIncident(journal, 'r2', {
      at: 3, source: 'duplicate-guard', action: 'suspend', toolName: 'charge', toolCallId: 'c-9',
      message: 'other run — must NOT leak',
    });

    const app = createStudioApi({ reader: journal });
    const res = await call(app, '/runs/r1/incidents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toHaveLength(2);
    expect(body.incidents.map((i: any) => i.toolCallId)).toEqual(['c-1', 'c-2']); // oldest first
    expect(body.incidents[0]).toMatchObject({ source: 'duplicate-guard', action: 'warn', message: 'about to EXECUTE AGAIN' });
  });

  it('a run with no incidents → empty list (not an error)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const body = await (await call(app, '/runs/nope/incidents')).json();
    expect(body.incidents).toEqual([]);
  });
});
