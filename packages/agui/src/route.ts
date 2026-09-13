// pipeAguiStream: the AG-UI-output counterpart of @gnldev/server's pipeAgentStream. Streams fullStream (AI SDK
// StreamTextResult) as SSE, but instead of writing GNL's own event/data schema, converts it via toAguiEvents
// and writes AG-UI events. createAguiRoute: a small single-endpoint (POST /agents/:name/run) factory —
// an endpoint that CopilotKit's AG-UI HttpAgent can POST to.
//
// NOTE (deliberate choice — don't break the architecture): the switch that converts fullStream parts to the
// GNL event/data shape is copied from INSIDE pipeAgentStream in packages/server/src/sse.ts (there is no
// exported hook). sse.ts is a sensitive file carrying the W3 resumable-id contract and locked in by
// process-kill/exactly-once tests — rather than adding a "sink" parameter there, keeping a small,
// independent copy here is safer (without touching the existing architecture). The event/data shape of the
// two copies must be kept in sync with sse.ts; see test/route.test.ts (parallel tests with the same mock patterns).
import type { Context } from 'hono';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { Hono } from 'hono';
import { limitBreachFromSteps, blockedFromSteps, BLOCKED_ERROR_CODES, blockedErrorCode, callerConflictCode, sealRequestContext, resolveWorkIdentity } from '@gnldev/durable';
import type { CreateGnlConfig, GnlIdentity, ResolvedWorkIdentity } from '@gnldev/durable';
import { createGnl } from '@gnldev/durable';
import { streamSSE } from 'hono/streaming';
// The two limit codes are READ from @gnldev/server rather than spelled again here. The event/data
// SHAPE is deliberately a copy (see the note above), but a code is not a shape: it is the string a
// caller matches on, and this route mirroring sse.ts by hand is exactly how the docs check ended up
// with a list it had to maintain. `interruptsFromSteps` already makes this a build-order dependency.
import { interruptsFromSteps, EDGE_ERROR_CODES } from '@gnldev/server';
import { toAguiEvents, initialAguiConvertState, type GnlSseEvent } from './convert.js';
import { EventType, type AguiEvent, type RunStartedEvent } from './types.js';

export interface PipeAguiStreamOptions {
  /** AG-UI threadId. If not given, runId is used (single-thread default). */
  threadId?: string;
}

/** Stream fullStream as AG-UI SSE events (starts with RUN_STARTED, ends with RUN_FINISHED/RUN_ERROR). */
export function pipeAguiStream(c: Context, runId: string, result: any, opts?: PipeAguiStreamOptions) {
  const threadId = opts?.threadId ?? runId;
  const ctx = { threadId, runId };
  // The header patch, written out rather than imported from @gnldev/server: importing a runtime
  // helper across packages resolves through that package's BUILT output, and a stale dist turns the
  // call into `undefined` — measured, this exact swap emptied the stream and every test here failed
  // on `JSON.parse('')`. Six lines of duplication beats a build-order dependency.
  //
  // Why the headers: Hono sets `Cache-Control: no-cache`, which says nothing about re-encoding, so a
  // compression middleware in the host's chain buffers the stream into one chunk delivered at the
  // end (measured on Express: 13 progressive chunks became 1). `no-transform` stops it;
  // `X-Accel-Buffering: no` is the nginx half — measured behind a real one: load-bearing exactly
  // when the client speaks HTTP/1.1 to a gzipping proxy (without it the stream collapses into one
  // chunk at the end), and inert otherwise, HTTP/2 included.
  // Kept IN SYNC with packages/server/src/sse.ts and packages/studio/src/sse.ts.
  const res = streamSSE(c, async (stream) => {
    // In AG-UI every SSE frame is a single JSON event; the type is inside the event JSON (the spec has
    // no event/data split of its own) → the SSE `event:` field is NOT USED, only `data:` is written.
    const write = async (event: AguiEvent) => {
      await stream.writeSSE({ data: JSON.stringify(event) });
    };
    let state = initialAguiConvertState;
    const emit = async (gnlEvent: GnlSseEvent) => {
      const out = toAguiEvents(gnlEvent, ctx, state);
      state = out.state;
      for (const e of out.events) await write(e);
    };
    const started: RunStartedEvent = { type: EventType.RUN_STARTED, threadId, runId };
    await write(started);
    try {
      for await (const part of result.fullStream) {
        if (stream.aborted) break;
        switch (part.type) {
          case 'text-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit({ event: 'text-delta', data: { text } });
            break;
          }
          case 'tool-call':
            await emit({ event: 'tool-call', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } });
            break;
          case 'tool-result':
            if (part.output?.__gnl_suspend) break; // suspend sentinel is carried by the interrupt event
            if (part.output?.__gnl_limit_exceeded) break; // INTERNAL API sentinel — does not leak, carried by the error event
            if (part.output?.__gnl_blocked) break; // K1: the block sentinel is also an INTERNAL API — carried by the error event
            await emit({ event: 'tool-result', data: { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } });
            break;
          // P0.1: kept IN SYNC with sse.ts (see the sync note at the top of this file) — reasoning/
          // tool-input/source/file/step/tool-error events + the raw marker; nothing silently dropped.
          case 'reasoning-start':
            await emit({ event: 'reasoning-start', data: { id: part.id } });
            break;
          case 'reasoning-delta': {
            const text = part.text ?? part.delta ?? '';
            if (text) await emit({ event: 'reasoning-delta', data: { id: part.id, text } });
            break;
          }
          case 'reasoning-end':
            await emit({ event: 'reasoning-end', data: { id: part.id } });
            break;
          case 'tool-input-start':
            await emit({ event: 'tool-input-start', data: { toolCallId: part.toolCallId ?? part.id, toolName: part.toolName } });
            break;
          case 'tool-input-delta':
            await emit({ event: 'tool-input-delta', data: { toolCallId: part.toolCallId ?? part.id, delta: part.delta } });
            break;
          case 'tool-input-end':
            await emit({ event: 'tool-input-end', data: { toolCallId: part.toolCallId ?? part.id } });
            break;
          case 'source':
            await emit({ event: 'source', data: { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title } });
            break;
          case 'file':
            await emit({ event: 'file', data: { mediaType: part.file?.mediaType, base64: part.file?.base64 } });
            break;
          case 'start-step':
            await emit({ event: 'step-start', data: {} });
            break;
          case 'finish-step':
            await emit({ event: 'step-finish', data: { finishReason: part.finishReason, usage: part.usage } });
            break;
          case 'tool-error':
            await emit({ event: 'tool-error', data: { toolCallId: part.toolCallId, toolName: part.toolName, error: String((part as any).error?.message ?? (part as any).error) } });
            break;
          case 'error':
            await emit({ event: 'error', data: { error: String((part as any).error?.message ?? (part as any).error) } });
            break;
          case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw':
            break; // deliberately no event — same list and reasons as sse.ts
          default:
            await emit({ event: 'raw', data: { type: part.type } }); // unknown part → type-only marker, never silent
            break;
        }
      }
      const steps = await result.steps;
      const breach = limitBreachFromSteps(steps);
      if (breach) {
        await emit({
          event: 'error',
          data: {
            error: breach.message,
            code: breach.kind === 'loop' ? EDGE_ERROR_CODES.toolLoopDetected : EDGE_ERROR_CODES.runLimitExceeded,
            detail: breach.detail,
          },
        });
        return;
      }
      // K1: the block sentinel (side-effect/retry/busy) → same contract as a limit breach: terminal error, no done.
      const blocked = blockedFromSteps(steps);
      if (blocked) {
        await emit({ event: 'error', data: { error: blocked.message, code: BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy', detail: blocked.detail } });
        return;
      }
      const interrupts = interruptsFromSteps(steps);
      // FAZ-2 (chat-adapter parity): the approval ADDRESS travels with the interrupt — a client that
      // resumes without this runId starts a fresh run and the suspended one leaks forever. Parity is
      // measured by SCHEMA POSITION, not field name: chat-adapter stamps runId INSIDE each record
      // (ui-stream.ts), so a shared client helper (approvalPayload) must find it there on BOTH
      // adapters — the envelope copy stays for consumers already reading it.
      if (interrupts.length) await emit({ event: 'interrupt', data: { interrupts: interrupts.map((i) => ({ ...i, runId })), runId } });
      const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
      const usage = await Promise.resolve(result.usage).catch(() => undefined);
      await emit({ event: 'done', data: { runId, finishReason, usage } });
    } catch (e: any) {
      await emit({ event: 'error', data: { error: String(e?.message ?? e) } });
    }
  });
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
}

/**
 * The caller's own name for the work, reflected back in a refusal (§8, rules 1-3).
 *
 * FROM THE REQUEST, never from storage: a swept run keeps only a hash of its workKey (§10.3), so
 * reading the name back would undo a deletion. The caller already knows what it sent.
 *
 * `detail` and not `error`: the sentence is the most casually logged field in any HTTP client, and a
 * workKey is a business name. Same three lines as @gnldev/server's and @gnldev/chat-adapter's — the
 * dependency direction forbids sharing one (agui → durable, never agui → server for a renderer).
 */
function withWorkKey(detail: unknown, workKey?: string): unknown {
  if (workKey === undefined) return detail;
  return detail && typeof detail === 'object' ? { ...(detail as Record<string, unknown>), workKey } : { workKey };
}

export interface CreateAguiRouteOptions {
  /** AG-UI threadId resolver (from request + body). If not given, uses body.threadId, else runId. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
  /**
   * WHO this request acts for — resolved from something the SERVER trusts, never from the body.
   *
   * This route declares auth out of scope (see createAguiRoute's own note) and that boundary is
   * right. What was NOT right is what the boundary implied: `body.context` went to the engine
   * untouched, and the engine reads the reserved context keys as "the server established this". So
   * a request could name its own subject. Measured on the sibling route (chat-adapter, identical
   * shape): a POST carrying `{"context":{"__gnl_resourceId":"KURBAN"}}` produced a run owned by
   * that name — and once ownership stamping landed, the forged name became the LOCK's value too,
   * i.e. the caller handed itself the key.
   *
   * The route now always seals. With no resolver the seal carries no identity, which strips the
   * reserved keys: no forged subject gets in, and none is asserted either.
   *
   * HONEST BOUND: a resolver reading an unauthenticated request asserts a subject nobody verified.
   * Put auth in front of this route, or the subject is only as good as the caller's honesty.
   */
  resolveResourceId?: (c: Context, body: any) => string | undefined;
  /**
   * WHO and WHICH CONVERSATION, in one hook — the SAME signature @gnldev/chat-adapter's route takes, so a
   * host that has written this function once can mount either adapter with it.
   *
   * One signature for both routes is the point. Until now the two adapters asked the same question
   * with two hooks each, in two shapes, and this one had the sharper lesson: `resolveThreadId` was
   * called, its answer went into the SSE envelope, and the run still read and wrote the thread the
   * client named (see the Turkish note in the stream call below). A host could wire identity, watch
   * the right value appear in the response, and have changed nothing about where memory went.
   *
   * Takes the web `Request` rather than the Hono `Context`, matching @gnldev/server's `OrgOptions.resolve`:
   * a host mounting this from Express or Fastify has a Request and no Context.
   *
   * PRECEDENCE: `resolveResourceId` / `resolveThreadId` still win, field by field — an existing
   * deployment's answer is not taken away by a newer convenience. Called once per request.
   *
   * HONEST BOUND: this route declares auth out of scope. A resolver reading an unauthenticated
   * request asserts a subject nobody verified.
   */
  identity?: GnlIdentity;
}

/**
 * Produces a single-endpoint Hono router from a createGnl config that CopilotKit's AG-UI HttpAgent can talk to:
 * POST /agents/:name/run   {runId, prompt|messages, threadId?, approvals?}  → AG-UI SSE
 * Deliberately kept small: NO auth/org/budget gates (if needed, use @gnldev/server's createRestApi
 * and pass its stream result to pipeAguiStream — see README).
 */
function aguiRouteApp(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): Hono {
  const gnl = createGnl(config);
  // Same warning, same wording and same posture as @gnldev/chat-adapter's route: in production, a route
  // that can name nobody starts runs that are born ownerless, and an ownership gate with no owner to
  // compare against passes. Warn once at construction — never throw, because a deployment that puts
  // its own boundary in front of this route is not broken and must not be stopped at boot.
  if (process.env.NODE_ENV === 'production' && !opts.identity && !opts.resolveResourceId) {
    console.warn(
      '[gnl agui-route] no `identity` and no `resolveResourceId` in production — runs will be born ownerless; ' +
      'ownership gates stay fail-open (a run with no owner is refused to nobody). Pass `identity: (req) => ({ resourceId })` ' +
      'reading your session/JWT — never the request body.',
    );
  }
  const app = new Hono();
  app.post('/agents/:name/run', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as any;
    // Resolved once — the same reason chat-adapter states: a resolver that reads the request may
    // answer differently the second time, and these two fields must agree about who this is.
    // Resolved FIRST, because the identity decision below cannot be made without knowing the subject.
    const ident = await opts.identity?.(c.req.raw);
    const subject = opts.resolveResourceId?.(c, body) ?? ident?.resourceId;
    // WHICH ORGANIZATION — only `identity` can say, and never the body. Same rule and same reason as
    // the sibling route: an org is an isolation boundary, so it comes from the hook that already
    // reads a verified session, and `sealRequestContext` strips any the caller tried to assert.
    const org = ident?.orgId;
    // WHICH RUN (package #5, §7). Two names can arrive, and they follow different rules:
    //
    //   `body.workKey` — DECLARED. Always a workKey, always fail-closed: without an address the
    //   engine cannot tell whose job this is (§6), and the field is new, so nobody loses anything.
    //
    //   `Idempotency-Key` — IMPLICIT, usually stamped by a gateway. A workKey when there is a
    //   subject, otherwise the raw runId it has been since FAZ-1. The precedence and the reason are
    //   @gnldev/chat-adapter's, as they were when this header was first accepted here — and so is the
    //   fallback: this route ships with no auth, and refusing every identity-less deployment that
    //   put a proxy in front of it would be a regression dressed as a rule.
    //
    // Nothing else moves: with no identity at all this route still answers 400, as it always has.
    const header = c.req.header('Idempotency-Key');
    if (!body.runId && !body.workKey && header) {
      if (subject) body.workKey = header;
      else body.runId = header;
    }
    if (!body.runId && !body.workKey) return c.json({ error: 'runId or workKey is required (one names an id, the other names the work)' }, 400);
    let identity: ResolvedWorkIdentity;
    try {
      identity = resolveWorkIdentity(`agent:${name}`, {
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
        ...(body.workKey !== undefined ? { workKey: body.workKey } : {}),
        // The agent's own declaration — which address a name is unique within is a property of the
        // work, not of the request (see AgentConfig.workScope).
        scopeKind: gnl.agent(name).workScope ?? 'resource',
        ...(subject ? { resourceId: subject } : {}),
        // THE ORG — REST parity (§7). @gnldev/server passes it; without it an `'org'` workScope
        // lands on the deployment sentinel (§10.2) and the same org's same named work gets a
        // DIFFERENT id here than it does through REST. Note this is also what makes an org-scoped
        // run with NO subject work: an org address is an address, so the fail-closed `'resource'`
        // rule above does not apply to the nightly-reconciliation case.
        ...(org ? { orgId: org } : {}),
        anonymous: 'refuse',
        surface: `POST /agents/${name}/run`,
      });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    const runId = identity.runId!;
    const declared = identity.work?.workKey;
    // `identity` sits below the dedicated resolver and above the body: it is server-derived, the body
    // is not.
    const threadId = opts.resolveThreadId?.(c, body) ?? ident?.threadId ?? body.threadId ?? runId;
    let result: any;
    try {
      result = await gnl.stream(name, {
        // The NAME when one was declared, the raw id otherwise — the door re-resolves the same tuple
        // and lands on the same id, and only the name gets written into the run's record.
        ...(declared !== undefined ? { workKey: declared } : { runId }),
        prompt: body.prompt,
        messages: body.messages,
        // `threadId`, hesaplanan değer — `body.threadId` DEĞİL. Bu satır ölü koddu: `resolveThreadId`
        // çağrılıyor, sonucu yalnız SSE zarfına gidiyordu, koşum yine istemcinin dediği thread'e
        // yazıp okuyordu. Yani host'un kimliği auth'tan türetmek için verdiği TEK kanca hafızayı hiç
        // etkilemiyordu; host "düzelttim" sanıyordu.
        threadId,
        approvals: body.approvals,
        // HER ZAMAN mühürlü — kimlik bilinmese bile. Ayrılmış anahtarlar motorun "bunu sunucu
        // doğruladı" kanalıdır; mühürsüz bir gövde o kanalın sahibi olur.
        context: sealRequestContext(body.context ?? {}, {
          ...(subject ? { resourceId: subject } : {}),
          // The org goes into the seal too, so the record and the dynamic `system`/`tools` see the
          // same organization the id was derived under — the derivation and the seal must not
          // disagree about which boundary this run is inside.
          ...(org ? { orgId: org } : {}),
        }),
        ...(subject ? { resourceId: subject } : {}),
      });
    } catch (e: any) {
      // A refusal thrown BEFORE the stream exists is still one of ours, and it used to arrive as a bare
      // 400 with the reason flattened into prose. `streamDurable` asserts thread ownership and takes the
      // run lock before it returns anything, so `RunThreadMismatchError`, `RunBusyError`,
      // `SideEffectRetryBlockedError` and `RetryLimitExceededError` all land here — the same errors
      // @gnldev/server answers with a status and a `code`. A client talking to this route had to match
      // on the sentence instead, which is the practice the typed errors exist to end.
      //
      // Errors raised MID-stream are a different contract and are untouched: once frames are flowing
      // they surface as an SSE `error` event (see pipeAguiStream), because a response already committed to
      // 200 cannot become a 409.
      const name = (e as { name?: string })?.name;
      if (name === 'RunThreadMismatchError') {
        return c.json({ error: e.message, code: 'run_thread_mismatch', detail: withWorkKey(e.detail, declared) }, 409);
      }
      // FAZ-4 caller-conflict family (K9: durable's single map — this route was the consumer the
      // first cut forgot; a critical-profile input/actor/swept refusal must not collapse to a bare 400).
      const conflict = callerConflictCode(e);
      if (conflict) {
        return c.json({ error: e.message, code: conflict, detail: withWorkKey(e.detail, declared) }, 409);
      }
      const blocked = blockedErrorCode(e);
      if (blocked) {
        const body = { error: e?.message ?? String(e), code: blocked, detail: e?.detail };
        const res = blocked === 'retry_limit_exceeded'
          ? c.json(body, 422)
          : c.json({ ...body, resumable: true }, 409);
        // Same Retry-After contract as @gnldev/server and chat-adapter: run_busy is "correct, only early".
        if (blocked === 'run_busy') res.headers.set('Retry-After', '5');
        return res;
      }
      if (name === 'RunLimitExceededError' || name === 'ToolLoopDetectedError') {
        const code = name === 'RunLimitExceededError' ? EDGE_ERROR_CODES.runLimitExceeded : EDGE_ERROR_CODES.toolLoopDetected;
        return c.json({ error: e.message, code, detail: e.detail, resumable: true }, 422);
      }
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    return pipeAguiStream(c, runId, result, { threadId });
  });
  return app;
}

/** The AG-UI route as a fetch handler — mount with `app.mount(path, ...)` on a Hono host. */
export function createAguiRoute(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): FetchHandler {
  return toFetchHandler(aguiRouteApp(config, opts));
}
