// Deterministic support-agent model — NO API KEY. Flow: first searchPolicy → if refund intent,
// issueRefund (guard approval) → otherwise a policy response. (A real model can be wired in via OPENAI_API_KEY + @ai-sdk/openai.)
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

export function lastUserText(prompt: any[]): string {
  for (let i = (prompt?.length ?? 0) - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
  }
  return '';
}

// Tool result count for this message (AFTER the last user message) → doesn't mix with memory history.
function turnsThisMessage(prompt: any[]): number {
  let lastUser = -1;
  for (let i = 0; i < (prompt?.length ?? 0); i++) if (prompt[i]?.role === 'user') lastUser = i;
  return (prompt ?? []).slice(lastUser + 1).filter((m: any) => m?.role === 'tool').length;
}

function extractOrder(t: string): string {
  const m = /ORD-?\d+/i.exec(t);
  return m ? m[0].toUpperCase().replace('ORD', 'ORD-').replace('--', '-') : 'ORD-1042';
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }], finishReason: 'stop' as const, usage, warnings: [] as any[] });
const call = (name: string, id: string, args: unknown) => ({ content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) }], finishReason: 'tool-calls' as const, usage, warnings: [] as any[] });

export const supportModel: any = {
  specificationVersion: 'v2', provider: 'gnl-demo', modelId: 'support-mock', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    const done = turnsThisMessage(prompt);
    const user = lastUserText(prompt);
    const refund = /refund|return|money ?back|reimburse/i.test(user);
    if (done === 0) return call('searchPolicy', `sp-${Date.now() % 100000}`, { query: user });
    if (done === 1) {
      if (refund) return call('issueRefund', `ir-${Date.now() % 100000}`, { orderId: extractOrder(user), amount: 80 });
      return text('I can help based on our policy. Could you share your order number, or would you like help with something else?');
    }
    return text('Your refund request has been processed and approved ✅. The amount will be credited to your card shortly. Can I help with anything else?');
  },
  doStream: async () => { throw new Error('stream not supported (demo)'); },
};
