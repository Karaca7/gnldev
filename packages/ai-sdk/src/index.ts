// @gnl/ai-sdk — public export surface. Vercel AI SDK `useChat` (v5) compatibility for @gnl/durable
// agents: sentinel-masked UI message streaming, journal→UIMessage history reconstruction, and a Hono
// chat route (parity with @gnl/agui's AG-UI adapter, @gnl/server's own SSE schema).
export { toUIMessageStream, toUIMessageStreamResponse } from './ui-stream.js';
export type { GnlInterruptData, ToUIMessageStreamResponseOptions } from './ui-stream.js';

export { toUIMessages } from './messages.js';
export type { ToUIMessagesOptions, Interrupt } from './messages.js';

export { createChatRoute } from './chat-route.js';
export type { CreateChatRouteOptions } from './chat-route.js';

export { maskSentinelOutput } from './sentinel-mask.js';
export type { MaskedToolOutput } from './sentinel-mask.js';
