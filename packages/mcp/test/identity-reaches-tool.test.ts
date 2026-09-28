import { identityOf, userIdOf } from '@gnldev/durable';
// On a server that resolves who is calling, every call hands the tool that caller — whether or not it
// names a unit of work, whether or not the server keeps a journal. The plain path (no key: what an
// ordinary third-party client sends) used to call `t.execute(args)` bare, so a tool that serves end
// users had nobody to narrow to: `createRagTool` answered Mehmet with Ayşe's documents.
//
// And a server that resolves identity serves no caller it cannot place, on any workScope.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { createMcpServer, type McpServerOptions } from '../src/server.js';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const who: McpServerOptions['identity'] = (c) => {
  const id = (c as { authInfo?: { clientId?: string } }).authInfo?.clientId;
  if (id === 'mehmet-token') return { resourceId: 'mehmet', orgId: 'acme' };
  if (id === 'service-token') return { orgId: 'acme' };
  return {};
};
const as = (clientId?: string) => (clientId ? { authInfo: { clientId } } : {});
const recorder = () => {
  const seen: Array<string | undefined> = [];
  return { seen, tool: { description: 'r', execute: async (_a: unknown, o?: unknown) => { seen.push(userIdOf(identityOf(o))); return { ok: true }; } } };
};

describe('the caller reaches the tool on every path', () => {
  for (const [label, journal, key] of [
    ['journal, no key', true, undefined],
    ['journal and a key', true, 'k1'],
    ['no journal', false, 'k1'],
  ] as const) {
    it(label, async () => {
      const r = recorder();
      const srv = createMcpServer({ ...(journal ? { journal: new InMemoryJournal() } : {}), identity: who, tools: { t: r.tool as never } } as never);
      await srv.callTool({ name: 't', arguments: {}, ...(key ? { idempotencyKey: key } : {}), caller: as('mehmet-token') } as never);
      expect(r.seen).toEqual(['mehmet']);
    });
  }

  it('createRagTool over the plain path answers Mehmet from the shared shelf and his own', async () => {
    const embed = async () => [1, 0, 0];
    const store = new InMemoryVectorStore();
    await indexDocuments(store, embed, [
      { id: 'h', text: 'GENERAL handbook', shared: true },
      { id: 'a', text: 'AYSE invoice', owner: 'ayse' },
      { id: 'm', text: 'MEHMET invoice', owner: 'mehmet' },
      { id: 'u', text: 'UNTAGGED note' },
    ]);
    const srv = createMcpServer({ journal: new InMemoryJournal(), identity: who, tools: { kb: createRagTool({ store, embed, topK: 10 }) as never } } as never);
    const out = JSON.stringify(await srv.callTool({ name: 'kb', arguments: { query: 'invoice' }, caller: as('mehmet-token') } as never));
    expect(out).toContain('GENERAL handbook');
    expect(out).toContain('MEHMET invoice');
    expect(out).not.toContain('AYSE invoice');
    expect(out).not.toContain('UNTAGGED note');
  });
});

describe('a caller the server cannot place is not served', () => {
  for (const workScope of ['resource', 'org'] as const) {
    it(`workScope '${workScope}'`, async () => {
      const r = recorder();
      const srv = createMcpServer({ journal: new InMemoryJournal(), identity: who, workScope, tools: { t: r.tool as never } } as never);
      for (const c of [as(), as('garbage-token')]) {
        await expect(srv.callTool({ name: 't', arguments: {}, caller: c } as never)).rejects.toThrow(/no such tool/);
        expect(JSON.stringify(await srv.listTools({ caller: c } as never))).not.toContain('"t"');
      }
      await srv.callTool({ name: 't', arguments: {}, caller: as('mehmet-token') } as never);
      expect(r.seen).toEqual(['mehmet']);
    });
  }

  it('org-level work: a caller placed in an organization but naming no user is served under workScope \'org\' only', async () => {
    const r = recorder();
    const org = createMcpServer({ journal: new InMemoryJournal(), identity: who, workScope: 'org', tools: { t: r.tool as never } } as never);
    await org.callTool({ name: 't', arguments: {}, caller: as('service-token') } as never);
    expect(r.seen).toEqual([undefined]);
    const res = createMcpServer({ journal: new InMemoryJournal(), identity: who, tools: { t: recorder().tool as never } } as never);
    await expect(res.callTool({ name: 't', arguments: {}, caller: as('service-token') } as never)).rejects.toThrow(/no such tool/);
  });
});
