// @gnldev/chat-adapter — public export surface. Vercel AI SDK `useChat` (v5) compatibility for @gnldev/durable
// Agents: sentinel-masked UI message streaming, journal→UIMessage history reconstruction, and a Hono
// Chat route (parity with @gnldev/agui's AG-UI adapter, @gnldev/server's own SSE schema).
export { toUIMessageStream, toUIMessageStreamResponse } from './ui-stream.js';
export type { GnlInterruptData, ToUIMessageStreamResponseOptions } from './ui-stream.js';

export { toUIMessages } from './messages.js';
export type { ToUIMessagesOptions, Interrupt } from './messages.js';

export { createChatRoute } from './chat-route.js';
export type { CreateChatRouteOptions } from './chat-route.js';

export { maskSentinelOutput } from './sentinel-mask.js';
export type { MaskedToolOutput } from './sentinel-mask.js';

export { approvalPayload, approve } from './approve.js';
export type { ApprovableInterrupt, ApproveOptions } from './approve.js';
