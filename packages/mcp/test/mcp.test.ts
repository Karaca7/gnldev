// 8.9 — createMcpTools: an MCP tool becomes an AI SDK tool; wrapped with durableTool the MCP call is exactly-once.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, durableTool } from '@gnldev/durable';
import { createMcpTools, type McpClientLike } from '../src/index.js';

function fakeClient(counter: { calls: number }, lastParams?: { value?: any }): McpClientLike {
  return {
    listTools: async () => ({
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }],
    }),
    callTool: async (params) => {
      counter.calls++;
      if (lastParams) lastParams.value = params;
      const a = params.arguments;
      return { content: [{ type: 'text', text: `echo:${(a as any)?.msg}` }] };
    },
  };
}

describe('8.9 createMcpTools', () => {
  it('MCP tool → AI SDK tool; prefix is applied', async () => {
    const counter = { calls: 0 };
    const tools = await createMcpTools(fakeClient(counter), { prefix: 'mcp_' });
    expect(Object.keys(tools)).toEqual(['mcp_echo']);
    expect(typeof tools['mcp_echo'].execute).toBe('function');
  });

  it('MCP call is exactly-once via durableTool (same toolCallId → callTool runs once)', async () => {
    const counter = { calls: 0 };
    const tools = await createMcpTools(fakeClient(counter));
    const journal = new InMemoryJournal();
    const dt = durableTool(tools['echo'], { journal, runId: 'r' }, 'echo');

    const o1 = await dt.execute!({ msg: 'hi' }, { toolCallId: 'c1' });
    const o2 = await dt.execute!({ msg: 'hi' }, { toolCallId: 'c1' }); // replay

    expect(counter.calls).toBe(1); // outer MCP call is exactly-once
    expect(o1).toEqual(o2);
    expect(o1).toEqual([{ type: 'text', text: 'echo:hi' }]);
  });
});
