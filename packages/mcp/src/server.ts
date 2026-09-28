// MCP server side: EXPOSE durable agents' tools over the MCP protocol (for others to consume).
// If a journal is given, every callTool is wrapped with durableTool → SERVER-SIDE exactly-once (a repeated
// request with the same idempotencyKey produces the side effect only once — absent from most MCP server implementations).
//
// WHERE THE CALLER'S IDENTITY COMES FROM, and why it is not the request.
//
// The dedup key used to be `req.idempotencyKey` alone — a string chosen by the CLIENT — and it became
// the journal's runId. Three things were measured on a server built exactly as the README describes:
//
//   • A second caller sending the SAME key got the FIRST caller's cached result. Arguments were
//     ignored: `{customer:'attacker-co'}` returned `{customer:'acme-ltd', iban:'TR44 **** 9021'}` and
//     `execute` ran once. Cross-tenant disclosure, with no attack more sophisticated than reusing a
//     string.
//   • A caller who claimed a key FIRST suppressed the real work under it: `charge 1` then `charge
//     18500` under `order-2026-0042` returned `{"charged":1}` to the second caller and charged 1. The
//     side effect never ran and the caller was told it succeeded.
//   • `listRuns()` returned `[{}]` and `purgeResource('user-ayse')` deleted 0 rows, leaving 2 behind:
//     nothing recorded whose call it was, so a deletion request could not find it.
//
// @gnldev/durable had already decided this question for its own doors — `workScope` is read from the
// AGENT's configuration, not from the call, because (its words) a per-call override "would put the
// dangerous half within reach of a request body". This door had handed the request body the WHOLE
// identity. So the caller is resolved SERVER-SIDE — `identify`, the same function every door takes,
// over what the transport authenticated — and the runId is derived from it through the same
// `resolveWorkIdentity` the HTTP surfaces use. The client's key is demoted to what it honestly is: a
// label for the work, unique only within one caller.
import { durableTool, resolveWorkIdentity, sealRequestContext, blockedErrorCode, withOrg, admitRun, UNKNOWN, runIdentity, toolContextFor } from '@gnldev/durable';
import type { Journal, WorkScope, RequestContext, Caller, GnlToolContext } from '@gnldev/durable';
import { callerOfRequest, actorIdOf, type Identify, type Principal } from '@gnldev/auth';
import { asSchema } from 'ai';
import type { McpToolDef } from './index.js';
import { createRateWindow, type RateWindow } from './rate-window.js';

/**
 * A tool this server exposes: an AI SDK `tool()` as it is (a `createRagTool`, a `durableTool`), or a
 * plain `{ description, inputSchema, execute }`. The AI SDK's shape is the one to accept without a
 * cast: its `description` may be a function of the context and its `execute` is optional. A tool with
 * no `execute` is not callable and is not listed.
 */
export interface McpServerToolDef {
  description?: string | ((options: { context: any }) => string);
  inputSchema?: any; // JSON Schema, or an executable schema (zod, standard-schema)
  execute?: (args: any, opts?: any) => unknown;
}

/**
 * What the TRANSPORT knows about the caller — never what the request body claims.
 *
 * Both fields come from the MCP SDK: `extra.authInfo` is the validated access token the transport
 * accepted, and `extra.sessionId` is the transport's session. `serveMcp` forwarded neither before (its
 * handler took one parameter and the SDK passes two), which is why the only identity available to the
 * dedup key was the one the caller typed.
 *
 * On a stdio transport both are normally absent, and that is correct rather than a gap: the client
 * SPAWNED this process, so the trust boundary is the process boundary and there is no second caller to
 * tell apart. The dangerous transport is HTTP, and that is where `authInfo` exists.
 *
 * `request` is the HTTP request the message arrived in (the SDK's `extra.requestInfo`), when there is
 * one. `identify` is handed THAT request; without one, a request carrying only the transport's
 * validated token (`authorization: Bearer <authInfo.token>`) — see `requestOf`.
 */
export interface McpCallerContext {
  authInfo?: { token?: string; clientId?: string; scopes?: string[] };
  sessionId?: string;
  request?: Request;
}

/**
 * The tool set, or a function of the SEALED caller context.
 *
 * The function form is what lets a tool answer "is this object the caller's?". A static tool cannot:
 * measured on the previous version, `execute` received `{toolCallId, idempotencyKey, parentRunId,
 * gnlApprovals}` and no caller at all, so `refund({orderId})` had nothing to compare the order against
 * and the resolved identity stopped at the dedup key. It is the SAME mechanism `@gnldev/durable`
 * already gives agents (`AgentConfig.tools?: DynamicArg<ToolSet>`), and the context is sealed by the
 * same `sealRequestContext`: the reserved `__gnl_resourceId`/`__gnl_orgId` keys are stripped from
 * anything the caller supplied and rewritten from what `identify` resolved, so a request body cannot
 * name its own subject. Read it back with `serverIdentityOf(ctx)`.
 *
 * WHAT THE SEAL IS NOT: the key stays writable and configurable, deliberately — `sealRequestContext`'s
 * own note says nothing downstream (spread, `Object.keys`, `JSON.stringify`) may be able to tell the
 * difference, and a non-writable property would change how every consumer behaves. Measured: assigning
 * to it inside a tool succeeds silently. That is the correct boundary. The threat is the REQUEST BODY,
 * which this closes; a tool overwriting its own context is the deployment's own code, and no seal
 * defends code against itself.
 *
 * Closing over the caller is stronger than being handed an id, because the tool never has to trust an
 * id that arrived in its arguments.
 */
export type McpToolSetArg =
  | Record<string, McpServerToolDef>
  | ((ctx: RequestContext) => Record<string, McpServerToolDef> | Promise<Record<string, McpServerToolDef>>);

/** What the authorization hooks are told about one call. */
export interface McpToolRequestInfo {
  /** The tool being listed or called. */
  name: string;
  /** What the transport knows about the caller (never the request body). */
  caller: McpCallerContext;
  /** What `identify` returned — e.g. for @gnldev/auth-ee's `fga.check(principal, …)`. Undefined when
   *  it returned nothing, or no `identify` is configured. */
  principal: Principal | undefined;
  /** Who the call runs as, for the engine (`engineCallerOf`): a user, staff, or `unknown`. */
  runsAs: Caller;
}

export interface McpServerOptions {
  /** Tools to expose (AI SDK tool or {description,inputSchema,execute}), or a function of the sealed
   *  caller context — see McpToolSetArg. */
  tools: McpToolSetArg;
  /** If given, callTool is wrapped with durableTool → server-side exactly-once (via idempotencyKey). */
  journal?: Journal;
  /**
   * WHO is calling — the application's one answer (@gnldev/auth `Identify`), the same function it hands
   * @gnldev/server, @gnldev/chat-adapter and @gnldev/agui. It is handed the HTTP request the call came
   * in (or one carrying the transport's validated token) and returns a `Principal`. An AuthProvider's
   * `authenticate` is one as it is: `identify: (req) => auth.authenticate(req)`.
   *
   * The principal is mapped with `engineCallerOf`:
   *
   *   subject      → that user: the work is theirs, the derived id is theirs, a tool sees them
   *   operator     → staff: reaches every tool it is allowed; a per-user (`'resource'`) work id cannot
   *                  be derived for it, so a keyed call under that scope is refused
   *   application  → the end user it names in `params._meta.resourceId` (`callTool({ resourceId })`
   *                  in process) — read for an application ONLY. Naming nobody is refused.
   *   nothing      → unknown: every tool is hidden and refused
   *
   * With `identify`, the dedup key is DERIVED from `(tool, caller, workKey)` instead of being the
   * client's string, and the run's owner is written to the journal so `listRuns`/`purgeResource` can
   * find it. Without it, the server keeps the old behaviour and warns once — right for a stdio server
   * whose one client spawned it.
   */
  identify?: Identify;
  /**
   * What NAMES the unit of work, when the client does not.
   *
   * The default is the client's `idempotencyKey`, which @gnldev/mcp's own client sends. A third-party
   * MCP client does not: measured over a real SDK Client, three identical `tools/call` requests with no
   * `_meta` ran the tool three times, and declaring `idempotency: 'args'` on the tool did not help —
   * without a key there is no journal record for that declaration to apply to.
   *
   * Nothing is invented for those calls, because what makes two requests "the same work" is a domain
   * question and getting it wrong collapses a legitimate second purchase of the same amount. This hook
   * is where a deployment answers it, e.g. `({ name, arguments: a }) => argsHash({ name, a })` to treat
   * identical arguments as one unit, or a field the caller already sends (`a.orderId`).
   *
   * Returning undefined means this call is not deduped — it runs, and nothing is journaled for it.
   *
   * IT REPLACES THE CLIENT'S KEY, it does not fall back to it. Measured: with `argsHash` here, two calls
   * carrying the SAME arguments and DIFFERENT `_meta.idempotencyKey` values ran the tool ONCE; without it,
   * twice. That is the intended meaning of "identical arguments are one unit of work" — but it applies to
   * every client, including @gnldev/mcp's own, which was sending a key that now no longer decides
   * anything. If two operations with identical arguments are legitimately distinct in your domain, read
   * `req.idempotencyKey` inside this function rather than ignoring it.
   */
  workKey?: (req: { name: string; arguments?: Record<string, unknown>; idempotencyKey?: string }) => string | undefined;
  /**
   * May this caller reach this tool at all?
   *
   * Consulted for BOTH `tools/list` and `tools/call`, from one place, because checking only the call
   * still hands the caller the tool's name and argument schema — information it cannot use, and an
   * invitation the model will follow. A tool a caller may not run is a tool it does not see.
   *
   * `identity` answers WHO; this answers WHAT. Neither answers "is THIS object theirs" — only the tool
   * can, which is what the function form of `tools` is for.
   *
   * Async, so the answer may come from a database or an HTTP call. @gnldev/auth-ee's `fga.check(...)`
   * is synchronous and evaluates an in-memory rule list, so it fits here directly; a query per call
   * does not have to, and putting one on this path makes every tool call depend on that store being up.
   *
   * Left out → every exposed tool is reachable by any caller (the previous behaviour), and a warning
   * says so once.
   */
  allowTool?: (req: McpToolRequestInfo) => boolean | Promise<boolean>;
  /**
   * How often one caller may run tools.
   *
   * Identity and permission both pass for a caller that simply calls too much: measured on the previous
   * version, 10,000 `charge` calls under 10,000 different work keys all ran, every one of them
   * legitimate by identity and by permission. Nothing counted.
   *
   * The object form is a fixed window counted IN THIS PROCESS. That is a real limit and it is stated
   * rather than hidden: two instances behind a load balancer each allow `maxCalls` — measured, 6 calls
   * for a limit of 3. A deployment that needs one quota across instances passes a FUNCTION, and the
   * journal already carries the primitive for it: `incrBy` is atomic on every shipped storage and is what
   * `@gnldev/durable`'s budget accounting uses. The README has the recipe, and
   * `test/shared-rate-limit.test.ts` runs it across two servers on one journal — the escape hatch is
   * exercised rather than asserted.
   */
  rateLimit?:
    | { maxCalls: number; windowMs: number }
    | ((req: McpToolRequestInfo) => boolean | Promise<boolean>);
  /** The scope the derived id is unique within. 'resource' (the default) needs a resourceId; 'org'
   *  addresses work owned by the installation rather than by a person. Read @gnldev/durable's note on
   *  WorkScope before choosing 'org' — the two mistakes do not cost the same. */
  workScope?: WorkScope['kind'];
}

export interface McpServer {
  /**
   * BREAKING from 0.5.0: async, and it takes the caller.
   *
   * Both follow from `allowTool` and the function form of `tools`: a list filtered per caller cannot be
   * computed without knowing who is asking, and neither hook can be synchronous if the answer may come
   * from a store. A server with a static tool set and no hooks returns the same list it always did.
   */
  listTools(req?: { caller?: McpCallerContext; resourceId?: string }): Promise<{ tools: McpToolDef[] }>;
  callTool(req: {
    name: string;
    arguments?: Record<string, unknown>;
    idempotencyKey?: string;
    /** What the transport knows about the caller. `serveMcp` fills this from the SDK's handler `extra`;
     *  an in-process caller passes it directly. Never read from the request body. */
    caller?: McpCallerContext;
    /** The end user an APPLICATION principal acts for (`params._meta.resourceId` over the wire). Read for
     *  an application only: a user is itself and staff is staff, whatever this says. */
    resourceId?: string;
  }): Promise<any>;
}

// --- Argument validation (callTool, BEFORE execute) ------------------------------------------
// inputSchema can arrive in two forms: a plain JSON Schema object (for the listTools announcement) or
// an EXECUTABLE schema — a zod/valibot-like `safeParse` or the standard-schema `~standard`
// interface (AI SDK tools can carry either). If there is NO executable surface, validation is
// SKIPPED: we have no JSON Schema interpreter, and a false-positive rejection (dropping a valid
// request) is worse than not validating at all — in this case the old behavior is preserved as-is.
type ArgCheck = { ok: true; value: any } | { ok: false; message: string };

/** Makes the issue path human-readable (standard-schema path items can be a `{ key }` object). */
function formatIssuePath(path: any): string {
  if (!Array.isArray(path) || path.length === 0) return '(root)';
  return path.map((seg: any) => (seg && typeof seg === 'object' && 'key' in seg ? String(seg.key) : String(seg))).join('.');
}

function formatIssues(issues: any[]): string {
  return issues.map((i: any) => `${formatIssuePath(i?.path)}: ${i?.message ?? 'invalid value'}`).join('; ');
}

/** Detects the schema type and validates args; on success returns the TRANSFORMED value (default/coercion). */
async function checkToolArgs(schema: any, args: Record<string, unknown>): Promise<ArgCheck> {
  if (!schema || typeof schema !== 'object') return { ok: true, value: args };
  // 1) zod/valibot-like: safeParse — synchronous; r.data is the transformed value.
  if (typeof schema.safeParse === 'function') {
    const r = schema.safeParse(args);
    if (r?.success) return { ok: true, value: r.data };
    const issues = r?.error?.issues ?? r?.error?.errors ?? [];
    return { ok: false, message: formatIssues(issues) || String(r?.error ?? 'schema validation failed') };
  }
  // 2) standard-schema (`~standard.validate`) — per spec the result can be sync or a Promise.
  const std = schema['~standard'];
  if (std && typeof std.validate === 'function') {
    const r = await std.validate(args);
    if (r?.issues) return { ok: false, message: formatIssues(r.issues as any[]) || 'schema validation failed' };
    return { ok: true, value: r?.value };
  }
  // 3) Plain JSON Schema / unrecognized type → validation is skipped (rationale above; old behavior).
  return { ok: true, value: args };
}

/** A structured MCP tool error — the shape this file already uses for a failed argument check, so a
 *  refusal travels through the protocol instead of becoming a transport-level exception. */
function toolError(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * A configured hook threw, told to the caller without telling it the deployment's business.
 *
 * `identity`, `allowTool`, `workKey` and `rateLimit` are the deployment's own functions, and the useful
 * ones reach a store: an OAuth introspection, an FGA rule set, a Redis counter. Those fail, and when
 * they did the exception travelled straight through the protocol. Measured over a real SDK Client:
 *
 *   MCP error -32603: pg: connection to 10.0.3.14:5432 refused (user=svc_gnl)
 *
 * An internal address, a port and a service account name, handed to whoever called. Every hook already
 * failed CLOSED \u2014 measured, the tool ran zero times in all four cases \u2014 so this is disclosure,
 * not a bypass.
 *
 * Same rule as the two other refusals on this door, and it was applied to those and not to this one:
 * the caller gets an answer it can act on, the deployment keeps its details. The real error goes to the
 * server log where the operator is, and the hook can log more since it is their code. WHICH hook failed
 * is included \u2014 that is not a secret, and it is the difference between a useful report and
 * "something went wrong".
 */
function hookFailure(hook: string, err: unknown): Error {
  console.error(`@gnldev/mcp: the '${hook}' hook threw:`, err);
  return new Error(`MCP server: the '${hook}' hook failed (see the server log)`);
}

/**
 * A run blocked by GNL's own protection, told to the caller the way the REST host already tells it.
 *
 * Concurrent calls under the SAME key are the NORMAL case on this door — a double-click, a client
 * retrying on timeout, two workers draining one queue — and the guarantee handles them correctly:
 * measured, 10 parallel calls to a 20 ms tool under one key ran the side effect exactly ONCE. But nine
 * of those ten callers received a raw `RunBusyError` thrown through the protocol, which reads as "your
 * call failed" for work that had in fact succeeded. That is the ambiguity the whole package exists to
 * remove, reintroduced one layer up.
 *
 * `@gnldev/server` already had the answer and this door was not using it: `blockedErrorCode` is (its
 * own words) the ONE source of truth for these names, and the REST host maps `run_busy` to 409 with
 * `resumable: true` — well-formed request, collides with something in flight, succeeds on retry. MCP has
 * no status codes, so the code and the retryable flag are carried in the text where a client (or a
 * model) can act on them, instead of a sentence it has to parse.
 */
function blockedToolError(err: unknown, toolName: string): { isError: true; content: { type: 'text'; text: string }[] } | undefined {
  const code = blockedErrorCode(err);
  if (code === undefined) return undefined;
  const message = err instanceof Error ? err.message : String(err);
  // `retry_limit_exceeded` is the one that will NOT succeed on a retry — the REST host gives it 422
  // without `resumable`, and advertising it as retryable would put a client in a loop.
  const resumable = code !== 'retry_limit_exceeded';
  return toolError(
    `[${code}] ${message}` +
      (resumable
        ? ` — retry the SAME call with the SAME idempotencyKey; the work is in flight or awaiting a decision, and retrying is how you collect its result. It has NOT been run twice.`
        : ` — this will not succeed on retry for '${toolName}'.`),
  );
}

/**
 * The web Request `identify` is handed for one MCP message: the transport's own request when it has one,
 * else a request carrying only the token the transport validated. The transport's validated token is
 * added when the request lacks an `authorization` header, so a provider reading the header sees it.
 */
function requestOf(caller: McpCallerContext): Request {
  const headers = new Headers(caller.request?.headers);
  const token = caller.authInfo?.token;
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return new Request(caller.request?.url ?? 'http://mcp.invalid/', { method: 'POST', headers });
}

/**
 * A tool's input schema as MCP announces it: JSON Schema. An AI SDK tool (a `createRagTool`) carries an
 * executable schema — zod, a standard-schema, or an AI SDK `jsonSchema()` wrapper — and announcing that
 * object as it is failed the SDK's own `tools/list` validation, so such a tool could be called in
 * process and never listed over the wire (measured). A plain JSON Schema is announced unchanged.
 */
async function announcedSchema(schema: any): Promise<any> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, additionalProperties: true };
  if ('jsonSchema' in schema) return await schema.jsonSchema;
  if (typeof schema.safeParse === 'function' || schema['~standard']) return await asSchema(schema).jsonSchema;
  return schema;
}

/** Produces an MCP server surface from a tool set (listTools + callTool). */
export function createMcpServer(opts: McpServerOptions): McpServer {
  // The replaced option fails loudly: a JavaScript config that still passes it would otherwise run every
  // call as `unknown` and hide every tool, with nothing saying why.
  if ((opts as { identity?: unknown }).identity !== undefined) {
    throw new TypeError(
      '@gnldev/mcp: `identity` was replaced by `identify` (0.7.0): it takes the request and returns a Principal from ' +
        "@gnldev/auth — `identify: (req) => auth.authenticate(req)`, or `{ kind: 'subject', id, orgId, roles: [] }` for an end user.",
    );
  }
  // Said once per server, not per call: a warning printed on every request is a warning nobody reads.
  let warnedAboutIdentity = false;
  const warnMissingIdentity = (toolName: string) => {
    if (warnedAboutIdentity) return;
    warnedAboutIdentity = true;
    console.warn(
      `@gnldev/mcp: this server dedupes by a key the CLIENT chooses (tool '${toolName}'), and resolves no ` +
        `caller identity.\n` +
        `  Two callers who send the same idempotencyKey share one journal record, so the second one is ` +
        `served the first one's RESULT without running the tool, and a caller who claims a key first ` +
        `suppresses the work later sent under it.\n` +
        `  Nothing records whose call it was either, so listRuns() and purgeResource() cannot find it.\n` +
        `  Pass \`identify\` to createMcpServer to resolve the caller from what the transport ` +
        `authenticated. On a stdio transport, where the client spawned this process, the current ` +
        `behaviour is the correct one and this warning can be ignored.`,
    );
  };

  let warnedAboutWorkKey = false;
  const warnMissingWorkKey = (toolName: string) => {
    if (warnedAboutWorkKey) return;
    warnedAboutWorkKey = true;
    console.warn(
      `@gnldev/mcp: a call to '${toolName}' named no unit of work, so it was NOT deduped — it ran, and ` +
        `nothing was journaled for it.\n` +
        `  The caller sent no \`_meta.idempotencyKey\`, which is normal for third-party MCP clients; ` +
        `@gnldev/mcp's own client sends one. A retry of this call runs the side effect again.\n` +
        `  Pass \`workKey\` to createMcpServer to say what identifies work here — for example ` +
        `\`argsHash\` over the tool name and arguments, or an id the caller already includes. This is ` +
        `left to you on purpose: collapsing identical arguments would also collapse a legitimate second ` +
        `purchase of the same amount.`,
    );
  };

  let warnedAboutAllowTool = false;
  const warnMissingAllowTool = () => {
    if (warnedAboutAllowTool) return;
    warnedAboutAllowTool = true;
    console.warn(
      '@gnldev/mcp: every exposed tool is reachable by every caller — no `allowTool` is configured.\n' +
        '  Knowing WHO is calling does not say WHAT they may call: a reporting integration that only needs ' +
        'to read can also invoke a delete, and it is handed the name and argument schema of every tool ' +
        'either way.\n' +
        '  Pass `allowTool` to createMcpServer. @gnldev/auth-ee\'s `fga.check(principal, { type: \'tool\', ' +
        "id: name }, 'run')` answers exactly this question and is synchronous.",
    );
  };

  // ONE checkpoint. The caller, the sealed context, the tool set and the permission answer are produced
  // here and nowhere else, because `tools/list` and `tools/call` must agree about them: a tool the list
  // shows and the call refuses (or worse, the reverse) is the shape this package has already been wrong
  // in twice. Both doors below call this and nothing else.
  type Prepared = { caller: McpCallerContext; principal: Principal | undefined; runsAs: Caller; tools: Record<string, McpServerToolDef>; context: RequestContext };
  async function prepare(caller: McpCallerContext | undefined, named: string | undefined): Promise<Prepared | { refused: string }> {
    const c = caller ?? {};
    let principal: Principal | undefined;
    let runsAs: Caller = UNKNOWN;
    if (opts.identify) {
      let who;
      try {
        who = await callerOfRequest(opts.identify, requestOf(c), named);
      } catch (err) {
        throw hookFailure('identify', err);
      }
      if ('refused' in who) return who;
      principal = who.principal;
      runsAs = who.caller;
    }
    // Sealed BEFORE the user's function sees it: the reserved keys are stripped from whatever was
    // supplied and rewritten from the caller, so the tool set cannot be built from a subject the caller
    // named. Same function @gnldev/durable seals agent contexts with.
    const context = sealRequestContext({}, {
      ...(runsAs.kind === 'user' ? { resourceId: runsAs.id } : {}),
      ...(runsAs.kind !== 'unknown' && runsAs.orgId !== undefined ? { orgId: runsAs.orgId } : {}),
      ...(runsAs.kind === 'staff' ? { staff: true } : {}),
    });
    let tools: Record<string, McpServerToolDef>;
    if (typeof opts.tools === 'function') {
      // Wrapped like the other hooks: this IS a hook — the deployment's own function, and the one most
      // likely to reach a database, since a per-caller tool set is usually built from one.
      try {
        tools = await opts.tools(context);
      } catch (err) {
        throw hookFailure('tools', err);
      }
    } else {
      tools = opts.tools;
    }
    return { caller: c, principal, runsAs, tools, context };
  }

  /**
   * What a tool is told about its caller, on the paths that do not go through `durableTool` (which
   * hands it the run's identity itself). These called `t.execute(args)` bare, so a tool that serves end
   * users had nobody to narrow to: `createRagTool` answered one user with another's documents.
   */
  function callerOptions(runsAs: Caller): { toolCallId: string; gnl: GnlToolContext } {
    return { toolCallId: 'mcp', gnl: toolContextFor(runIdentity(runsAs, 'mcp')) };
  }

  /** The permission answer, for one tool, asked the same way by both doors. */
  async function permitted(name: string, p: Prepared): Promise<boolean> {
    // A server that resolves identity does not serve a caller it could not attribute — on either door,
    // whether or not the call names a unit of work. Before, a call with no work key ran the tool for
    // an unknown caller: measured with an unknown token, `{"charged":9,"for":null}`. That is Claude
    // Desktop's default path, since it sends no `_meta`. The tool is hidden from listing too, so a
    // model never tries a tool it cannot call. A user and staff are attributable; `unknown` is not.
    if (opts.identify && p.runsAs.kind === 'unknown') return false;
    if (!opts.allowTool) {
      warnMissingAllowTool();
      return true;
    }
    try {
      return (await opts.allowTool({ name, caller: p.caller, principal: p.principal, runsAs: p.runsAs })) === true;
    } catch (err) {
      throw hookFailure('allowTool', err);
    }
  }

  // Fixed-window counter, per subject, in THIS process — see `rateLimit`'s note for why that limit is
  // stated rather than papered over. Keyed by the resolved subject when there is one; a server with no
  // `identity` has one bucket for everybody, which is the honest reading of "we cannot tell callers
  // apart".
  // The window table is its own module so that `size()` can be asserted — the half of the sweep that
  // no behaviour distinguishes. See rate-window.ts for the two measurement attempts that failed first.
  // Built lazily and only for the object form: a `rateLimit` function keeps its own count.
  let windows: RateWindow | undefined;
  async function withinRate(info: McpToolRequestInfo): Promise<boolean> {
    const rl = opts.rateLimit;
    if (!rl) return true;
    if (typeof rl === 'function') {
      try {
        return (await rl(info)) === true;
      } catch (err) {
        throw hookFailure('rateLimit', err);
      }
    }
    windows ??= createRateWindow(rl);
    // The caller, not the connection: a rate limit without one punishes whichever caller happens to
    // arrive after a noisy neighbour. A user is its own bucket (an application's users each theirs);
    // staff is its kind-qualified name. A server with no `identify` has one bucket for everybody, which
    // is the honest reading of "we cannot tell callers apart".
    const r = info.runsAs;
    return windows.bump(r.kind === 'user' ? r.id : (actorIdOf(info.principal) ?? (r.kind === 'staff' ? r.orgId : undefined) ?? '__anonymous'));
  }

  /** A tool's description as MCP announces it: a string, or the AI SDK's function of the context. */
  function describe(t: McpServerToolDef, context: RequestContext): string | undefined {
    if (typeof t.description !== 'function') return t.description;
    try {
      return t.description({ context });
    } catch (err) {
      throw hookFailure('description', err);
    }
  }

  return {
    async listTools(req) {
      const p = await prepare(req?.caller, req?.resourceId);
      // A refused caller (an application that named nobody) sees nothing — the same as an unknown one.
      if ('refused' in p) return { tools: [] };
      const out: McpToolDef[] = [];
      for (const [name, t] of Object.entries(p.tools)) {
        if (typeof t.execute !== 'function' || !(await permitted(name, p))) continue;
        out.push({ name, description: describe(t, p.context), inputSchema: await announcedSchema(t.inputSchema) });
      }
      return { tools: out };
    },
    async callTool(req) {
      const p = await prepare(req.caller, req.resourceId);
      // Answered BEFORE the tool is looked up, so the refusal says nothing about which tools exist.
      if ('refused' in p) return toolError(p.refused);
      const { runsAs } = p;
      const t = p.tools[req.name];

      // MISSING AND FORBIDDEN ARE THE SAME ANSWER, and that is the whole point of filtering the list.
      //
      // These were two different answers, and the difference was an oracle. A caller whose `tools/list`
      // came back EMPTY could still enumerate the entire namespace by trying names and reading the
      // replies: an existing tool it had no permission for answered `{isError, "Not permitted:
      // 'delete_account'"}` while an invented name THREW `no such tool`. Two axes gave it away — the
      // text, and structured-error versus exception. Measured on a server with `allowTool: () => false`:
      // the list said nothing existed and the call door named `delete_account` and `rotate_secrets`
      // exactly. Filtering the list is a claim that a caller does not see these tools; a call door that
      // confirms them makes that claim false.
      //
      // The 404-for-403 trade is deliberate: an operator debugging "why can't my client call this" gets
      // a misleading message. The place to answer that is `allowTool` itself — it is the deployment's own
      // function and it already knows the reason, so logging belongs there rather than in a reply sent to
      // the caller being refused.
      //
      // Permission is asked BEFORE argument validation for the same reason: a refused caller must not be
      // able to map a tool's schema by reading which field the server complained about.
      const execute = t?.execute;
      const reachable = t !== undefined && typeof execute === 'function' && (await permitted(req.name, p));
      if (!reachable || !execute) throw new Error(`MCP server: no such tool: ${req.name}`);
      if (!(await withinRate({ name: req.name, caller: p.caller, principal: p.principal, runsAs }))) {
        return toolError(`Rate limit exceeded for '${req.name}'`);
      }
      // Validate arguments against inputSchema BEFORE execute (if the schema is executable).
      // Invalid arg → MCP's structured tool error ({ isError, content }) — the serveMcp bridge
      // doesn't touch results that already carry content, so this error passes through the protocol as-is.
      const checked = await checkToolArgs(t.inputSchema, req.arguments ?? {});
      if (!checked.ok) return toolError(`Invalid argument (tool: ${req.name}) — ${checked.message}`);

      if (!opts.journal) return execute(checked.value, callerOptions(runsAs));

      // The client's key is a LABEL for the work, unique only within one caller — never the id itself.
      // A deployment may name the work some other way; see the `workKey` option for why that is its
      // decision rather than a default here.
      let workKey: string | undefined;
      try {
        workKey = opts.workKey ? opts.workKey(req) : req.idempotencyKey;
      } catch (err) {
        throw hookFailure('workKey', err);
      }

      // ── the caller resolved server-side → derive the id, and record whose it is ──────────────────
      if (opts.identify) {
        // NO WORK NAMED, so there is nothing to dedupe against and nothing to journal — this call runs
        // exactly as it did before. Refusing instead was the first version of this branch, and it broke
        // every third-party client: measured over a real SDK Client, three ordinary `tools/call`
        // requests with no `_meta` were all rejected and the tool never ran. A server that refuses the
        // clients it exists to serve is not a safer server.
        if (workKey === undefined) {
          warnMissingWorkKey(req.name);
          return execute(checked.value, callerOptions(runsAs));
        }
        const scopeKind = opts.workScope ?? 'resource';
        const orgId = runsAs.kind === 'unknown' ? undefined : runsAs.orgId;
        let resolved;
        try {
          resolved = resolveWorkIdentity(`mcp:${req.name}`, {
            workKey,
            scopeKind,
            ...(runsAs.kind === 'user' ? { resourceId: runsAs.id } : {}),
            ...(orgId ? { orgId } : {}),
            // A resolver was configured, so an unattributable call is a refusal. Falling back to the
            // client's key here would reinstate the hole for exactly the calls that could not be
            // attributed — the ones an attacker controls.
            anonymous: 'refuse',
            surface: `mcp tools/call '${req.name}'`,
          });
        } catch (err) {
          return toolError(
            `Refusing to run '${req.name}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const runId = resolved.runId!;
        // WHICH ORGANIZATION'S JOURNAL. The derived id names the work within a subject, and two
        // organizations can each have a user `u1` with an invoice `inv-7`. Measured with one shared
        // journal: globex's charge of 1 returned acme's `{charged: 900}` and never ran. @gnldev/server
        // scopes each organization's journal with `withOrg`; this door does the same, so the record
        // also lands where that organization's own readers (listRuns, purgeResource) look for it.
        const journal = orgId ? withOrg(opts.journal, orgId) : opts.journal;
        // WHOSE RUN THIS IS — the same entry as every run kind (@gnldev/durable admitRun): the owner is
        // recorded at birth, a derived run someone else owns is refused, and a re-entry acts for the
        // recorded owner. `actor` is who acted, kind-qualified for staff and applications.
        const actor = actorIdOf(p.principal);
        const { acting } = await admitRun(journal, runId, runsAs, {
          ...(actor ? { actor } : {}),
          ...(resolved.work ? { workKey: resolved.work.workKey, workScope: resolved.work.workScope } : {}),
        });
        const dt = durableTool({ ...t, execute }, { journal, runId, identity: runIdentity(acting, runId) }, req.name);
        try {
          return await dt.execute(checked.value, { toolCallId: 'mcp' });
        } catch (err) {
          const blocked = blockedToolError(err, req.name);
          if (blocked) return blocked;
          throw err;
        }
      }

      // ── no resolver: the previous behaviour, kept working and no longer silent ──────────────────
      if (workKey !== undefined) {
        warnMissingIdentity(req.name);
        const dt = durableTool({ ...t, execute }, { journal: opts.journal, runId: workKey, identity: runIdentity(runsAs, workKey) }, req.name);
        try {
          return await dt.execute(checked.value, { toolCallId: 'mcp' });
        } catch (err) {
          const blocked = blockedToolError(err, req.name);
          if (blocked) return blocked;
          throw err;
        }
      }
      return execute(checked.value);
    },
  };
}

/** The SDK's `extra.requestInfo` (headers, url) as a web Request — what `identify` reads. */
function requestFromInfo(info: { headers?: Record<string, string | string[] | undefined>; url?: URL }): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(info.headers ?? {})) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  return new Request(info.url ? String(info.url) : 'http://mcp.invalid/', { method: 'POST', headers });
}

/**
 * Lazily loads the `@modelcontextprotocol/sdk` Server and connects it to a transport; publishes
 * createMcpServer as a real MCP server (optional peer; string-import → build doesn't break without the SDK).
 */
export async function serveMcp(server: McpServer, transport: any, info: { name?: string; version?: string } = {}): Promise<void> {
  const [{ Server }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js') as Promise<any>,
    import('@modelcontextprotocol/sdk/types.js') as Promise<any>,
  ]);
  const s = new Server({ name: info.name ?? 'gnl', version: info.version ?? '0.0.0' }, { capabilities: { tools: {} } });
  // setRequestHandler expects a REAL Zod schema (it reads the method literal from the schema) — a plain
  // `{ method: '...' }` object blows up in the SDK with "Schema is missing a method literal".
  // ONE reading of the SDK's handler context, used by both handlers. Built twice, the two doors would
  // eventually disagree about who is calling — and `tools/list` filtering is only as good as the
  // identity it filters by.
  const callerOf = (extra: any): McpCallerContext => ({
    ...(extra?.requestInfo?.headers ? { request: requestFromInfo(extra.requestInfo) } : {}),
    ...(extra?.authInfo
      ? {
          authInfo: {
            ...(typeof extra.authInfo.token === 'string' ? { token: extra.authInfo.token } : {}),
            ...(typeof extra.authInfo.clientId === 'string' ? { clientId: extra.authInfo.clientId } : {}),
            ...(Array.isArray(extra.authInfo.scopes) ? { scopes: extra.authInfo.scopes as string[] } : {}),
          },
        }
      : {}),
    ...(typeof extra?.sessionId === 'string' ? { sessionId: extra.sessionId } : {}),
  });
  // The LIST is filtered per caller too, so this handler needs `extra` exactly as much as the call
  // handler does. It took none, which is why a filtered list was not possible before.
  // The end user an APPLICATION names, from `params._meta` — written by the client's code, not by the
  // model (the model writes `arguments`). Read by the server for an application principal only.
  const namedOf = (req: any): { resourceId?: string } => {
    const r = req?.params?._meta?.resourceId;
    return typeof r === 'string' ? { resourceId: r } : {};
  };
  s.setRequestHandler(ListToolsRequestSchema, async (req: any, extra: any) =>
    server.listTools({ caller: callerOf(extra), ...namedOf(req) }),
  );
  // TWO parameters. The SDK passes `(request, extra)`, and this handler took only the first — so
  // `extra.authInfo` (the access token the transport validated) and `extra.sessionId` were dropped on
  // the floor, and the only thing left to identify a caller with was a string the caller had typed.
  s.setRequestHandler(CallToolRequestSchema, async (req: any, extra: any) => {
    // Defensive check: the SDK schema normally guarantees this, but the bridge must NEVER pass a
    // non-string name to createMcpServer — otherwise the error message would be misleading.
    const name = req?.params?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`MCP bridge: 'params.name' for tools/call must be a non-empty string (received: ${name === '' ? 'empty string' : typeof name})`);
    }
    // MCP spec: params._meta is a free/'loose' meta field — the client (see src/index.ts
    // toolsFromDefs) carries idempotencyKey here. If present, pass it to createMcpServer.callTool →
    // journal-based server-side exactly-once is now also active for real MCP Client calls.
    const idempotencyKey = req.params?._meta?.idempotencyKey;
    // From the transport, not from the body. `_meta` is whatever the caller wrote; `extra.authInfo` is
    // what the transport accepted. Only the second can say who is calling.
    const caller = callerOf(extra);
    const result = await server.callTool({
      name,
      arguments: req.params?.arguments,
      ...(typeof idempotencyKey === 'string' && idempotencyKey ? { idempotencyKey } : {}),
      caller,
      ...namedOf(req),
    });
    // The SDK validates the handler's return against CallToolResultSchema (expects `{ content: [...] }`).
    // createMcpServer's tools can return a raw value (existing contract preserved) — here, ONLY in the
    // bridge, wrap it into MCP content format (if it's already in that format, DON'T TOUCH it).
    if (result && typeof result === 'object' && Array.isArray((result as any).content)) return result;
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  });
  await s.connect(transport);
}
