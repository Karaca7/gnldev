// CreateChatRoute: a single-endpoint Hono router speaking the Vercel AI SDK v5 `useChat` wire format —
// the ai-sdk-package counterpart of @gnldev/agui's createAguiRoute (AG-UI/CopilotKit) and @gnldev/server's
// PipeAgentStream (GNL's own SSE schema). Converts `UIMessage[]` -> `ModelMessage[]` via `ai`'s
// `convertToModelMessages` (export verified against the installed ai@7 package — tsc compiles this
// import against its .d.ts), streams the
// agent via `gnl.stream`, and returns the SENTINEL-MASKED UI message stream response (ui-stream.ts) —
// never the native, unmasked one.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { createGnl, RunThreadMismatchError, blockedErrorCode, callerConflictCode, upstreamFailure, sealRequestContext, resolveWorkIdentity } from '@gnldev/durable';
import type { CreateGnlConfig, GnlIdentity } from '@gnldev/durable';
import { toUIMessageStreamResponse } from './ui-stream.js';

export interface CreateChatRouteOptions {
  /** Resolve the durable `runId` (exactly-once key for THIS request) from the request/body. */
  resolveRunId?: (c: Context, body: any) => string | undefined;
  /** Resolve the conversation `threadId` (memory continuity across requests) from the request/body. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
  /**
   * WHO this request acts for — the end user's `resourceId`, read from something the SERVER trusts
   * (a session cookie, a verified JWT, `principalOf(c.req.raw)?.id`) and NEVER from the body.
   *
   * WHY IT EXISTS. GNL has no end-user identity: an end user is a SUBJECT that a trusted application
   * names, not a principal GNL authenticates (`resolveResourceId` in @gnldev/server states this).
   * The engine treats the reserved context keys as "the server established this", and this route used
   * to forward `body.context` verbatim — so the reserved key arrived from whoever sent the request.
   * MEASURED against a running app: a plain POST carrying
   * `{"context":{"__gnl_resourceId":"KURBAN-KULLANICI"}}` produced a run owned by that name, and the
   * ownership stamp followed it. The seal that exists precisely to prevent this (registry.ts's
   * `sealRequestContext`, whose own comment names the attack) was never applied on this path.
   *
   * The route now ALWAYS seals. With no resolver the seal carries no identity, which STRIPS the
   * reserved keys: a forged subject cannot get through, and none is asserted either.
   *
   * HONEST BOUND — it decides what every ownership guarantee downstream is worth: this route ships
   * with NO auth of its own (see the createChatRoute JSDoc). A resolver reading an unauthenticated
   * request asserts a subject nobody verified. Put auth in front of this route, or the subject is
   * only as trustworthy as the caller.
   */
  resolveResourceId?: (c: Context, body: any) => string | undefined;
  /**
   * WHO and WHICH CONVERSATION, in one hook — the same signature @gnldev/agui's route takes, so the
   * function a host writes once works on both.
   *
   * It exists because the two hooks above are two hooks. A host wiring identity had to write
   * `resolveResourceId` AND `resolveThreadId`, and on the sibling adapter the second one had a
   * different shape and, for a while, no effect at all (see agui's route.ts note on the dead
   * `threadId` line). Answering "who is this request for" twice is how one of the answers ends up
   * missing.
   *
   * Takes the web `Request`, not the Hono `Context` — the precedent is @gnldev/server's
   * `OrgOptions.resolve`, and the reason is the same: a host binding this route from Express or
   * Fastify has a Request and no Context.
   *
   * PRECEDENCE: `resolveResourceId` / `resolveThreadId` still WIN, field by field. They are the
   * existing contract and a new convenience must not silently take a working deployment's answer
   * away. This fills whichever of the two the host did not supply.
   *
   * Called ONCE per request, for the reason already written below about `subject`: a resolver that
   * reads the request may answer differently the second time.
   *
   * HONEST BOUND — unchanged from `resolveResourceId`: this route ships with no auth of its own. A
   * resolver reading an unauthenticated request asserts a subject nobody verified.
   */
  identity?: GnlIdentity;
  /**
   * FAZ-2 — per-run concurrency lock, ON by default (`{ ttlMs: 300_000 }`). Two CONCURRENT requests
   * with the same runId (double-click, two tabs, a retry racing the original) used to BOTH execute;
   * Now the loser gets the typed `409 run_busy` (+ Retry-After) and the winner's journal replay
   * answers the retry. `lock: false` restores the old behavior. The streamed lock SELF-RENEWS on a
   * ttl/2 heartbeat (engine parity with run()), so ttlMs is the crash-takeover window — the generous
   * 5-minute default simply keeps takeover conservative.
   */
  lock?: { ttlMs?: number } | false;
}

const DEFAULT_LOCK_TTL_MS = 300_000;

let anonCounter = 0;

/**
 * The caller's own name for the work, reflected back in a refusal (§8, rules 1-3) — the same
 * function @gnldev/server's route catch uses, rendered locally for the same reason the whole
 * taxonomy is: the dependency direction is chat-adapter → durable, never chat-adapter → server.
 *
 * FROM THE REQUEST, never from storage: a swept run keeps only a hash of its workKey (§10.3), so
 * reading the name back out would undo a deletion. The caller already knows what it sent.
 *
 * `detail` and not `error`: the sentence is the most casually logged field there is, and a workKey
 * is a business name.
 */
function withWorkKey(detail: unknown, workKey?: string): unknown {
  if (workKey === undefined) return detail;
  return detail && typeof detail === 'object' ? { ...(detail as Record<string, unknown>), workKey } : { workKey };
}

/**
 * Typed error rendering — the SAME taxonomy as @gnldev/server's route catch (index.ts's
 * threadMismatchResponse / blockedErrorResponse / upstreamErrorResponse), rendered locally because the
 * dependency direction is chat-adapter → durable, never chat-adapter → server. Before this, the catch
 * collapsed EVERYTHING to a flat 400 `{error}` — so a concurrent duplicate of the same runId
 * (RunBusyError, "your run is already in flight — retry later and you'll get the replay") reached the
 * client as "your request was malformed", which tells a retrying client to stop retrying at the exact
 * moment retrying is the right move.
 */
function typedErrorResponse(c: Context, e: unknown, workKey?: string): Response | undefined {
  if (e instanceof RunThreadMismatchError || (e as { name?: string })?.name === 'RunThreadMismatchError') {
    const err = e as RunThreadMismatchError;
    // 409 without `resumable`: same runId + this thread never succeeds — see server's rationale.
    return c.json({ error: err.message, code: 'run_thread_mismatch', detail: withWorkKey(err.detail, workKey) }, 409);
  }
  // FAZ-4 caller-conflict family — same 409-without-resumable posture as thread mismatch above.
  // K9: the map is durable's single CALLER_CONFLICT_CODES export (thread mismatch is answered by the
  // dedicated branch above; its entry here is harmless duplication by design).
  const conflictCode = callerConflictCode(e);
  if (conflictCode && conflictCode !== 'run_thread_mismatch') {
    const err = e as { message?: string; detail?: unknown };
    return c.json({ error: err.message, code: conflictCode, detail: withWorkKey(err.detail, workKey) }, 409);
  }
  const code = blockedErrorCode(e);
  if (code) {
    const err = e as { message?: string; detail?: unknown } | null | undefined;
    const body = { error: err?.message ?? String(e), code, detail: err?.detail };
    if (code === 'retry_limit_exceeded') return c.json(body, 422);
    const res = c.json({ ...body, resumable: true }, 409);
    // Run_busy: another worker holds this runId RIGHT NOW — a short client backoff then the same
    // RunId lands on the journal replay. 5s is a hint, not a lease measurement (the route has no
    // visibility into the holder's lock TTL).
    if (code === 'run_busy') res.headers.set('Retry-After', '5');
    return res;
  }
  const up = upstreamFailure(e);
  if (up) {
    const err = e as { message?: string } | null | undefined;
    const body = {
      error: err?.message ?? String(e),
      code: up.code,
      ...(up.upstreamStatus !== undefined ? { upstreamStatus: up.upstreamStatus } : {}),
      ...(up.retryAfter !== undefined ? { retryAfter: up.retryAfter } : {}),
    };
    const res = c.json(body, up.status);
    if (up.retryAfter !== undefined) res.headers.set('Retry-After', String(up.retryAfter));
    return res;
  }
  return undefined;
}

/**
 * Produces a single-endpoint Hono router from a createGnl config (or an already-built `gnl` instance)
 * that a `useChat({ api: '.../agents/:name/chat' })` client can talk to:
 * POST /agents/:name/chat   { id?, messages: UIMessage[], runId?, threadId?, approvals? }  → UI message stream
 * Deliberately kept small — SAME posture as @gnldev/agui's `createAguiRoute`: NO auth/org/budget gates (if
 * needed, wrap this route, or compose @gnldev/server's createRestApi's auth middleware around it — see README).
 *
 * IDENTITY precedence: `body.runId` > `opts.resolveRunId(...)` > the TURN'S NAME
 * (`Idempotency-Key` header, else DERIVED `${body.id}:${lastMessage.id}`) > a generated id. The
 * derivation is the load-bearing default: `body.id` is useChat's STABLE per-conversation id — using
 * it ALONE would make every later turn replay turn 1 from the journal (withDurableModel replays
 * `runId:model:0` and the model never runs again). Combining it with the LAST message's id (useChat
 * stamps a fresh id per message) gives one exactly-once run PER TURN, and makes a network retry of
 * the SAME turn land on the same run (deduped replay — free idempotency) while a NEW turn runs fresh.
 * `threadId` defaults to `body.id` (the conversation), NOT the per-turn key — conversation memory
 * must span turns.
 *
 * TWO REGIMES, decided by whether the route can name a SUBJECT (package #5, §7). With one, the
 * turn's name is a `workKey` and the engine derives an opaque `run1_` id from it; without one it
 * stays the raw id it has always been, because deriving needs an address (§6) and this route's
 * quickstart names nobody. The retry contract is identical either way: the same message ids produce
 * the same key, and the same key lands on the same run.
 *
 * SCOPE of that idempotency (FAZ-2): serial retries dedupe via journal replay, and CONCURRENT
 * duplicates are now serialized by the default per-run lock (`CreateChatRouteOptions.lock`) — the
 * loser gets the typed 409 `run_busy` + Retry-After instead of a second execution. The effective
 * RunId is echoed on every response as `X-Gnl-Run-Id` and stamped onto interrupt chunks — a
 * CORRELATION handle, not the retry key: to retry, send the same turn again. One exception, agui's
 * too: a pre-run identity refusal (unknown agent, unaddressable scope) carries no header, because
 * the header names a run and none exists yet on that path.
 *
 * Body `workKey` is deliberately NOT read here (the REST, agui and workflow doors all take it):
 * this route speaks the useChat wire format, where the turn IS the work — the per-turn key above,
 * or a gateway's `Idempotency-Key`, is what gets promoted. A field the UI library never sends would
 * be dead surface with a live failure mode (a stale key silently pinning every turn to one run).
 */
export function createChatRoute(
  config: CreateGnlConfig | { gnl: ReturnType<typeof createGnl> },
  opts: CreateChatRouteOptions = {},
): Hono {
  const gnl = 'gnl' in config ? config.gnl : createGnl(config);
  // A route that cannot name anyone, in production, said nothing about it. Every run it starts is
  // born ownerless — and an ownership gate with no owner to compare against passes (registry.ts's
  // ownershipDenied takes the `!owner` branch), so the protection reads as present and is not.
  // WARN, never throw: an existing deployment that has decided its own boundary lives in front of
  // this route is not broken, and a framework that refuses to start over a posture question would be
  // discovered at the worst possible moment. Once, at construction, addressed and with the fix in it.
  if (process.env.NODE_ENV === 'production' && !opts.identity && !opts.resolveResourceId) {
    console.warn(
      '[gnl chat-route] no `identity` and no `resolveResourceId` in production — runs will be born ownerless; ' +
      'ownership gates stay fail-open (a run with no owner is refused to nobody). Pass `identity: (req) => ({ resourceId })` ' +
      'reading your session/JWT — never the request body.',
    );
  }
  const app = new Hono();
  app.post('/agents/:name/chat', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      messages?: UIMessage[];
      runId?: string;
      threadId?: string;
      approvals?: Record<string, boolean>;
      context?: Record<string, unknown>;
    };
    const lastMsg = body.messages?.[body.messages.length - 1];
    // Bir kez çözülür: hem mühür hem resourceId aynı değeri kullansın. İsteğe bakan bir çözücüyü
    // iki kez çağırmak, iki farklı cevap alma ihtimali demektir. `identity` de aynı sebeple tek çağrı:
    // iki alanı birden besliyor, ikisi ayrı çağrıdan gelirse ayrı cevaplardan gelebilir.
    // KİMLİK ARTIK ÖNDE ÇÖZÜLÜYOR: aşağıdaki anahtar kararı özneyi bilmeden verilemiyor.
    const ident = await opts.identity?.(c.req.raw);
    const subject = opts.resolveResourceId?.(c, body) ?? ident?.resourceId;
    // WHICH ORGANIZATION. Only `identity` can answer it — there is no `resolveOrgId` hook and there
    // will not be one; the hook that already resolves the subject from a verified session is the
    // right place for the boundary that CONTAINS the subject. Never read from the body: an org is an
    // isolation boundary, and a caller who picks their own has none (sealRequestContext strips the
    // reserved key for exactly this reason).
    const org = ident?.orgId;
    // A RAW id, when the caller is holding one. `body.runId` and `resolveRunId` both name an ID (the
    // second one says so in its name), so neither is promoted — a host that hands us an id has
    // already decided the addressing.
    const rawId = body.runId ?? opts.resolveRunId?.(c, body);
    // THE TURN'S NAME. `${body.id}:${lastMessage.id}` is what this route has always derived, and the
    // `Idempotency-Key` header is the same declaration arriving from a gateway instead. Deliberately
    // AFTER the two raw resolvers (heyet kararı 1.5): the header is often stamped by a proxy, while a
    // body/host decision is explicit, and header-first would let an intermediary redefine the turn.
    const workName = c.req.header('Idempotency-Key') ?? (body.id && lastMsg?.id ? `${body.id}:${lastMsg.id}` : undefined);
    let runId: string | undefined = rawId;
    let workKey: string | undefined;
    if (!runId && workName) {
      // THE PROMOTION, and the concession that comes with it (package #5, §7).
      //
      // With a subject, the turn's name is a `workKey`: the engine derives `run1_<digest>` and the
      // client-controlled string stops being a journal key prefix. That closes bug class 2 (§2) at
      // its documented source — `conv` and `conv:msg1` were exactly this derivation's shape.
      //
      // WITHOUT a subject it stays what it has always been: a raw runId. Deriving a name into an id
      // needs an ADDRESS (§6, fail-closed), and this route ships with no auth and a `useChat`
      // quickstart that names nobody. Refusing those would replace a working first five minutes
      // with a 400 — so the anonymous regime is preserved byte for byte, and the protection matrix's
      // identity row is where a deployment reads which of the two it is in.
      if (subject) {
        try {
          const identity = resolveWorkIdentity(`agent:${name}`, {
            workKey: workName,
            // The agent's own declaration, read off the registry rather than guessed: the route has
            // no business deciding which address a name is unique within (see AgentConfig.workScope).
            scopeKind: gnl.agent(name).workScope ?? 'resource',
            resourceId: subject,
            // THE ORG, and it is not optional decoration — @gnldev/server passes it on the REST
            // route, and an `'org'` workScope with no org falls back to the deployment sentinel
            // (§10.2). Without this line the same organization's same named work derives one id
            // through REST and another through here: not an error, a DUPLICATE, decided by whichever
            // surface the request came in on.
            ...(org ? { orgId: org } : {}),
            anonymous: 'refuse',
            surface: `POST /agents/${name}/chat`,
          });
          runId = identity.runId!;
          workKey = identity.work?.workKey;
        } catch (e: any) {
          // An unknown agent, or a scope that cannot be addressed. There is no run to correlate with,
          // so no X-Gnl-Run-Id either — the header names a run, and there is none.
          return c.json({ error: String(e?.message ?? e) }, 400);
        }
      } else {
        runId = workName;
      }
    }
    if (!runId) {
      // Anon fallback: a fresh id per request = ZERO dedup — a network retry of this exact request
      // Runs the turn again. Deliberately NOT content-hashed (two intentional identical requests must
      // stay two runs); the fix is the contract, not magic: the response's X-Gnl-Run-Id header hands
      // the client the key to retry with.
      // Sayaç MODÜL düzeyinde: her replika kendi sıfırından sayar. Ortak journal üstünde iki
      // süreç aynı milisaniyede `chat-<ms>-0` üretir ve İKİ FARKLI kullanıcının isteği tek koşuma
      // düşer — dedup yokluğu değil, YANLIŞ dedup: ikinci istek birincinin adımlarını replay eder.
      // Süreç-dışı entropi bunu kapatır. Doğru çözüm hâlâ istikrarlı bir runId GÖNDERMEK; aşağıdaki
      // uyarı onu söylüyor, bu satır yalnız çarpışmayı engelliyor.
      runId = `chat-${Date.now()}-${anonCounter++}-${crypto.randomUUID().slice(0, 8)}`;
      console.warn(
        `[gnl chat-route] no runId derivable (body.runId / resolveRunId / body.id+message.id all absent) — generated '${runId}'. Retries of this request will NOT dedupe; send body.runId (echoed back as X-Gnl-Run-Id) so retries land on the same run.`,
      );
    }
    // The conversation id (NOT the per-turn runId) anchors memory — see the runId note in the JSDoc.
    // `identity` sits BELOW the dedicated resolver and ABOVE the body: it is server-derived, the body
    // is not, so it must not be overridable by what the caller sent.
    const threadId = opts.resolveThreadId?.(c, body) ?? ident?.threadId ?? body.threadId ?? body.id ?? runId;
    // V1: `tools` is not passed to convertToModelMessages — a conversation whose CLIENT-side history
    // still carries tool-invocation parts from a prior turn round-trips as best-effort (text/reasoning
    // are unaffected). Fine for the common case (server-side history via toUIMessages + threadId memory
    // is the durable source of truth); documented rather than silently assumed complete.
    // AWAITED: `convertToModelMessages` is async in AI SDK 7 (it was synchronous in v5). Passing the
    // un-awaited Promise straight through as `messages` sent a Promise into the run — the journal
    // then tried to structuredClone it and every chat request failed with
    // "#<Promise> could not be cloned", i.e. a flat 400 on the whole route.
    // INSIDE the try below: conversion throws on CLIENT-controlled input (a malformed `messages`
    // shape, an unsupported part type) — outside the try that surfaced as Hono's bare 500 with no
    // typed body and NO X-Gnl-Run-Id, breaking the every-response header contract on exactly the
    // malformed-request path. In the catch it falls through typedErrorResponse (no match) to the
    // generic 400, which is what a malformed request is.
    // FAZ-2 default lock: acquired by streamDurable BEFORE any setup work, released on stream
    // finish/error — the loser throws RunBusyError synchronously into the catch below (409 run_busy).
    const lock =
      opts.lock === false
        ? undefined
        : { owner: `chat-${crypto.randomUUID()}`, ttlMs: opts.lock?.ttlMs ?? DEFAULT_LOCK_TTL_MS };
    let result: any;
    try {
      const messages = await convertToModelMessages(body.messages ?? []);
      result = await gnl.stream(name, {
        // The NAME when the turn key was promoted, the raw id otherwise. The door re-resolves the
        // same tuple and lands on the same id — passing the id instead would drop the declaration,
        // and the declaration is what makes "which run was this turn?" answerable in Studio.
        ...(workKey !== undefined ? { workKey } : { runId }),
        messages,
        threadId,
        approvals: body.approvals,
        // HER ZAMAN mühürlü — kimlik bilinmese bile. Ayrılmış anahtarlar motorun "bunu sunucu
        // doğruladı" kanalıdır; mühürsüz bir gövde o kanalın sahibi olur. Kimlik yoksa anahtarlar
        // silinir (fail-closed), çözücü varsa sunucunun değeri yazılır.
        // The org travels in the SEAL as well as into the derivation above — the two must not
        // disagree. `sealRequestContext` writes the reserved `__gnl_orgId`/`org` keys from what the
        // SERVER established, so an org-scoped run's record and its dynamic `system`/`tools` see the
        // same organization the id was derived under, and a body that named its own is stripped.
        context: sealRequestContext(body.context ?? {}, {
          ...(subject ? { resourceId: subject } : {}),
          ...(org ? { orgId: org } : {}),
        }),
        ...(subject ? { resourceId: subject } : {}),
        ...(lock ? { lock } : {}),
        // P0.2 thread the REQUEST's AbortSignal through to generation — a client
        // disconnect (tab close, useChat's `stop()`, navigation away) stops token generation instead of
        // silently billing to completion. This does NOT break resumable-SSE replay: an abort simply ends
        // generation early, the journal keeps whatever prefix already completed, and a LATER call with the
        // SAME runId resumes/replays exactly as before (see registry.ts's RunOptions.abortSignal note).
        abortSignal: c.req.raw.signal,
      });
    } catch (e: any) {
      const res = typedErrorResponse(c, e, workKey) ?? c.json({ error: String(e?.message ?? e) }, 400);
      res.headers.set('X-Gnl-Run-Id', runId);
      return res;
    }
    // Every response (success AND error) echoes the effective runId — the client-side retry key is a
    // contract, not something the caller has to re-derive from useChat internals. The SAME runId is
    // stamped onto `data-gnl-interrupt` chunks (FAZ-2) so an approval addresses THIS run.
    const res = toUIMessageStreamResponse(result, { runId });
    res.headers.set('X-Gnl-Run-Id', runId);
    // FAZ-7: the engine's replay signal — 'replay' when this runId had frozen input before the call
    // (a resume/retry landing on journal state), 'new' on a fresh run. An observability contract for
    // reconciliation, NOT a byte-identity guarantee.
    res.headers.set('X-Gnl-Idempotency-Status', (result as { __gnlPriorRun?: boolean })?.__gnlPriorRun ? 'replay' : 'new');
    return res;
  });
  return app;
}
