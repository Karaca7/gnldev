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

  /**
   * The published shape of `cursor` is the one thing here that cannot be corrected later for free.
   *
   * It was declared `integer`, which described the current implementation rather than the contract.
   * An integrator who believed it could compute `cursor = page * limit`, and the server has already
   * changed what that arithmetic means once; the fix that closes paging drift for good replaces the
   * value with a `created_at`+`runId` key, i.e. not a number at all. Publishing `integer` and then
   * doing that is a breaking change for every such caller — publishing "opaque, echo it back" costs
   * nothing and makes the same change invisible.
   *
   * So this pins the contract, not the encoding: a string, and a description that tells the reader
   * not to build one. If a future change narrows the type again, this fails and the person doing it
   * has to decide deliberately rather than by omission.
   */
  it('publishes `cursor` as an opaque token, not a number', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;

    // Every paginated route, not just the one that prompted this — a single `integer` left behind
    // would be the one an integrator reads.
    const paged = ['/runs', '/workflows/runs'];
    for (const path of paged) {
      const cursor = (spec.paths[path]?.get?.parameters ?? []).find((p: any) => p.name === 'cursor');
      expect(cursor, `${path} should document a cursor parameter`).toBeTruthy();
      expect(cursor.schema?.type, `${path} cursor must not be typed as a number`).toBe('string');
      expect(String(cursor.description ?? ''), `${path} cursor must be documented as opaque`).toMatch(/opaque/i);
    }
  });
});
