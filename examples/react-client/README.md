# @gnl/react-client-example

A demo of `@gnl/client/react`: **useChat + streaming + interrupt approve**. No API key needed (echo mock backend).

Two terminals:

```bash
# 1) backend (echo mock model, :3000)
pnpm --filter @gnl/react-client-example server

# 2) frontend (Vite, :5173 → /agents,/runs proxy → :3000)
pnpm --filter @gnl/react-client-example dev
```

Browser: http://localhost:5173

## What it shows
- [src/App.tsx](src/App.tsx) — `const chat = useChat(client, 'assistant', { stream: true })` → messages, streaming token flow, Approve/Deny for `chat.interrupts`, `chat.loading`/`chat.error`.
- [src/server.ts](src/server.ts) — auto-REST + SSE via `createRestApi(...)`; echo mock model.
- Proxy ([vite.config.ts](vite.config.ts)) for same-origin → no CORS.

## Connecting to your own backend
For a real agent, run the backend with `@gnl/cli` (`gnl dev`) and point `GnlClient`'s baseUrl at it; or change the proxy target.
