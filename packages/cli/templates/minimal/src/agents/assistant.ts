// The chat agent. Demo model: deterministic echo — no API key, so `pnpm dev` works right now.
// Real provider when you are ready:  npx gnl add model <nvidia|openai|anthropic|openai-compatible>
import { echoModel } from '@gnldev/durable/mock';
import type { AgentConfig } from '@gnldev/durable';

export const assistant: AgentConfig = {
  model: echoModel(),
  system: 'You are a helpful assistant. (Demo: echo mock — no API key required.)',
  maxSteps: 4,
};
