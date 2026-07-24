// Agent approval registry surface (GET/POST /agents/registry*) — Studio EXPOSES the SAME root-level
// `__agent_registry__:<name>` journal records @gnl/server writes at boot (via fingerprintAgent/
// recordAgent); Studio never fingerprints an agent itself (its playground runner is duck-typed, see
// StudioAgentRunner's JSDoc). These tests seed records directly (mirroring what @gnl/server's boot would
// have written) and drive the review/approve/block surface + its platform-admin gating + audit trail.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, recordAgent, fingerprintAgent, listLog } from '@gnl/durable';
import { roleAuth } from '@gnl/auth';
import { createStudioApi } from '../src/server.js';

const JH = (t?: string) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) });

describe('@gnl/studio agent approval registry', () => {
  it('GET /agents/registry lists the records @gnl/server would have written at boot', async () => {
    const journal = new InMemoryJournal();
    await recordAgent(journal, 'a', fingerprintAgent('a', { model: 'openai/gpt-4o' } as any));
    await recordAgent(journal, 'b', fingerprintAgent('b', { model: 'openai/gpt-4o' } as any));
    const app = createStudioApi({ reader: journal });
    const res = await app.request('/agents/registry');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((r: any) => r.name).sort()).toEqual(['a', 'b']);
    expect(body.every((r: any) => r.status === 'pending')).toBe(true);
  });

  it('POST .../approve and .../block flip status and are recorded in __audit__ (ROOT journal)', async () => {
    const journal = new InMemoryJournal();
    await recordAgent(journal, 'a', fingerprintAgent('a', { model: 'openai/gpt-4o' } as any));
    const app = createStudioApi({ reader: journal });

    const approve = await app.request('/agents/registry/a/approve', {
      method: 'POST', headers: JH(), body: JSON.stringify({ note: 'reviewed' }),
    });
    expect(approve.status).toBe(200);
    const approveBody = await approve.json();
    expect(approveBody.record.status).toBe('approved');
    expect(approveBody.record.note).toBe('reviewed');

    const block = await app.request('/agents/registry/a/block', {
      method: 'POST', headers: JH(), body: JSON.stringify({ note: 'incident' }),
    });
    expect(block.status).toBe(200);
    expect((await block.json()).record.status).toBe('blocked');

    const auditItems = await listLog(journal, '__audit__');
    const actions = auditItems.map((it: any) => it.payload.action);
    expect(actions).toContain('agent.approve');
    expect(actions).toContain('agent.block');
    const blockEntry = auditItems.find((it: any) => it.payload.action === 'agent.block');
    expect(blockEntry.payload.target).toBe('a');
    expect(blockEntry.payload.detail).toEqual({ note: 'incident' });
  });

  it('a viewer (read-only) is denied write access to approve/block', async () => {
    const journal = new InMemoryJournal();
    await recordAgent(journal, 'a', fingerprintAgent('a', { model: 'openai/gpt-4o' } as any));
    const app = createStudioApi({ reader: journal, auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }) });

    const noAuth = await app.request('/agents/registry/a/approve', { method: 'POST' });
    expect(noAuth.status).toBe(403);
    const viewer = await app.request('/agents/registry/a/approve', { method: 'POST', headers: JH('viw') });
    expect(viewer.status).toBe(403);
    const admin = await app.request('/agents/registry/a/approve', { method: 'POST', headers: JH('adm') });
    expect(admin.status).toBe(200);
  });

  it('capabilities.agentRegistry reflects a writable + listKeys-capable journal', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });
    const caps = await (await app.request('/capabilities')).json();
    expect(caps.agentRegistry).toBe(true);
  });
});

describe('@gnl/studio agent approval registry — strict multi-org platform-admin gating', () => {
  it('an org-bound identity cannot view/approve/block the registry (platform-only surface)', async () => {
    const journal = new InMemoryJournal();
    await recordAgent(journal, 'a', fingerprintAgent('a', { model: 'openai/gpt-4o' } as any));
    const licensedAuth = {
      authenticate: (c: any) => {
        const h = c.req.header('authorization');
        const tok = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
        return tok === 'acme-adm' ? { id: 'acme-adm', roles: ['admin'], orgId: 'acme' } : null;
      },
      authorize: (p: any, _c: any, ctx: any) => {
        if (!p) return { allow: false, status: 401 };
        if (ctx.action === 'write') return p.roles.includes('admin') ? { allow: true } : { allow: false, status: 403 };
        return { allow: true };
      },
      capabilities: () => ({ multiOrganization: true }),
    };
    const app = createStudioApi({ reader: journal, auth: licensedAuth as any, org: {} });
    const H = JH('acme-adm');
    expect((await app.request('/agents/registry', { headers: H })).status).toBe(403);
    expect((await app.request('/agents/registry/a/approve', { method: 'POST', headers: H })).status).toBe(403);
    expect((await app.request('/agents/registry/a/block', { method: 'POST', headers: H })).status).toBe(403);
  });
});
