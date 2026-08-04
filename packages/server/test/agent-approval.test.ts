// Agent approval registry (governance surface — see RestApiOptions.requireAgentApproval, and
// @gnldev/durable's agent-registry.ts for the underlying primitives: fingerprintAgent/recordAgent/
// approveAgent/blockAgent/isAgentServable/listAgentRegistry). Every `config.agents` entry is recorded
// (idempotent) into the journal ONCE at `createRestApi` construction; the flag OPTS IN to enforcing it
// on run/resume/stream — off by default (backward compat: an existing deployment is unaffected).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, listLog } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

const run = (api: any, name: string, runId: string, headers: Record<string, string> = {}) =>
  call(api, `/agents/${name}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ runId, prompt: 'hi' }),
  });

describe('@gnldev/server agent approval registry', () => {
  it('requireAgentApproval OFF (default) → agent serves, no regression from a pending registry record', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: { a: { model: mkModel('ok') } } });
    const res = await run(api, 'a', 'r1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('ok');
    // Even though not enforced, boot recording still happened (best-effort governance visibility).
    const reg = await (await call(api, '/agents/registry')).json();
    expect(reg.find((r: any) => r.name === 'a')?.status).toBe('pending');
  });

  it('requireAgentApproval ON → a pending agent is denied (403 agent_not_approved); approve → serves', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { requireAgentApproval: true },
    );
    const denied = await run(api, 'a', 'r1');
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json();
    expect(deniedBody.code).toBe('agent_not_approved');

    const approveRes = await call(api, '/agents/registry/a/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'looks good' }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.record.status).toBe('approved');
    expect(approveBody.record.note).toBe('looks good');

    const served = await run(api, 'a', 'r2');
    expect(served.status).toBe(200);
    expect((await served.json()).text).toBe('ok');
  });

  it('resume/stream also enforce the approval gate when ON', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { requireAgentApproval: true },
    );
    const streamDenied = await call(api, '/agents/a/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs1', prompt: 'hi' }),
    });
    expect(streamDenied.status).toBe(403);
    expect((await streamDenied.json()).code).toBe('agent_not_approved');

    const resumeDenied = await call(api, '/agents/a/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'ru1' }),
    });
    expect(resumeDenied.status).toBe(403);
    expect((await resumeDenied.json()).code).toBe('agent_not_approved');
  });

  it('an unknown agent still returns visibility 404 FIRST (approval check never runs)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { requireAgentApproval: true },
    );
    const res = await run(api, 'nope', 'r1');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).not.toBe('agent_not_approved');
  });

  it('config DRIFT after approval flips the record to "changed" → 403 again until re-approved', async () => {
    const journal = new InMemoryJournal();
    const api1 = createRestApi(
      { journal, agents: { a: { model: mkModel('v1'), maxSteps: 6 } } },
      { requireAgentApproval: true },
    );
    await call(api1, '/agents/registry/a/approve', { method: 'POST' });
    expect((await run(api1, 'a', 'r1')).status).toBe(200);

    // Re-create the API against the SAME journal with a DIFFERENT config (maxSteps changed) — boot
    // re-records the agent, detects fingerprint drift against the pinned approvedFingerprint → 'changed'.
    const api2 = createRestApi(
      { journal, agents: { a: { model: mkModel('v1'), maxSteps: 12 } } },
      { requireAgentApproval: true },
    );
    const drifted = await run(api2, 'a', 'r2');
    expect(drifted.status).toBe(403);
    expect((await drifted.json()).code).toBe('agent_not_approved');

    const reg = await (await call(api2, '/agents/registry')).json();
    expect(reg.find((r: any) => r.name === 'a')?.status).toBe('changed');

    // Re-approve → serves again.
    await call(api2, '/agents/registry/a/approve', { method: 'POST' });
    expect((await run(api2, 'a', 'r3')).status).toBe(200);
  });

  it('GET /agents/registry lists every recorded agent with its status', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: { a: { model: mkModel('a') }, b: { model: mkModel('b') } } });
    const reg = await (await call(api, '/agents/registry')).json();
    expect(reg.map((r: any) => r.name).sort()).toEqual(['a', 'b']);
    expect(reg.every((r: any) => r.status === 'pending')).toBe(true);
  });

  it('block prevents serving even without drift; audit records land in the ROOT journal', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { requireAgentApproval: true },
    );
    await call(api, '/agents/registry/a/approve', { method: 'POST' });
    expect((await run(api, 'a', 'r1')).status).toBe(200);

    const blockRes = await call(api, '/agents/registry/a/block', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'suspicious tool use' }),
    });
    expect(blockRes.status).toBe(200);
    expect((await blockRes.json()).record.status).toBe('blocked');

    const blocked = await run(api, 'a', 'r2');
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe('agent_not_approved');

    const auditItems = await listLog(journal, '__audit__');
    const actions = auditItems.map((it: any) => it.payload.action);
    expect(actions).toContain('agent.approve');
    expect(actions).toContain('agent.block');
    const blockEntry = auditItems.find((it: any) => it.payload.action === 'agent.block');
    expect(blockEntry.payload.target).toBe('a');
    expect(blockEntry.payload.detail).toEqual({ note: 'suspicious tool use' });
  });

  it('approve/block are write-permission gated (a read-only identity is denied)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }), requireAgentApproval: true },
    );
    const noAuth = await call(api, '/agents/registry/a/approve', { method: 'POST' });
    expect(noAuth.status).toBe(403);
    const viewer = await call(api, '/agents/registry/a/approve', {
      method: 'POST',
      headers: { authorization: 'Bearer viw' },
    });
    expect(viewer.status).toBe(403);
    const admin = await call(api, '/agents/registry/a/approve', {
      method: 'POST',
      headers: { authorization: 'Bearer adm' },
    });
    expect(admin.status).toBe(200);
  });

  it('platform-admin gate: an org-bound identity cannot approve/block/view the registry', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel('ok') } } },
      { auth: roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } }), org: {}, requireAgentApproval: true },
    );
    const H = { authorization: 'Bearer acme-adm' };
    expect((await call(api, '/agents/registry', { headers: H })).status).toBe(403);
    expect((await call(api, '/agents/registry/a/approve', { method: 'POST', headers: H })).status).toBe(403);
    expect((await call(api, '/agents/registry/a/block', { method: 'POST', headers: H })).status).toBe(403);
  });
});
