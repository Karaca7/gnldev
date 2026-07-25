// W1 — mcpTools/describeTools: with the REAL @modelcontextprotocol/sdk (NO network), connects to a
// real MCP Server via the SDK's InMemoryTransport and tests tools/list + tools/call with real
// protocol messaging (only the 'tool behavior' is fake, the transport/protocol is real).
import { describe, it, expect } from 'vitest';
import { argsHash, InMemoryJournal } from '@gnldev/durable';
import { mcpTools, createMcpServer, serveMcp } from '../src/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Sets up a real MCP Server: exposes the 'echo' tool, counts tools/list and tools/call calls. */
function makeFakeMcpServer() {
  const calls = { list: 0, call: 0 };
  const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    calls.list++;
    return {
      tools: [
        {
          name: 'echo',
          description: 'echoes the given message',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.call++;
    const { name, arguments: args } = req.params;
    if (name !== 'echo') throw new Error(`unknown tool: ${name}`);
    return { content: [{ type: 'text', text: `echo:${(args as any)?.msg}` }] };
  });
  return { server, calls };
}

describe('W1 mcpTools (real SDK, InMemoryTransport)', () => {
  it('tools/list → GNL (AI SDK) tool conversion; execute → tools/call', async () => {
    const { server, calls } = makeFakeMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport } });
    // The constructor must do NO I/O — tools/list hasn't been called yet.
    expect(calls.list).toBe(0);

    const tools = await handle.tools();
    expect(Object.keys(tools)).toEqual(['echo']);
    expect(tools.echo.description).toBe('echoes the given message');
    expect(calls.list).toBe(1);

    const out = await tools.echo.execute({ msg: 'hello' }, { toolCallId: 'c1' });
    expect(calls.call).toBe(1);
    expect(out).toEqual([{ type: 'text', text: 'echo:hello' }]);

    // Discovery is reused (a second tools() call doesn't retrigger tools/list).
    await handle.tools();
    expect(calls.list).toBe(1);

    await handle.close();
  });

  it('prefix is applied (avoids name collisions)', async () => {
    const { server } = makeFakeMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport }, prefix: 'gh_' });
    const tools = await handle.tools();
    expect(Object.keys(tools)).toEqual(['gh_echo']);

    await handle.close();
  });

  it('describeTools: {name, description, inputSchema} + a stable descriptionHash (matches argsHash)', async () => {
    const { server } = makeFakeMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport } });
    const summaries1 = await handle.describeTools();
    const summaries2 = await handle.describeTools(); // called again → same hash (stability)

    expect(summaries1).toEqual(summaries2);
    expect(summaries1).toHaveLength(1);
    const s = summaries1[0]!;
    expect(s.name).toBe('echo');
    expect(s.description).toBe('echoes the given message');
    const expectedHash = argsHash({ name: 'echo', description: 'echoes the given message', inputSchema: s.inputSchema });
    expect(s.descriptionHash).toBe(expectedHash);

    await handle.close();
  });

  it('close() is idempotent; calling tools() again after closing reconnects', async () => {
    const { server, calls } = makeFakeMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport } });
    await handle.close(); // close without ever connecting → no-op, no error

    await handle.tools();
    expect(calls.list).toBe(1);
    await handle.close();
    await handle.close(); // second close → idempotent, no error
  });

  it('unknown transport.kind → tools() rejects (not the constructor, only at first use)', async () => {
    const handle = mcpTools({ transport: { kind: 'weird' } as any });
    await expect(handle.tools()).rejects.toThrow(/unknown transport\.kind/);
  });

  it('lazy connect: the mcpTools(...) constructor does NO I/O (stdio/http transport is never set up)', () => {
    // No real process is spawned and no network is opened — only the options are stored.
    expect(() => mcpTools({ transport: { kind: 'stdio', command: '__no_such_binary__' } })).not.toThrow();
    expect(() => mcpTools({ transport: { kind: 'http', url: 'http://127.0.0.1:1/does-not-exist' } })).not.toThrow();
  });

  // 7.1 — end-to-end: mcpTools (client) → real SDK wire → createMcpServer+serveMcp (server, with journal).
  // The options.idempotencyKey (`${runId}:${toolCallId}`) that durableTool injects into execute is
  // simulated BY HAND here (durableTool itself already does this, see mcp.test.ts) — the goal is to
  // verify that execute carries it into client.callTool → params._meta.idempotencyKey over the REAL
  // wire, and that the other side (serveMcp → createMcpServer.callTool → journal) applies exactly-once.
  it('_meta.idempotencyKey end-to-end (mcpTools client → real SDK → serveMcp server + journal): same key → runs once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const gnlServer = createMcpServer({
      journal,
      tools: { pay: { execute: async ({ amt }: any) => (calls++, { charged: amt }) } },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serveMcp(gnlServer, serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport } });
    const tools = await handle.tools();

    // Just like durableTool does inside runDurable: options.idempotencyKey = `${runId}:${toolCallId}`.
    const o1 = await tools.pay.execute({ amt: 5 }, { toolCallId: 'c1', idempotencyKey: 'run1:c1' });
    const o2 = await tools.pay.execute({ amt: 5 }, { toolCallId: 'c1', idempotencyKey: 'run1:c1' }); // same key
    expect(calls).toBe(1); // server-side exactly-once, over the real wire
    expect(o1).toEqual(o2);

    // different idempotencyKey → a new call, runs again.
    await tools.pay.execute({ amt: 9 }, { toolCallId: 'c2', idempotencyKey: 'run1:c2' });
    expect(calls).toBe(2);

    await handle.close();
  });

  it('if idempotencyKey is not given, _meta is never sent (backward compatible): every call runs normally', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const gnlServer = createMcpServer({
      journal,
      tools: { pay: { execute: async ({ amt }: any) => (calls++, { charged: amt }) } },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serveMcp(gnlServer, serverTransport);

    const handle = mcpTools({ transport: { kind: 'custom', transport: clientTransport } });
    const tools = await handle.tools();

    // idempotencyKey is NOT in options, and opts.idempotencyKey was not given either → _meta is not sent.
    await tools.pay.execute({ amt: 5 }, { toolCallId: 'c1' });
    await tools.pay.execute({ amt: 5 }, { toolCallId: 'c1' });
    expect(calls).toBe(2); // old behavior preserved

    await handle.close();
  });
});
