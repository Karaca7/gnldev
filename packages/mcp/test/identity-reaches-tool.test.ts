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
import { byToken, subject, operator } from './principals.js';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const who: McpServerOptions['identify'] = byToken({ 'mehmet-token': subject('mehmet', 'acme'), 'service-token': operator('nightly', 'acme') });
const as = (token?: string) => (token ? { authInfo: { token } } : {});
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
      const srv = createMcpServer({ ...(journal ? { journal: new InMemoryJournal() } : {}), identify: who, tools: { t: r.tool as never } } as never);
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
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify: who, tools: { kb: createRagTool({ store, embed, topK: 10 }) } } as never);
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
      const srv = createMcpServer({ journal: new InMemoryJournal(), identify: who, workScope, tools: { t: r.tool as never } } as never);
      for (const c of [as(), as('garbage-token')]) {
        await expect(srv.callTool({ name: 't', arguments: {}, caller: c } as never)).rejects.toThrow(/no such tool/);
        expect(JSON.stringify(await srv.listTools({ caller: c } as never))).not.toContain('"t"');
      }
      await srv.callTool({ name: 't', arguments: {}, caller: as('mehmet-token') } as never);
      expect(r.seen).toEqual(['mehmet']);
    });
  }

  it('staff (an operator) is served — as staff, never as a user — and names no per-user work', async () => {
    // Before ADR-0002 an identity could only say "an org, no user", and that was refused under
    // 'resource'. An operator is now said out loud, and the engine reads it as staff.
    const r = recorder();
    const org = createMcpServer({ journal: new InMemoryJournal(), identify: who, workScope: 'org', tools: { t: r.tool } });
    await org.callTool({ name: 't', arguments: {}, idempotencyKey: 'nightly', caller: as('service-token') });
    expect(r.seen).toEqual([undefined]);
    const r2 = recorder();
    const res = createMcpServer({ journal: new InMemoryJournal(), identify: who, tools: { t: r2.tool } });
    await res.callTool({ name: 't', arguments: {}, caller: as('service-token') });
    expect(r2.seen).toEqual([undefined]);
    // …but a per-user ('resource') work id cannot be derived for staff: a keyed call is refused.
    const keyed = await res.callTool({ name: 't', arguments: {}, idempotencyKey: 'k', caller: as('service-token') });
    expect(JSON.stringify(keyed)).toMatch(/Refusing to run 't'/);
    expect(r2.seen).toEqual([undefined]);
  });
});
