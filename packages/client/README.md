# @gnldev/client

A typed client for talking to agents exposed by `@gnldev/server` — plain HTTP and SSE streaming,
with React hooks on top.

## Install

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/client
```

## One-shot run

```ts
import { GnlClient } from '@gnldev/client';

const api = new GnlClient({ baseUrl: 'http://localhost:3000' });
const result = await api.run('support', { prompt: 'where is my order?' });
console.log(result.text, result.runId);
```

Naming the run matters — and there are two ways to do it. Pass a **`workKey`**, your name for the
unit of work (`api.run('billing', { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt })`), and
the same key later is routed to the same run: the journal replays instead of repeating side effects.
The engine mints the id and hands it back as `result.runId`. Or pass a raw **`runId`** you already
hold. Send neither and the client generates a runId for you; send both and the server refuses, so it
never invents one beside your `workKey`.

## Streaming

```ts
for await (const ev of api.stream('support', { prompt: 'hello' })) {
  if (ev.event === 'text-delta') process.stdout.write(ev.data.text);
}
```

## React

```tsx
import { useChat } from '@gnldev/client/react';
import type { GnlClient } from '@gnldev/client';

function Chat({ api }: { api: GnlClient }) {
  const { messages, input, setInput, send, loading, interrupts, approve } = useChat(api, 'support');
  return (
    <>
      {messages.map((m, i) => <p key={i}><b>{m.role}</b>: {m.content}</p>)}
      {interrupts.map((it) => (
        <button key={it.toolCallId} onClick={() => approve(it.toolCallId, true)}>approve</button>
      ))}
      <input value={input} onChange={(e) => setInput(e.target.value)} disabled={loading} />
      <button onClick={send} disabled={loading}>send</button>
    </>
  );
}
```

`useGnlAgent` is the lower-level hook if you want `run`/`stream`/`resume` without the input-box
state. Both surface `interrupts` — the tool calls the server paused for approval — and `approve`
resumes the **same run** rather than starting a new one.

## Exports

| Export | What it is |
|---|---|
| `GnlClient` | The client: `run`, `stream`, `resume`, `listAgents` |
| `useGnlAgent` / `useChat` | React hooks (from `@gnldev/client/react`) |
| `parseSSEStream` | The SSE parser, usable on its own |
| `applyRunResult`, `applyStreamEvent`, `appendUserMessage` | The pure reducers the hooks are built from — testable without a renderer |
| `genRunId` | A run id generator, if you want to mint one client-side |

## License

Apache-2.0 — see [LICENSE](./LICENSE).
