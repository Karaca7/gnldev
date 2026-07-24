// P1.7 (AUDIT-R2): reserved server-only RequestContext keys (mirrors the common
// reserved-resource-id-key design). sealRequestContext/serverIdentityOf unit tests + the registry
// precedence they enable (server-sealed resourceId/threadId wins over opts.resourceId/opts.threadId).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import {
  createGnl,
  sealRequestContext,
  serverIdentityOf,
  GNL_RESOURCE_ID_KEY,
  GNL_ORG_ID_KEY,
  GNL_THREAD_ID_KEY,
} from '../src/registry.js';
import type { Memory } from '../src/memory.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('sealRequestContext', () => {
  it('overwrites client-supplied reserved keys with the server value', () => {
    const clientCtx = { [GNL_ORG_ID_KEY]: 'evil-org', [GNL_RESOURCE_ID_KEY]: 'evil-user', foo: 'bar' };
    const sealed = sealRequestContext(clientCtx, { orgId: 'real-org', resourceId: 'real-user' });
    expect(sealed[GNL_ORG_ID_KEY]).toBe('real-org');
    expect(sealed[GNL_RESOURCE_ID_KEY]).toBe('real-user');
    // non-reserved keys pass through untouched
    expect(sealed.foo).toBe('bar');
    // the original object is not mutated
    expect(clientCtx[GNL_ORG_ID_KEY]).toBe('evil-org');
  });

  it('absent server values leave the reserved keys UNSET — not present, not literal undefined', () => {
    const clientCtx = { [GNL_RESOURCE_ID_KEY]: 'evil-user', [GNL_THREAD_ID_KEY]: 'evil-thread' };
    const sealed = sealRequestContext(clientCtx, {}); // server supplies nothing
    expect(GNL_RESOURCE_ID_KEY in sealed).toBe(false);
    expect(GNL_THREAD_ID_KEY in sealed).toBe(false);
    expect(Object.keys(sealed)).not.toContain(GNL_RESOURCE_ID_KEY);
    // JSON round-trip also shows no key (would show `"__gnl_resourceId":null`-free — key just absent)
    expect(JSON.stringify(sealed)).not.toContain(GNL_RESOURCE_ID_KEY);
  });

  it('a client cannot smuggle a reserved key through by the server simply not mentioning it', () => {
    // Regression guard for the "spoof survives by omission" hole: the server only had orgId this call,
    // but the client tried to also set __gnl_resourceId — that must be stripped too, not just orgId.
    const clientCtx = { [GNL_RESOURCE_ID_KEY]: 'victim-user' };
    const sealed = sealRequestContext(clientCtx, { orgId: 'acme' }); // resourceId NOT supplied
    expect(sealed[GNL_RESOURCE_ID_KEY]).toBeUndefined();
    expect(GNL_RESOURCE_ID_KEY in sealed).toBe(false);
  });
});

describe('serverIdentityOf', () => {
  it('round-trips through sealRequestContext', () => {
    const sealed = sealRequestContext({}, { orgId: 'o1', resourceId: 'r1', threadId: 't1' });
    expect(serverIdentityOf(sealed)).toEqual({ orgId: 'o1', resourceId: 'r1', threadId: 't1' });
  });

  it('returns an object with only the fields actually present (no undefined-valued keys)', () => {
    const sealed = sealRequestContext({}, { orgId: 'o1' });
    const identity = serverIdentityOf(sealed);
    expect(identity).toEqual({ orgId: 'o1' });
    expect('resourceId' in identity).toBe(false);
    expect('threadId' in identity).toBe(false);
  });

  it('a bare context with no reserved keys yields an empty identity', () => {
    expect(serverIdentityOf({})).toEqual({});
    expect(serverIdentityOf({ org: 'plain-field-not-reserved' })).toEqual({});
  });
});

describe('registry: server-sealed identity precedence (P1.7)', () => {
  it('sealed threadId wins over opts.threadId (visible via the persisted :input record)', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } },
    });
    await gnl.run('a', {
      runId: 'precedence-thread',
      prompt: 'x',
      threadId: 'body-thread', // less-trusted, client-suppliable field
      context: sealRequestContext({}, { threadId: 'server-thread' }),
    });
    const input = await journal.get<{ threadId?: string }>('precedence-thread:input');
    expect(input?.threadId).toBe('server-thread'); // NOT 'body-thread'
  });

  it('without a sealed threadId, opts.threadId is used as before (no regression)', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } },
    });
    await gnl.run('a', { runId: 'no-seal-thread', prompt: 'x', threadId: 'body-thread' });
    const input = await journal.get<{ threadId?: string }>('no-seal-thread:input');
    expect(input?.threadId).toBe('body-thread');
  });

  it('sealed resourceId wins over opts.resourceId (visible via the Memory call it drives)', async () => {
    const journal = new InMemoryJournal();
    const calls: { resourceId?: string }[] = [];
    const recordingMemory: Memory = {
      async getMessages(_threadId: string, opts?: { resourceId?: string }) {
        calls.push({ resourceId: opts?.resourceId });
        return [];
      },
      async append() {},
    };
    const gnl = createGnl({
      journal,
      memory: recordingMemory,
      agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } },
    });
    await gnl.run('a', {
      runId: 'precedence-resource',
      prompt: 'x',
      threadId: 'th1',
      resourceId: 'body-resource',
      context: sealRequestContext({}, { resourceId: 'server-resource' }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resourceId).toBe('server-resource'); // NOT 'body-resource'
  });
});
