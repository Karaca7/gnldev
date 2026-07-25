// Opt-in auth: createRestApi(config, { auth }) → GET=read, POST=write. roleAuth (viewer/admin).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

const cfg = () => ({ journal: new InMemoryJournal(), agents: { pay: { model: mkModel() } } });

describe('@gnldev/server opt-in auth', () => {
  it('if auth is not given, all endpoints are open (regression)', async () => {
    const api = createRestApi(cfg());
    expect((await api.request('/agents')).status).toBe(200);
    expect((await api.request('/openapi.json')).status).toBe(200);
  });

  it('roleAuth: viewer reads, admin writes', async () => {
    const api = createRestApi(cfg(), { auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }) });

    // read (GET)
    expect((await api.request('/agents')).status).toBe(401); // no header
    expect((await api.request('/agents', { headers: { authorization: 'Bearer viw' } })).status).toBe(200);
    expect((await api.request('/agents', { headers: { authorization: 'Bearer adm' } })).status).toBe(200);
    expect((await api.request('/openapi.json')).status).toBe(401);

    // write (POST)
    const post = (auth?: string) => api.request('/agents/pay/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });
    expect((await post()).status).toBe(403); // no header, write → 403
    expect((await post('Bearer viw')).status).toBe(403); // viewer can't write
    // admin → auth PASSES (result may be 200/400 but NOT 401/403)
    expect([401, 403]).not.toContain((await post('Bearer adm')).status);
  });

  // Audit #2: in production, createRestApi without auth can only be set up with allowOpenAccess: true.
  describe('production fail-open audit', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('production + no auth → setup error', () => {
      vi.stubEnv('NODE_ENV', 'production');
      // NOT translated on purpose: this regex matches the exact message thrown by @gnldev/auth's
      // makeGate (packages/auth/src/gate.ts), which is deliberately kept in Turkish because
      // packages/studio/test/auth-org.test.ts (a different workstream) asserts on the same string.
      expect(() => createRestApi(cfg())).toThrowError(/auth is required in production/);
    });

    it('production + allowOpenAccess: true → deliberate open access works', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const api = createRestApi(cfg(), { allowOpenAccess: true });
      expect((await api.request('/agents')).status).toBe(200);
    });
  });
});
