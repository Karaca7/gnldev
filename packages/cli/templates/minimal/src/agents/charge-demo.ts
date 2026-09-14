// The proof agent. Its mock model calls the `chargeOrder` tool on the first turn — a real,
// side-effecting tool call you can watch in Studio, still with no API key. Which tool the name
// resolves to is wired in gnl.config.ts, like every other agent↔tool connection in this project.
import { toolCallingModel } from '@gnldev/durable/mock';
import type { AgentConfig } from '@gnldev/durable';

export const chargeDemo: AgentConfig = {
  model: toolCallingModel(),
  system: 'You charge orders, and the same order is never silently charged twice. (Demo: mock model.)',
  maxSteps: 4,
};
