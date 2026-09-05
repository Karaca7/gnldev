// The triage agent: what it may read, what it may do, and what it must ask a human about first.
import { z } from 'zod';
import { stepCountIs } from 'ai';
import { createGnl, resumeRun } from '@gnldev/durable';
import { AgentMemory } from '@gnldev/memory';
import { piiRedactor } from '@gnldev/processors';
import { defaultRules } from '@gnldev/tool-schema';
import { buildRunbooks } from './runbooks.js';
import { buildTools, newFleet, type Fleet } from './tools.js';
import { buildModel } from './model.js';

/** The fake production system's metrics. `checkout` is the one with the leak. */
const metric = (service: string, name: string): number => {
  if (name === 'memory_rss_mb') return service === 'checkout' ? 1932 : 640;
  if (name === 'p99_ms') return service === 'search' ? 2400 : 180;
  return 0;
};

/**
 * @param extraTools tools that come from outside this process — in the demo, the A2A handle to the
 *   database specialist (see specialist.ts). Injected rather than imported so `buildTriage` stays
 *   usable on its own, which is what the tests rely on.
 */
export async function buildTriage(storage: any, extraTools: Record<string, any> = {}) {
  const journal = storage.runs;
  const fleet: Fleet = newFleet();
  const model = await buildModel();
  const { searchRunbook, embed } = await buildRunbooks(storage);
  const tools = { searchRunbook, ...buildTools(fleet, metric), ...extraTools };

  /**
   * The one thing a human decides.
   *
   * A restart is the only action here that changes production, so it is the only one that stops the
   * run. Everything else — reading metrics, reading logs, searching the runbook — proceeds, because a
   * gate on a read costs an engineer's attention and buys nothing.
   *
   * The run SUSPENDS rather than blocks: approval can take a minute or an hour, and a process holding
   * a socket open for that long is a process that will be restarted before the answer arrives.
   */
  const guard = ({ toolName, args }: any) =>
    toolName === 'restartService'
      ? { action: 'require-approval' as const, reason: `restarting ${args?.service} interrupts live traffic` }
      : { action: 'allow' as const };

  const memory = new AgentMemory({
    storage,
    embed,
    recentN: 8,
    // Scoped to the SERVICE, not to the engineer: what matters at 3am is what happened to `checkout`
    // last time, whoever was holding the pager then.
    recall: { topK: 3, scope: 'resource' },
    workingMemory: { schema: z.object({ service: z.string().optional(), severity: z.string().optional() }) },
  });

  const agents = {
    triage: {
      model,
      tools,
      guard,
      system:
        'You are an on-call engineer. Read the runbook before acting, gather the numbers it asks ' +
        'for, and follow it. Never restart a service the runbook does not tell you to restart.',
      maxSteps: 8,
    },
  };

  const gnl = createGnl({
    storage,
    memory,
    // The redactor is not decoration here. `readLog` returns lines carrying a customer's email
    // address AND a database connection string (see tools.ts), and an on-call agent's entire job is
    // reading logs — so without this, running the agent means posting production secrets to a model
    // provider. Redacting the TOOL RESULT is opt-in because it changes what gets journalled; for this
    // workload it is the whole point, so it is on.
    //
    // The built-in set is PII — email, phone, card, IBAN, SSN, IP. A DSN password is not PII, it is a
    // Credential, and `piiRedactor` does not pretend to know your secrets. That gap is real and it is
    // Measurable: with only the defaults, `postgres://svc:hunter2@pg-primary/orders` reaches the model
    // Verbatim while the email beside it is masked. `extraPatterns` is where you close it.
    //
    // The pattern masks the CREDENTIALS and keeps the host, because at 3am "which database" is the
    // Question and `[REDACTED]` for the whole URL answers none of it.
    processors: [
      piiRedactor({
        redactToolResults: true,
        extraPatterns: [
          { name: 'dsn', pattern: /(?<=:\/\/)[^\s:@/]+:[^\s@/]+(?=@)/g, mask: '[REDACTED_DSN_CREDENTIALS]' },
        ],
      }),
    ],
    // Rewrites tool schemas for whichever provider is actually in use. Invisible until the day you
    // Point this at OpenAI in strict mode and a schema it silently rejects takes the agent down.
    schemaCompat: defaultRules,
    agents,
  });

  /** Continues a suspended run once a human has answered the approval. */
  const resume = (runId: string, approvals: Record<string, boolean>) =>
    resumeRun(runId, { journal, model, tools, guard, stopWhen: stepCountIs(8), approvals });

  return { gnl, agents, memory, resume, fleet, journal, tools, model, guard };
}
