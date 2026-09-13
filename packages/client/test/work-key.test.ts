// The SDK learns the other half of the identity pair (package #5 of
// docs/RUNID-WORKKEY-HEYET-KARARI.md §7).
//
// The whole change is a subtraction, and it is the interesting part: `run`/`stream` have always
// generated a runId when the caller gave none, because the server demanded one and a caller who
// forgot got a 400. A caller who names WORK has not forgotten anything — generating an id for them
// would send both halves of an exclusive pair and turn a good request into a refusal. So the
// fallback now fires only when the caller named neither.
//
// The id then comes back from the server, and the client keeps its promise that `RunResult.runId` is
// always a string: the body carries it, and `X-Gnl-Run-Id` carries it when the body cannot (an error
// body has no `runId` field).
import { describe, it, expect } from 'vitest';
import { GnlClient } from '../src/index.js';

/**
 * A run id the ENGINE could actually have minted: `run1_` + 32 hex (see derivedRunId — sha256 of the
 * tuple, sliced to 32).
 *
 * This was `run1_deadbeef` — eight hex where the shape says thirty-two. Nothing in this file
 * validates the shape, so the fixture worked; the cost is that a fixture is also documentation, and
 * a short one teaches the next reader that the suffix length is incidental. It is not: the id is a
 * truncated digest, and the truncation IS the collision budget. Anywhere a real
 * `DERIVED_RUN_ID_RE` gets involved — the `#` suffix filter, the studio surfaces, `isDerivedRunId` —
 * a fixture of the wrong length silently stops being a derived id and takes the raw branch.
 */
const DERIVED = 'run1_9f2c4b7e1a05d83c6e42b98f7a103d5b';

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('GnlClient — workKey', () => {
  it('run passes the workKey and does NOT invent a runId beside it', async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, runId: DERIVED, text: 'hi', interrupts: [] });
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchMock });
    const r = await client.run('chat', { workKey: 'invoice-4471', prompt: 'hi' });
    expect(bodies[0]).toMatchObject({ workKey: 'invoice-4471', prompt: 'hi' });
    expect(bodies[0].runId).toBeUndefined();
    // The engine's id, learned from the answer — the caller never had it to send.
    expect(r.runId).toBe(DERIVED);
  });

  it('an explicit runId still wins and is still sent', async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, runId: 'mine', interrupts: [] });
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchMock });
    await client.run('chat', { runId: 'mine', prompt: 'hi' });
    expect(bodies[0].runId).toBe('mine');
  });

  it('with neither half, the generated runId is unchanged', async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, interrupts: [] });
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchMock });
    await client.run('chat', { prompt: 'hi' });
    expect(typeof bodies[0].runId).toBe('string');
    expect(bodies[0].runId.length).toBeGreaterThan(0);
    expect(bodies[0].workKey).toBeUndefined();
  });

  it('a refusal has no runId in its body — the header answers instead', async () => {
    const fetchMock = (async () =>
      jsonResponse(
        { error: 'same key, different content', code: 'run_input_mismatch', detail: { workKey: 'invoice-4471' } },
        { status: 409, headers: { 'X-Gnl-Run-Id': DERIVED } },
      )) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchMock });
    const r = await client.run('chat', { workKey: 'invoice-4471', prompt: 'hi' });
    expect(r.status).toBe(409);
    expect(r.code).toBe('run_input_mismatch');
    expect(r.runId).toBe(DERIVED);
    expect((r.detail as { workKey?: string }).workKey).toBe('invoice-4471');
  });

  it('stream sends the workKey without a runId, and streamTo reports the id the run got', async () => {
    const bodies: any[] = [];
    const enc = new TextEncoder();
    const fetchMock = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('event: text-delta\ndata: {"text":"hi"}\n\n'));
            c.enqueue(enc.encode(`event: done\ndata: {"runId":"${DERIVED}"}\n\n`));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: fetchMock });
    const out = await client.streamTo('chat', { workKey: 'invoice-4471', prompt: 'hi' }, {});
    expect(bodies[0]).toMatchObject({ workKey: 'invoice-4471' });
    expect(bodies[0].runId).toBeUndefined();
    expect(out.runId).toBe(DERIVED);
  });
});
