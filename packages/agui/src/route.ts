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
import { limitBreachFromSteps, blockedFromSteps, BLOCKED_ERROR_CODES, blockedErrorCode, callerConflictCode, OWNERSHIP_CONFLICT_CODES, publicConflictDetail, sealRequestContext, sealFieldsOf, resolveWorkIdentity } from '@gnldev/durable';
import type { CreateGnlConfig, ResolvedWorkIdentity } from '@gnldev/durable';
import { createGnl, scopeConfigToOrg } from '@gnldev/durable';
import { callerOfRequest, authorizeDoorRequest, AGENTS_RUN, markRefusal, settleDecision, decisionNotRecorded, type AccessDecision, type Authorize, type Identify } from '@gnldev/auth';
import { streamSSE } from 'hono/streaming';
// The two limit codes are READ from @gnldev/durable (`LIMIT_ERROR_CODES`) rather than spelled again
// here. The event/data SHAPE is deliberately a copy (see the note above), but a code is not a shape:
// it is the string a caller matches on. The codes, `interruptsFromSteps` and the surface contract all
// come from durable, never from @gnldev/server: this package runs standalone (ADR-0002 point 0).
import { interruptsFromSteps, LIMIT_ERROR_CODES } from '@gnldev/durable';
import type { StreamSurface } from '@gnldev/durable';
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
            code: breach.kind === 'loop' ? LIMIT_ERROR_CODES.toolLoopDetected : LIMIT_ERROR_CODES.runLimitExceeded,
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
   * WHO is calling — the application's one answer (@gnldev/auth `Identify`), the same function it hands
   * @gnldev/server, @gnldev/chat-adapter and @gnldev/mcp. It reads a session cookie, a verified token or
   * a user store — never the body — and returns a `Principal`, or nothing for an anonymous request.
   *
   * The route maps the principal with `engineCallerOf` and hands the engine that caller:
   *
   *   subject      → that user; its runs and its thread are its own
   *   operator     → staff; reaches every run and thread in its organization
   *   application  → the end user it names in the body's `resourceId` — read for an application ONLY,
   *                  the same field @gnldev/server's REST routes read. Naming nobody is a 400.
   *   nothing      → unknown: closed, it reaches no user's or staff's thread
   *
   * The organization comes from the principal (`orgId`), never from the body. `resolveThreadId`
   * still picks the thread: choosing a conversation is not an identity claim, and the engine checks
   * the thread's owner against the caller.
   *
   * Takes the web `Request` rather than the Hono `Context`: a host mounting this from Express or
   * Fastify has a Request and no Context. Called once per request.
   *
   * HONEST BOUND: this route declares auth out of scope. An `identify` that trusts an
   * unauthenticated request asserts a caller nobody verified.
   */
  identify?: Identify;
  /**
   * WHAT the caller may do: the provider's `authorize`, the one @gnldev/server and @gnldev/studio ask.
   * `authorize: (p, req, ctx) => auth.authorize(p, req, ctx)`. Asked for `agents:run` before a run, so a
   * role without it (auth-ee's `viewer`, roleAuth's `viewer`) is refused here as it is on the REST API.
   * WITHOUT it this route checks identity and ownership only: every identified caller may run.
   */
  authorize?: Authorize;
  /**
   * Report each request's outcome — who asked, allowed or refused and why, the status it got — to the
   * same hook @gnldev/server and @gnldev/studio report to (@gnldev/auth `AuthProvider.onDecision`). Pass
   * the provider's: `identify: (req) => auth.authenticate(req), onDecision: (d) => auth.onDecision?.(d)`.
   *
   * An option rather than a provider, because this route is handed `identify` and nothing else; it
   * authorizes nothing itself, so what it reports is who asked and what the engine answered — a foreign
   * thread or run (409 `thread_owner_mismatch` / `run_owner_mismatch` / `run_actor_mismatch`) is recorded
   * as an ownership refusal. WITHOUT it this route leaves no record. If it throws, the route answers 500.
   */
  onDecision?: (decision: AccessDecision) => void | Promise<void>;
}

/**
 * Produces a single-endpoint Hono router from a createGnl config that CopilotKit's AG-UI HttpAgent can talk to:
 * POST /agents/:name/run   {runId, prompt|messages, threadId?, approvals?}  → AG-UI SSE
 * Deliberately kept small: NO auth/org/budget gates (if needed, use @gnldev/server's createRestApi
 * and pass its stream result to pipeAguiStream — see README).
 */
function aguiRouteApp(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): Hono {
  const rootGnl = createGnl(config);
  // One instance per organization, over its own partition — the same construction as the REST API
  // and the chat route (@gnldev/durable `scopeConfigToOrg`), so an org's AG-UI runs are where its
  // staff and its REST reads look for them.
  const orgGnls = new Map<string, ReturnType<typeof createGnl>>();
  const gnlFor = (org: string | undefined): ReturnType<typeof createGnl> => {
    if (!org) return rootGnl;
    let g = orgGnls.get(org);
    if (!g) orgGnls.set(org, (g = createGnl(scopeConfigToOrg(config, org).config)));
    return g;
  };
  // Same warning, same wording and same posture as @gnldev/chat-adapter's route: in production, a route
  // that can name nobody starts runs that are born ownerless, and an ownership gate with no owner to
  // compare against passes. Warn once at construction — never throw, because a deployment that puts
  // its own boundary in front of this route is not broken and must not be stopped at boot.
  // A REMOVED option fails loudly. Ignoring it would be worse than the hook it replaced: a JavaScript
  // config (or one cast past the types) that still passes it would start every run ownerless, and
  // nothing would say so.
  if ((opts as { resolveResourceId?: unknown }).resolveResourceId !== undefined) {
    throw new TypeError(
      '[gnl agui-route] `resolveResourceId` was removed: it handed the resolver the request body, the one place a ' +
      'subject must never come from. Use `identify: (req) => principal`, reading your session or a verified token.',
    );
  }
  if ((opts as { identity?: unknown }).identity !== undefined) {
    throw new TypeError(
      '[gnl agui-route] `identity` was replaced by `identify` (0.7.0): it returns a Principal from @gnldev/auth — ' +
      "`{ kind: 'subject', id, orgId, roles: [] }` for an end user — so the route can tell a user from staff.",
    );
  }
  // PRODUCTION REFUSES a route that names nobody. It used to warn and serve: every caller, with or
  // without a credential, ran the model and left an ownerless run (measured). The recommended shape
  // is a surface on the REST API, where the auth provider decides who the caller is. A host that
  // really has no per-user identity says so explicitly with `identify: () => undefined`.
  if (process.env.NODE_ENV === 'production' && !opts.identify) {
    throw new Error(
      '[gnl agui-route] no `identify` in production: this route has no auth of its own, so every caller would run the model ' +
      'and leave an ownerless run. Mount it on the REST API instead — createRestApi(config, { auth, surfaces: [aguiSurface()] }) — ' +
      'or pass `identify: (req) => principal` from your verified session. `identify: () => undefined` opts out, explicitly.',
    );
  }
  const app = new Hono();
  // The outcome, reported once the route has answered (see `onDecision`).
  if (opts.onDecision) {
    const onDecision = opts.onDecision;
    app.use('*', async (c, next) => {
      await next();
      try {
        await settleDecision(onDecision, c.req.raw, c.res.status);
      } catch (err) {
        c.res = decisionNotRecorded(err);
      }
    });
  }
  app.post('/agents/:name/run', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as any;
    // WHO, resolved once and FIRST — the same reason chat-adapter states: the identity decision below
    // cannot be made without the subject, and a resolver may answer differently the second time.
    // `body.resourceId` is read by `callerOfRequest` for an APPLICATION principal only.
    const who = await callerOfRequest(opts.identify, c.req.raw, body.resourceId);
    if ('refused' in who) return c.json({ error: who.refused }, who.status ?? 400);
    const denied = await authorizeDoorRequest(opts.authorize, who.principal, c.req.raw, AGENTS_RUN);
    if (denied) return c.json({ error: denied.refused }, denied.status);
    const caller = who.caller;
    const subject = caller.kind === 'user' ? caller.id : undefined;
    // WHICH ORGANIZATION — the principal's, never the body's. Same rule and same reason as the sibling
    // route: an org is an isolation boundary, and `sealRequestContext` strips any the caller asserted.
    const org = caller.kind === 'unknown' ? undefined : caller.orgId;
    const gnl = gnlFor(org);
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
    // Choosing a conversation is not an identity claim: the ENGINE checks the thread's owner against
    // the caller (admitThreadRun), so naming staff's or another user's thread is refused there.
    const threadId = opts.resolveThreadId?.(c, body) ?? body.threadId ?? runId;
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
        // The org goes into the seal too, so the record and the dynamic `system`/`tools` see the same
        // organization the id was derived under — the derivation and the seal must not disagree about
        // which boundary this run is inside. One mapping (durable `sealFieldsOf`) for every door.
        context: sealRequestContext(body.context ?? {}, sealFieldsOf(caller, org)),
        // THE CALLER, from the one mapping; the seal above carries the same decision into the context.
        caller,
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
        if (OWNERSHIP_CONFLICT_CODES.includes(conflict)) markRefusal(c.req.raw, 'ownership', { detail: conflict });
        // Redacted: see `publicConflictDetail` (durable/errors.ts) for what is withheld and why.
        return c.json({ error: e.message, code: conflict, detail: withWorkKey(publicConflictDetail(e.detail), declared) }, 409);
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
        const code = name === 'RunLimitExceededError' ? LIMIT_ERROR_CODES.runLimitExceeded : LIMIT_ERROR_CODES.toolLoopDetected;
        return c.json({ error: e.message, code, detail: e.detail, resumable: true }, 422);
      }
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    return pipeAguiStream(c, runId, result, { threadId });
  });
  return app;
}

/**
 * The AG-UI wire format as a surface of @gnldev/server's createRestApi:
 * `createRestApi(config, { auth, surfaces: [aguiSurface()] })`. Decodes and encodes only — identity,
 * organization, subject and every gate are the REST door's. Default path `/agents/:name/agui`
 * (`/agents/:name/run` is REST's own).
 */
export function aguiSurface(opts: { path?: string } = {}): StreamSurface<Context> {
  return {
    path: opts.path ?? '/agents/:name/agui',
    decode(body: any) {
      return {
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        ...(body.approvals ? { approvals: body.approvals } : {}),
        ...(body.context ? { context: body.context } : {}),
        ...(body.runId ? { runId: body.runId } : {}),
        ...(body.workKey ? { workKey: body.workKey } : {}),
        ...(body.resourceId !== undefined ? { resourceId: body.resourceId } : {}),
      };
    },
    encode(result, meta) {
      return pipeAguiStream(meta.c, meta.runId, result, { threadId: meta.threadId ?? meta.runId });
    },
  };
}

/** The AG-UI route as a fetch handler — mount with `app.mount(path, ...)` on a Hono host. */
export function createAguiRoute(config: CreateGnlConfig, opts: CreateAguiRouteOptions = {}): FetchHandler {
  return toFetchHandler(aguiRouteApp(config, opts));
}
