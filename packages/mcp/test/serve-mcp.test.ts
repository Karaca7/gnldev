// W1 — serveMcp: connects createMcpServer to a REAL @modelcontextprotocol/sdk Server.
// The SDK's setRequestHandler expects a Zod schema (not a plain {method:'...'}) — this test
// verifies that bridge works with the real SDK (InMemoryTransport, NO network).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer, serveMcp } from '../src/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('W1 serveMcp (real SDK connection)', () => {
  it('tools/list + tools/call work over a real Client (raw return → wrapped into content)', async () => {
    const gnlServer = createMcpServer({
      tools: {
        echo: {
          description: 'echo',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          execute: async ({ msg }: any) => `echo:${msg}`, // raw string return (existing contract)
        },
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serveMcp(gnlServer, serverTransport, { name: 'gnl-test', version: '0.0.0' });

    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(['echo']);

    const result = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    // Raw 'echo:hi' → wrapped into MCP content format by the serveMcp bridge.
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);

    await client.close();
  });

  it('journal + params._meta.idempotencyKey → server-side exactly-once, preserved over the real SDK too', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const gnlServer = createMcpServer({
      journal,
      tools: { pay: { execute: async ({ amt }: any) => (calls++, { charged: amt }) } },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serveMcp(gnlServer, serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // MCP spec: params._meta is a free/'loose' meta field — over a real Client, two `tools/call`
    // requests with the SAME idempotencyKey → the serveMcp bridge reads _meta and carries it into
    // createMcpServer → the 'succeeded' journal record is returned, execute does NOT RUN A SECOND TIME.
    const a = await client.callTool({ name: 'pay', arguments: { amt: 5 }, _meta: { idempotencyKey: 'req-1' } });
    const b = await client.callTool({ name: 'pay', arguments: { amt: 5 }, _meta: { idempotencyKey: 'req-1' } });
    expect(calls).toBe(1); // exactly-once: same idempotencyKey → execute runs once
    expect(a).toEqual(b);

    // different idempotencyKey → counted as a new call, runs again.
    await client.callTool({ name: 'pay', arguments: { amt: 9 }, _meta: { idempotencyKey: 'req-2' } });
    expect(calls).toBe(2);

    await client.close();
  });

  it('if _meta.idempotencyKey is not given, old behavior is preserved: every call runs over a real Client (backward compatible)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const gnlServer = createMcpServer({
      journal,
      tools: { pay: { execute: async ({ amt }: any) => (calls++, { charged: amt }) } },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serveMcp(gnlServer, serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // _meta is never sent → serveMcp doesn't forward idempotencyKey → createMcpServer.callTool skips
    // the journal (the opts.journal && req.idempotencyKey condition isn't met) → every call runs normally.
    await client.callTool({ name: 'pay', arguments: { amt: 5 } });
    await client.callTool({ name: 'pay', arguments: { amt: 5 } });
    expect(calls).toBe(2); // old behavior: no idempotencyKey → journal disabled, every call runs

    await client.close();
  });
});
