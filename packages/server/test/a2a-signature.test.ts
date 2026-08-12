// (audit: A2A unsigned) — opt-in a2aSecret verification: if given, x-gnl-signature/x-gnl-timestamp
// become REQUIRED on /agents/:name/run POSTs (signature = HMAC-SHA256(secret, timestamp + '.' + rawBody) hex).
// This file tests the HTTP layer directly (with a manually signed request) — for a round-trip
// with the @gnldev/a2a package see packages/a2a/test/a2a.test.ts.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function mkApi(a2aSecret?: string) {
  const journal = new InMemoryJournal();
  return createRestApi({ journal, agents: { a: { model: mkModel() } } }, a2aSecret ? { a2aSecret } : {});
}

describe('@gnldev/server A2A signature verification (a2aSecret)', () => {
  it('valid signature + fresh timestamp → 200 (round-trip)', async () => {
    const secret = 'secret-key';
    const api = mkApi(secret);
    const body = JSON.stringify({ runId: 'sig-1', prompt: 'hi' });
    const timestamp = String(Date.now());
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gnl-signature': sign(secret, timestamp, body),
        'x-gnl-timestamp': timestamp,
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.text).toBe('ok');
  });

  it('signature header missing → 401', async () => {
    const api = mkApi('secret-key');
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'sig-2', prompt: 'hi' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('a2a_signature_missing');
  });

  it('wrong signature (signed with the wrong secret) → 401', async () => {
    const api = mkApi('correct-secret');
    const body = JSON.stringify({ runId: 'sig-3', prompt: 'hi' });
    const timestamp = String(Date.now());
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gnl-signature': sign('wrong-secret', timestamp, body),
        'x-gnl-timestamp': timestamp,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('a2a_signature_invalid');
  });

  it('body modified AFTER signing (tamper) → 401', async () => {
    const secret = 'secret-key';
    const api = mkApi(secret);
    const timestamp = String(Date.now());
    const signedBody = JSON.stringify({ runId: 'sig-4', prompt: 'original' });
    const tamperedBody = JSON.stringify({ runId: 'sig-4', prompt: 'changed' });
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gnl-signature': sign(secret, timestamp, signedBody), // signed for the original body
        'x-gnl-timestamp': timestamp,
      },
      body: tamperedBody, // but the body sent is different
    });
    expect(res.status).toBe(401);
  });

  it('timestamp outside ±300s window (stale) → 401', async () => {
    const secret = 'secret-key';
    const api = mkApi(secret);
    const body = JSON.stringify({ runId: 'sig-5', prompt: 'hi' });
    const staleTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gnl-signature': sign(secret, staleTimestamp, body),
        'x-gnl-timestamp': staleTimestamp,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('a2a_timestamp_invalid');
  });

  it('if a2aSecret is NOT GIVEN, old behavior is preserved: an unsigned request is accepted with 200 (no regression)', async () => {
    const api = mkApi(); // no a2aSecret
    const res = await call(api, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'sig-6', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
  });

  it('F1: the signature gate covers /stream and /resume too (not just /run) — an unsigned request is 401', async () => {
    const api = mkApi('secret-key');
    // /stream — previously invocable UNSIGNED (full streamed execution), bypassing the gate
    const stream = await call(api, '/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'sig-stream', prompt: 'hi' }),
    });
    expect(stream.status).toBe(401);
    expect((await stream.json()).code).toBe('a2a_signature_missing');
    // /resume — previously invocable UNSIGNED
    const resume = await call(api, '/agents/a/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'sig-resume' }),
    });
    expect(resume.status).toBe(401);
    expect((await resume.json()).code).toBe('a2a_signature_missing');
  });

  it('F1: a correctly-signed /stream request passes the gate (200-class, not a signature 401)', async () => {
    const secret = 'secret-key';
    const api = mkApi(secret);
    const body = JSON.stringify({ runId: 'sig-stream-ok', prompt: 'hi' });
    const timestamp = String(Date.now());
    const res = await call(api, '/agents/a/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gnl-signature': sign(secret, timestamp, body),
        'x-gnl-timestamp': timestamp,
      },
      body,
    });
    expect(res.status).not.toBe(401); // signature accepted → proceeds to stream (SSE)
  });
});
