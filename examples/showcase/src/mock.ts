// NO API key required — deterministic mocks (imported and used like a real consumer).
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

export function countToolResults(prompt: any[]): number {
  return (prompt ?? []).filter((m) => m?.role === 'tool').length;
}

export function finalText(text: string) {
  return { content: [{ type: 'text', text }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
}
export function toolCall(toolName: string, toolCallId: string, args: unknown) {
  return { content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(args) }], finishReason: 'tool-calls' as const, usage, warnings: [] as any[] };
}

export function mkModel(doGenerate: (o: any) => Promise<any>): any {
  return { specificationVersion: 'v2', provider: 'mock', modelId: 'mock', supportedUrls: {}, doGenerate, doStream: async () => { throw new Error('no stream'); } };
}

/** Based on conversation state: 0 tool results → call the tool; otherwise final. */
export function agentModel(toolName: string, toolCallId: string, args: unknown, final = 'Done.'): any {
  return mkModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCall(toolName, toolCallId, args) : finalText(final)));
}

/** Deterministic embed (keyword counting). */
const DIMS = ['refund', 'shipping', 'invoice', 'password', 'account'];
export const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1);
};

/** Fake MCP client (counts callTool). */
export function fakeMcpClient(counter: { calls: number }) {
  return {
    listTools: async () => ({ tools: [{ name: 'lookup', description: 'search record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }),
    callTool: async ({ name, arguments: a }: any) => (counter.calls++, { content: [{ type: 'text', text: `${name}:${(a as any)?.id}` }] }),
  };
}
