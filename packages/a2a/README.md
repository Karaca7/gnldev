# @gnldev/a2a

**Remote agent-to-agent**: calls a remote agent on a `@gnldev/server` REST endpoint as an AI SDK tool. **Exactly-once across the network:** runId is deterministic (`a2a:<toolCallId>`) → the remote `runDurable` replays the same runId (a second POST has no side effect). When wrapped in durableTool inside a parent `runDurable`, the remote call is skipped on parent resume.

```bash
npm i @gnldev/a2a   # peer: ai, zod
```

```ts
import { a2aTool } from '@gnldev/a2a';

const tools = {
  research: a2aTool({ endpoint: 'https://agents.internal', agentName: 'researcher' }),
};

// Router/parent agent calls the 'research' tool → POSTs to remote /agents/researcher/run.
await runDurable({ runId: 'parent-1', journal, model, tools, prompt: 'Research X' });
```

## API
- `a2aTool({ endpoint, agentName, description?, headers?, fetchImpl? })` → AI SDK tool
  - `fetchImpl`: for test/custom transport (e.g. Hono `app.request`).

## How it works
The tool POSTs to the remote REST endpoint with a deterministic runId. Since both the remote and parent are durable, there's no double-execution even across the network — deterministic for distributed agent calls.
