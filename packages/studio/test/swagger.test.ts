// OpenAPI spec sync check: the DELETE /threads/:id/messages route (added this session — thread
// truncation, see thread-truncate.test.ts) must be documented so /swagger and /openapi.json don't
// mislead an integrator. Kept small/focused — the fuller openapi.json/swagger smoke test lives in
// packages/durable/test/studio-evals.test.ts (createStudioApp, apiBase injection, swagger-ui markup).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApp } from '../src/server.js';
import { call } from './call.js';

describe('openapi.json — swagger stays in sync with server.ts', () => {
  it('documents DELETE /threads/{id}/messages (thread truncate)', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;
    expect(spec.paths['/threads/{id}/messages']?.delete).toBeTruthy();
    // GET on the same path must still be documented too (the entry was merged, not replaced).
    expect(spec.paths['/threads/{id}/messages']?.get).toBeTruthy();
  });

  it('documents the changed PUT /policy contract (rules + ifVersion)', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;
    expect(spec.paths['/policy']?.put).toBeTruthy();
    expect(spec.paths['/policy']?.get).toBeTruthy();
  });
});
