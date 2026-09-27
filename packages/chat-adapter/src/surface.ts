// chatSurface: the useChat wire format as a SURFACE of @gnldev/server's createRestApi.
//
// It decodes and encodes and does nothing else. Identity, organization, subject and every gate come
// from the REST door it is mounted on (`createRestApi(config, { auth, surfaces: [chatSurface()] })`),
// so there is no `identity` option here to leave unwired, and no second copy of the auth decision.
// Structurally typed against server's `StreamSurface`: the dependency direction stays
// chat-adapter → durable, never chat-adapter → server.
import { convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { toUIMessageStreamResponse } from './ui-stream.js';

export interface ChatSurfaceOptions {
  /** Mount path under the REST API. Default `/agents/:name/chat`. */
  path?: string;
}

export function chatSurface(opts: ChatSurfaceOptions = {}) {
  return {
    path: opts.path ?? '/agents/:name/chat',
    async decode(body: {
      id?: string;
      messages?: UIMessage[];
      runId?: string;
      threadId?: string;
      approvals?: Record<string, boolean>;
      context?: Record<string, unknown>;
      resourceId?: unknown;
    }) {
      const last = body.messages?.[body.messages.length - 1];
      // The same per-turn name the standalone route derives: `${conversation}:${lastMessage}`. The
      // door promotes it to a workKey when it has a subject, keeps it a raw id otherwise; with neither
      // a turn name nor an id, a fresh id (no dedup — the standalone route's anonymous fallback).
      const turnKey = body.id && last?.id ? `${body.id}:${last.id}` : undefined;
      return {
        messages: await convertToModelMessages(body.messages ?? []),
        threadId: body.threadId ?? body.id,
        ...(body.approvals ? { approvals: body.approvals } : {}),
        ...(body.context ? { context: body.context } : {}),
        ...(body.runId ? { runId: body.runId } : turnKey ? { turnKey } : { runId: `chat-${crypto.randomUUID()}` }),
        // Only an application/operator may name a subject; a subject token's own id wins at the door.
        ...(body.resourceId !== undefined ? { resourceId: body.resourceId } : {}),
      };
    },
    encode(result: any, meta: { runId: string }): Response {
      return toUIMessageStreamResponse(result, { runId: meta.runId });
    },
  };
}
