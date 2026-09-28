// ADR-0002 point 0: a standalone MCP server gives the SAME isolation as @gnldev/server. Callers come in
// through `identify` only, mapped by `engineCallerOf`: a user is itself, staff is staff, an application
// is the user it names, nothing is unknown.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { createMcpServer, serveMcp } from '../src/server.js';
import { byToken, subject, operator, application } from './principals.js';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const as = (token: string) => ({ authInfo: { token } });
const identify = byToken({
  mehmet: subject('mehmet', 'acme'),
  ayse: subject('ayse', 'acme'),
  mehmetGlobex: subject('mehmet', 'globex'),
  ops: operator('ops', 'acme'),
  app: application('backend', 'acme'),
});

async function kb() {
  const embed = async () => [1, 0, 0];
  const store = new InMemoryVectorStore();
  await indexDocuments(store, embed, [
    { id: 'h', text: 'GENERAL handbook', shared: true },
    { id: 'a', text: 'AYSE invoice', owner: 'ayse' },
    { id: 'm', text: 'MEHMET invoice', owner: 'mehmet' },
    // Ownerless: indexed by staff, for staff. The MCP counterpart of SECRET-2.
    { id: 's', text: 'SECRET-2 vault code' },
  ]);
  return createRagTool({ store, embed, topK: 10 });
}
const ask = async (srv: ReturnType<typeof createMcpServer>, req: Parameters<ReturnType<typeof createMcpServer>['callTool']>[0]) =>
  JSON.stringify(await srv.callTool(req));

describe('standalone MCP: a user cannot read staff\'s ownerless data (SECRET-2)', () => {
  it('a user\'s search never returns the ownerless document; staff\'s does', async () => {
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { kb: await kb() } });
    const mehmet = await ask(srv, { name: 'kb', arguments: { query: 'x' }, caller: as('mehmet') });
    expect(mehmet).toContain('MEHMET invoice');
    expect(mehmet).not.toContain('SECRET-2');
    const staff = await ask(srv, { name: 'kb', arguments: { query: 'x' }, caller: as('ops') });
    expect(staff).toContain('SECRET-2');
  });

  it('sibling: a user re-sending staff\'s work key gets no share of staff\'s recorded result', async () => {
    const ran: string[] = [];
    const tool = { description: 'r', execute: async (a: { q: string }) => { ran.push(a.q); return { answer: `for ${a.q}` }; } };
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, workScope: 'org', tools: { t: tool } });
    expect(await ask(srv, { name: 't', arguments: { q: 'SECRET-2' }, idempotencyKey: 'nightly', caller: as('ops') })).toContain('SECRET-2');
    // Same org, same key under the 'org' scope → the same derived run, which is staff's: refused.
    const r = await srv.callTool({ name: 't', arguments: { q: 'mine' }, idempotencyKey: 'nightly', caller: as('mehmet') }).then(
      (v) => JSON.stringify(v), (e: Error) => `threw: ${e.name}`);
    expect(r).not.toContain('SECRET-2');
    expect(r).toMatch(/RunOwnerMismatch|belongs to a different subject/);
    expect(ran).toEqual(['SECRET-2']);
  });

  it('sibling: an unknown caller sees no tool at all', async () => {
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { kb: await kb() } });
    expect((await srv.listTools({ caller: as('nobody') })).tools).toEqual([]);
    await expect(srv.callTool({ name: 'kb', arguments: { query: 'x' }, caller: as('nobody') })).rejects.toThrow(/no such tool/);
  });
});

describe('standalone MCP: a user cannot read another user\'s data', () => {
  it('mehmet naming ayse is still mehmet — the name is read for an application only', async () => {
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { kb: await kb() } });
    const out = await ask(srv, { name: 'kb', arguments: { query: 'x' }, caller: as('mehmet'), resourceId: 'ayse' });
    expect(out).toContain('MEHMET invoice');
    expect(out).not.toContain('AYSE invoice');
  });

  it('sibling: an application is the user it names — and naming nobody runs nothing', async () => {
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { kb: await kb() } });
    const forAyse = await ask(srv, { name: 'kb', arguments: { query: 'x' }, caller: as('app'), resourceId: 'ayse' });
    expect(forAyse).toContain('AYSE invoice');
    expect(forAyse).not.toContain('MEHMET invoice');
    expect(forAyse).not.toContain('SECRET-2');
    const nobody = await ask(srv, { name: 'kb', arguments: { query: 'x' }, caller: as('app') });
    expect(nobody).toMatch(/resourceId is required/);
    expect(nobody).not.toContain('invoice');
    expect((await srv.listTools({ caller: as('app') })).tools).toEqual([]);
  });

  it('sibling: over the real SDK wire, the application names its user in `_meta.resourceId`', async () => {
    const { InMemoryTransport } = (await import('@modelcontextprotocol/sdk/inMemory.js')) as any;
    const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;
    // The in-memory transport authenticates nobody, so this server's `identify` says "the application".
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify: () => application('backend'), tools: { kb: await kb() } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await serveMcp(srv, st, { name: 't', version: '0' });
    const c = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    await c.connect(ct);
    const named = JSON.stringify(await c.callTool({ name: 'kb', arguments: { query: 'x' }, _meta: { resourceId: 'ayse' } }));
    const unnamed = JSON.stringify(await c.callTool({ name: 'kb', arguments: { query: 'x' } }));
    const listed = await c.listTools({ _meta: { resourceId: 'ayse' } });
    await c.close();
    expect(named).toContain('AYSE invoice');
    expect(named).not.toContain('MEHMET invoice');
    expect(unnamed).toMatch(/resourceId is required/);
    expect(listed.tools.map((t: { name: string }) => t.name)).toEqual(['kb']);
  });

  it('sibling: the same work key from two users is two runs — ayse never gets mehmet\'s result', async () => {
    const tool = { description: 'r', execute: async (_a: unknown, o?: { gnl?: { identity?: { id?: string } } }) => ({ for: o?.gnl?.identity?.id }) };
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { t: tool } });
    expect(await ask(srv, { name: 't', arguments: {}, idempotencyKey: 'k', caller: as('mehmet') })).toContain('"for":"mehmet"');
    expect(await ask(srv, { name: 't', arguments: {}, idempotencyKey: 'k', caller: as('ayse') })).toContain('"for":"ayse"');
  });
});

describe('standalone MCP: a user cannot reach another organization\'s run', () => {
  it('the same user id and key in globex does not get acme\'s recorded result', async () => {
    const ran: string[] = [];
    const tool = { description: 'r', execute: async (a: { q: string }) => { ran.push(a.q); return { answer: a.q }; } };
    const srv = createMcpServer({ journal: new InMemoryJournal(), identify, tools: { t: tool } });
    expect(await ask(srv, { name: 't', arguments: { q: 'ACME-ONLY' }, idempotencyKey: 'k', caller: as('mehmet') })).toContain('ACME-ONLY');
    const globex = await ask(srv, { name: 't', arguments: { q: 'globex' }, idempotencyKey: 'k', caller: as('mehmetGlobex') });
    expect(globex).not.toContain('ACME-ONLY');
    expect(ran).toEqual(['ACME-ONLY', 'globex']);
  });

  it('sibling: the organization comes from the principal — an application names a user, never an org', async () => {
    const seen: unknown[] = [];
    const srv = createMcpServer({
      journal: new InMemoryJournal(),
      identify,
      tools: (ctx) => { seen.push(ctx.org); return { t: { description: 'r', execute: async () => ({ ok: 1 }) } }; },
    });
    await srv.callTool({ name: 't', arguments: {}, caller: as('app'), resourceId: 'ayse' });
    expect(seen).toEqual(['acme']);
  });
});
