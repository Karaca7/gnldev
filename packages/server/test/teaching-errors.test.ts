// The refusals a caller meets BEFORE a run exists, held to the same three-part shape as the engine's.
//
// `resourceId is required for a client credential` was true and taught nothing. The reader it is
// written for is somebody who just swapped an operator token for an application token, watched every
// request start failing, and has no reason to suspect the two credentials are governed by different
// rules — that asymmetry IS the answer, and the sentence did not contain it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
    warnings: [],
  }),
};

const api = () =>
  createRestApi(
    { storage: new InMemoryStorage(), agents: { a: { model } } } as never,
    { auth: roleAuth({ client: { token: 'C', orgId: 'acme' }, admin: { token: 'A', orgId: 'acme' } }) } as never,
  );

/** The refusal body for a client credential that named no end user, on a read and on a write. */
async function refusal(path: string, init?: RequestInit): Promise<{ status: number; error: string }> {
  const res: Response = await api()(
    new Request(`http://x${path}`, { headers: { authorization: 'Bearer C' }, ...init }),
  );
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: String(body.error ?? '') };
}

describe('resource_id_required', () => {
  it('still refuses, and still with a 400', async () => {
    // The behaviour is not what is changing here — only what the refusal says.
    expect((await refusal('/runs')).status).toBe(400);
  });

  it('carries all three limbs', async () => {
    const { error } = await refusal('/runs');
    expect(error).toMatch(/\n\s+note:/);
    expect(error).toMatch(/\n\s+help:/);
  });

  it('the note explains that an application credential speaks FOR somebody', async () => {
    // Not "you forgot a field" — the reason the field exists. A bearer token has no per-caller
    // identity of its own, so the only subject available is the one the request names.
    const { error } = await refusal('/runs');
    const note = error.slice(error.indexOf('note:'));
    expect(note).toMatch(/on behalf of|acts for|speaks for/i);
    // And the measured cost of the alternative, which is what makes this a rule and not a preference.
    expect(note).toMatch(/shared|same bucket|each other|one owner/i);
  });

  it("the help shows where to read the subject from, and names the one exception", async () => {
    const { error } = await refusal('/runs');
    const help = error.slice(error.indexOf('help:'));
    // Copyable: the subject comes from the session the application already has for its user.
    expect(help).toMatch(/resourceId/);
    expect(help).toMatch(/session|logged-in|your own user/i);
    // The REST exception: on THIS surface the field is how a client names the subject, which is
    // exactly what makes it unlike the adapters, where the body must never decide.
    expect(help).toMatch(/\?resourceId=|body/i);
  });

  it('the write path says the same thing as the read path', async () => {
    // Two call sites used to hold two copies of one sentence. They must not drift.
    const read = await refusal('/runs');
    const write = await refusal('/agents/a/run', {
      method: 'POST',
      headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r-1', prompt: 'x' }),
    });
    expect(write.status).toBe(400);
    expect(write.error).toBe(read.error);
  });

  it('an operator credential is still untouched — it names nobody by design', async () => {
    const res: Response = await api()(new Request('http://x/runs', { headers: { authorization: 'Bearer A' } }));
    expect(res.status).toBe(200);
  });
});
