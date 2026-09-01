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

  /**
   * The events dead-letter, and specifically that it is NOT documented under `/events`. That path is
   * the SSE change stream, and a spec that listed a dead-letter list there would send an integrator to
   * open a stream and wait forever. The topic/consumer parameters are asserted too: they are required,
   * and a spec that omits them describes a route that always 400s.
   */
  it('documents the /dead-events surface, separately from the /events SSE stream', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;

    expect(spec.paths['/dead-events']?.get, 'the dead-letter list is undocumented').toBeTruthy();
    expect(spec.paths['/dead-events/topics']?.get).toBeTruthy();
    expect(spec.paths['/dead-events/release']?.post).toBeTruthy();

    const params = (spec.paths['/dead-events'].get.parameters ?? []).map((p: any) => p.name);
    expect(params, 'the list is addressed by topic+consumer; a spec without them describes a 400').toEqual(
      expect.arrayContaining(['topic', 'consumer']),
    );

    // The SSE stream keeps its own entry and is not turned into a prefix for these.
    expect(spec.paths['/events']?.get).toBeTruthy();
    expect(Object.keys(spec.paths).filter((p) => p.startsWith('/events/')),
      'a dead-letter path was hung off the SSE stream route').toEqual([]);
  });

  /**
   * The two answers an integrator cannot discover by trying the happy path.
   *
   * The house habit is to spell the non-200s out in the summary — `DELETE /threads/{id}/messages`
   * says "200 … / 400 … / 501 …" on one line. The release route already answered 501 when the host
   * implements no `release` (a very common configuration: `listDead` alone is read-only) and 400 on a
   * partial triple, and said neither. And the dead-letter list now answers 429 while another scan is
   * running — a status a client MUST be able to plan for, since the correct response to it is to wait
   * and retry rather than to surface an error.
   */
  it('documents the statuses these two routes answer besides 200', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;

    const release = String(spec.paths['/dead-events/release'].post.summary ?? '');
    expect(release, 'a host with no `release` gets a 501 the spec never mentions').toContain('501');
    expect(release, 'a partial triple 400s and the spec does not say so').toContain('400');
    expect(release, 'the 409 documentation was lost').toContain('409');

    const list = String(spec.paths['/dead-events'].get.summary ?? '');
    expect(list, 'the concurrency refusal is undocumented — a client cannot know to retry').toContain('429');
    // The body is opt-in AND permissioned; a spec that mentions neither describes a route that
    // silently drops a field the integrator asked for.
    expect(list).toContain('payload=1');
    expect(list).toContain('payloads:read');
    // The error text is permissioned WITHOUT an opt-in — a spec that documents only the body's gate
    // describes a route that silently drops a field every client renders.
    expect(list, 'the error gate is undocumented').toContain('errorRestricted');
    expect((spec.paths['/dead-events'].get.parameters ?? []).map((p: any) => p.name))
      .toEqual(expect.arrayContaining(['payload']));
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
