// Support agent: createGnl registry + tools (RAG searchPolicy, lookupOrder, issueRefund[with guard], escalate)
// + AgentMemory (per-customer recall + working memory) + processors (PII redaction + moderation) + guard.
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createGnl, resumeRun } from '@gnl/durable';
import type { Storage } from '@gnl/durable';
import { AgentMemory } from '@gnl/memory';
import { piiRedactor, moderationProcessor } from '@gnl/processors';
import { enqueue } from '@gnl/queue';
import { emit } from '@gnl/events';
import { supportModel } from './model.js';
import { buildKnowledge, ORDERS } from './knowledge.js';

export interface AppState {
  refunds: { count: number; total: number };
}

export async function buildSupport(storage: Storage, state: AppState) {
  const journal = storage.runs; // queue/events/resume work through the low-level journal (RunJournal)
  const { searchPolicy, embed } = await buildKnowledge(storage.cache!);

  const tools = {
    searchPolicy,
    lookupOrder: tool({
      description: 'Fetches the status and amount of an order',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ORDERS[orderId] ?? { error: 'order not found' },
    }),
    issueRefund: tool({
      description: 'Processes a refund for an order (side effect — exactly-once)',
      inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
      execute: async ({ orderId, amount }) => {
        // Because durableTool wraps it, this side effect runs EXACTLY ONCE (not repeated on resume).
        state.refunds.count++;
        state.refunds.total += amount;
        await enqueue(storage.work!, 'send-email', { orderId, amount }, { id: `email:${orderId}` }); // background email
        await emit(storage.work!, 'refunds', { orderId, amount }, { id: `refund:${orderId}` }); // event publish
        return { refunded: amount, orderId, status: 'approved' };
      },
    }),
    escalate: tool({
      description: 'Escalates the request to a human',
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => ({ escalated: true, reason }),
    }),
  };

  // General policy: high-value refunds require human approval (suspend → resume via /approve).
  const guard = ({ toolName, args }: any) =>
    toolName === 'issueRefund' && (args as any).amount > 50
      ? { action: 'require-approval' as const, reason: `refund of ${(args as any).amount}₺ requires approval` }
      : { action: 'allow' as const };

  const memory = new AgentMemory({
    storage,
    embed,
    recentN: 8,
    recall: { topK: 3, scope: 'resource' }, // recall across all of the customer's tickets
    workingMemory: { schema: z.object({ name: z.string().optional(), plan: z.string().optional() }) },
  });

  const gnl = createGnl({
    storage,
    memory,
    processors: [piiRedactor(), moderationProcessor({ blocklist: ['stupid', 'idiot'] })],
    agents: {
      support: {
        model: supportModel,
        tools,
        guard,
        system: 'You are a polite customer support representative. Use the policies, and process refunds when needed.',
        maxSteps: 8,
      },
    },
  });

  // Resume after approval (continues the suspended refund): the input is read from the journal.
  const resume = (runId: string, approvals: Record<string, boolean>) =>
    resumeRun(runId, { journal, model: supportModel, tools, guard, stopWhen: stepCountIs(8), approvals });

  return { gnl, memory, resume };
}
