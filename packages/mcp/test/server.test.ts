// Sub-batch A — MCP server: listTools + callTool + server-side exactly-once with a journal.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createMcpServer } from '../src/index.js';

describe('@gnl/mcp createMcpServer', () => {
  it('listTools returns definitions; callTool executes', async () => {
    const server = createMcpServer({
      tools: {
        echo: { description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } }, execute: async ({ msg }: any) => `echo:${msg}` },
      },
    });
    expect(server.listTools().tools[0]).toMatchObject({ name: 'echo', description: 'echo' });
    expect(await server.callTool({ name: 'echo', arguments: { msg: 'hi' } })).toBe('echo:hi');
  });

  it('journal + idempotencyKey → server-side exactly-once (same key → execute runs once)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const server = createMcpServer({
      journal,
      tools: { pay: { execute: async ({ amt }: any) => (calls++, { charged: amt }) } },
    });

    const a = await server.callTool({ name: 'pay', arguments: { amt: 5 }, idempotencyKey: 'req-1' });
    const b = await server.callTool({ name: 'pay', arguments: { amt: 5 }, idempotencyKey: 'req-1' }); // same key

    expect(calls).toBe(1); // server-side exactly-once
    expect(a).toEqual(b);

    // different key → runs again
    await server.callTool({ name: 'pay', arguments: { amt: 9 }, idempotencyKey: 'req-2' });
    expect(calls).toBe(2);
  });

  it('unknown tool → error', async () => {
    const server = createMcpServer({ tools: {} });
    await expect(server.callTool({ name: 'nope' })).rejects.toThrow('no such tool');
  });
});

// ---- Arg validation: if inputSchema is executable (safeParse / ~standard), applied BEFORE execute ----
describe('@gnl/mcp callTool arg validation', () => {
  /** zod-like fake schema: expects { msg: string }, applies a default if msg is missing (for the transform test). */
  const zodLike = {
    safeParse(args: any) {
      if (typeof args?.msg === 'number')
        return { success: false, error: { issues: [{ path: ['msg'], message: 'expected string, got number' }] } };
      return { success: true, data: { msg: args?.msg ?? 'default' } }; // value with default/coercion applied
    },
  };

  it('invalid arg (wrong type) → structured error (isError+content), execute is NEVER called', async () => {
    let calls = 0;
    const server = createMcpServer({
      tools: { echo: { inputSchema: zodLike, execute: async ({ msg }: any) => (calls++, `echo:${msg}`) } },
    });
    const res = await server.callTool({ name: 'echo', arguments: { msg: 42 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('Invalid argument'); // what
    expect(res.content[0].text).toContain('msg'); // which field
    expect(res.content[0].text).toContain('expected string'); // why
    expect(calls).toBe(0); // execute never called
  });

  it('valid arg → runs; execute receives the TRANSFORMED value (default applied)', async () => {
    const server = createMcpServer({
      tools: { echo: { inputSchema: zodLike, execute: async ({ msg }: any) => `echo:${msg}` } },
    });
    expect(await server.callTool({ name: 'echo', arguments: { msg: 'hi' } })).toBe('echo:hi');
    expect(await server.callTool({ name: 'echo', arguments: {} })).toBe('echo:default'); // default flowed through
  });

  it('the standard-schema (~standard) interface is also detected (including async validate)', async () => {
    const stdSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (args: any) =>
          typeof args?.n === 'number' ? { value: { n: args.n } } : { issues: [{ path: [{ key: 'n' }], message: 'expected number' }] },
      },
    };
    let calls = 0;
    const server = createMcpServer({
      tools: { inc: { inputSchema: stdSchema, execute: async ({ n }: any) => (calls++, n + 1) } },
    });
    expect(await server.callTool({ name: 'inc', arguments: { n: 1 } })).toBe(2);
    const bad = await server.callTool({ name: 'inc', arguments: { n: 'x' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('n: expected number');
    expect(calls).toBe(1); // only the valid call ran
  });

  it('a schema-less / plain JSON Schema (unvalidatable) tool → old behavior (validation skipped, passes)', async () => {
    const server = createMcpServer({
      tools: {
        raw: { execute: async (a: any) => a }, // no schema
        jsonly: { inputSchema: { type: 'object', properties: { msg: { type: 'string' } } }, execute: async (a: any) => a }, // plain JSON Schema
      },
    });
    // Even a type that's "wrong" per the JSON Schema isn't rejected — there's no interpreter, so we don't risk false positives.
    expect(await server.callTool({ name: 'raw', arguments: { x: 1 } })).toEqual({ x: 1 });
    expect(await server.callTool({ name: 'jsonly', arguments: { msg: 42 } })).toEqual({ msg: 42 });
  });

  it('the transformed value also flows through the journal + idempotencyKey path; invalid arg is not cached', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const server = createMcpServer({
      journal,
      tools: { echo: { inputSchema: zodLike, execute: async ({ msg }: any) => (calls++, `echo:${msg}`) } },
    });
    const bad = await server.callTool({ name: 'echo', arguments: { msg: 1 }, idempotencyKey: 'k1' });
    expect(bad.isError).toBe(true);
    expect(calls).toBe(0);
    // Same key with a valid arg → works normally since the validation error isn't cached.
    expect(await server.callTool({ name: 'echo', arguments: {}, idempotencyKey: 'k1' })).toBe('echo:default');
    expect(calls).toBe(1);
  });
});
