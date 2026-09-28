// The contract between a wire format and a stream door: `chatSurface()` (@gnldev/chat-adapter) and
// `aguiSurface()` (@gnldev/agui) implement it, `createRestApi({ surfaces })` (@gnldev/server) mounts it.
//
// WHY IN @gnldev/durable. It used to live in @gnldev/server, so @gnldev/agui depended on server to
// type its own surface. ADR-0002 point 0: a door package works without any other door package. The
// contract therefore sits in the package every door already depends on, and the dependency arrows
// all point down: server → durable, agui → durable, chat-adapter → durable. Types only — nothing
// here runs.
//
// The HTTP framework's request context is a type parameter, so this package stays free of Hono.
// Server instantiates it with Hono's `Context` (`StreamSurface<Context>`).
import type { RunLimits } from './limits.js';

/** What a surface's decoder hands the stream door: the REST `/stream` body shape, plus a turn key. */
export interface StreamSurfaceInput {
  prompt?: string;
  messages?: unknown;
  threadId?: string;
  approvals?: Record<string, boolean>;
  context?: Record<string, unknown>;
  limits?: RunLimits;
  /** An explicit id — addressing already decided by the caller. */
  runId?: string;
  /** A declared name for the work (always a workKey). */
  workKey?: string;
  /**
   * The wire format's own name for this turn (useChat: `${id}:${lastMessage.id}`). Becomes a workKey
   * when the door resolves a subject, a raw runId otherwise — the regime the standalone routes had.
   */
  turnKey?: string;
  /**
   * The subject the BODY names. Read only for callers allowed to name one (application / operator);
   * a subject token's own id always wins — the same `resolveResourceId` rule REST applies.
   */
  resourceId?: unknown;
  lastEventId?: string | number;
}

/** A wire format mounted on a stream door (@gnldev/server's `RestApiOptions.surfaces`). */
export interface StreamSurface<Ctx = unknown> {
  /** POST path under the API; must contain `:name` (the agent). E.g. `/agents/:name/chat`. */
  path: string;
  /** Wire format in. Throwing answers 400. Must not decide identity — it is never asked. */
  decode(body: any, req: Request): StreamSurfaceInput | Promise<StreamSurfaceInput>;
  /** Wire format out, for a started run. Error responses before the run are the door's own (typed JSON). */
  encode(result: any, meta: { runId: string; threadId?: string; c: Ctx }): Response;
}
