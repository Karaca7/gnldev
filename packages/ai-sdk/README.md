# @gnldev/ai-sdk

Compatibility with the Vercel AI SDK's UI layer: run a durable agent on the server, render it with
`useChat` on the client.

## Install

```bash
npm i @gnldev/ai-sdk
```

## Chat route

```ts
import { createChatRoute } from '@gnldev/ai-sdk';

app.post('/api/chat', createChatRoute(gnl, 'support'));
```

The route streams back in the AI SDK's UI-message format, so an existing `useChat` frontend works
unchanged — while the run behind it is journaled, replayable and exactly-once.

## Rebuilding history from the journal

```ts
import { toUIMessages } from '@gnldev/ai-sdk';

const messages = toUIMessages(await journal.list(runId));
```

The journal is the source of truth, so a reconnecting client can rebuild the conversation without
the server holding session state.

## Exports

| Export | What it is |
|---|---|
| `createChatRoute` | A handler that runs an agent and streams UI messages |
| `toUIMessageStream` / `toUIMessageStreamResponse` | Converts a durable stream into the UI-message wire format, masking the internal sentinels |
| `toUIMessages` | Journal records → `UIMessage[]` for history reconstruction |

## A note on history

`useChat` posts the entire client-side history on every turn. When the agent has memory and a
`threadId`, the server owns the history instead — the client's copy is a view, not the record. That
contract is enforced in the core, not here.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
