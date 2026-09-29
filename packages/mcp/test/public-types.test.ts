// `createMcpServer`'s caller options, as a user of the package writes them: `identify` (WHO — the
// application's one answer, @gnldev/auth `Identify`), `allowTool` (WHAT they may call) and `rateLimit`
// (HOW OFTEN), the last two handed `{ name, caller, principal, runsAs }`. Those four fields are the
// whole authorization surface of an MCP door: a hook that could no longer see `principal`, or saw it
// as `any`, would compile against a rule that reads the wrong thing, and the first sign would be a
// tool served to the wrong caller. The option 0.7 replaced (`identity`) must not compile; the server
// throws on it at construction, but only a JavaScript caller or a cast ever reaches that throw.
//
// Type-level, so it runs the compiler against the published declarations (dist): vitest does not
// type-check test files, and an `expectTypeOf` here would pass whatever the types said. Positive cases
// are the README's own snippets, so the docs and the types are held together. Every negative case is a
// positive one with exactly ONE mutation, and asserts the SPECIFIC error code it produces — a typo'd
// import also fails to compile (TS2305), and a count-only check would pass for that reason.
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** Applies ONE textual mutation; throws unless `from` occurs exactly once, so a stale mutation fails loudly. */
function mutate(base: string, from: string, to: string): string {
  const at = base.indexOf(from);
  if (at < 0 || base.indexOf(from, at + 1) >= 0) throw new Error(`mutation anchor must occur exactly once: ${from}`);
  return base.slice(0, at) + to + base.slice(at + from.length);
}
/** Exactly one diagnostic, with this code, whose message names what the mutation broke. */
const only = (code: number, names: string) => [{ code, message: expect.stringContaining(names) }];

const HELPERS = `
type IsAny<T> = 0 extends 1 & T ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
`;

// README: your own mapping from a validated credential to an end user.
const README_TENANT = `
import { createMcpServer } from '@gnldev/mcp';
import type { Principal } from '@gnldev/auth';
import type { Journal } from '@gnldev/durable';
declare const journal: Journal;
declare const payments: { charge(amount: number): Promise<unknown> };

/** Your own mapping from a credential the transport already validated to an END USER. */
const tenantOf = (req: Request): Principal | undefined =>
  req.headers.get('authorization') === 'Bearer acme-key' ? { kind: 'subject', id: 'acme-ltd', roles: [] } : undefined;

const charge = {
  description: 'Charge the customer',
  execute: async ({ amount }: { amount: number }) => payments.charge(amount),
};

const server = createMcpServer({
  tools: { charge },
  journal,
  identify: tenantOf,
});
export { server };
`;

// README: the provider the HTTP API uses is the function.
const README_PROVIDER = `
import { roleAuth } from '@gnldev/auth';
import { createMcpServer } from '@gnldev/mcp';

const auth = roleAuth({
  admin: { token: process.env.GNL_STAFF_TOKEN!, orgId: 'acme' },
  client: { token: process.env.GNL_APP_TOKEN!, orgId: 'acme' },
  endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' },
})!;

export const server = createMcpServer({
  tools: {},
  identify: (req) => auth.authenticate(req),
});
`;

// README: the five layers (identify, allowTool, rateLimit, tools as a function, workKey).
const README_LAYERS = `
import { createMcpServer } from '@gnldev/mcp';
import { serverIdentityOf, argsHash, type Journal } from '@gnldev/durable';
declare const journal: Journal;
declare const db: { ownerOf(orderId: string): Promise<string | undefined> };
declare const payments: { refund(orderId: string): Promise<unknown> };

const ownerOf = async (orderId: string): Promise<string | undefined> => db.ownerOf(orderId);
const refund = async (orderId: string) => payments.refund(orderId);

const server = createMcpServer({
  journal,
  identify: (req) => (req.headers.get('authorization') === 'Bearer acme-key' ? { kind: 'subject', id: 'acme-ltd', roles: [] } : undefined),
  allowTool: ({ name, caller }) => (caller.authInfo?.scopes ?? []).includes(\`tool:\${name}\`),
  rateLimit: { maxCalls: 100, windowMs: 60_000 },
  tools: (ctx) => {
    const me = serverIdentityOf(ctx).resourceId;
    return {
      refund: { execute: async ({ orderId }: { orderId: string }) => {
        if (await ownerOf(orderId) !== me) throw new Error('not your order');
        return refund(orderId);
      } },
    };
  },
  workKey: (req) => argsHash({ name: req.name, args: req.arguments }),
});
export { server };
`;

// README: one quota across instances — a rateLimit FUNCTION reading \`runsAs\`.
const README_SHARED_RATE = `
import { createMcpServer, type McpServerOptions } from '@gnldev/mcp';
import { type Journal } from '@gnldev/durable';
declare const journal: Journal;
declare const tools: McpServerOptions['tools'];

function sharedRateLimit(journal: Journal, o: { maxCalls: number; windowMs: number }): McpServerOptions['rateLimit'] {
  return async ({ runsAs }) => {
    const subject = runsAs.kind === 'user' ? runsAs.id : runsAs.kind === 'staff' ? \`staff:\${runsAs.orgId ?? ''}\` : '__anonymous';
    const key = \`__ratelimit:\${subject}:\${Math.floor(Date.now() / o.windowMs)}\`;
    await journal.incrBy!(key, { calls: 1 });
    return ((await journal.getCounters!(key))?.calls ?? 0) <= o.maxCalls;
  };
}

createMcpServer({ tools, journal, rateLimit: sharedRateLimit(journal, { maxCalls: 100, windowMs: 60_000 }) });
`;

// What the hooks receive and must return, and that they are the shared contract.
const CALLBACKS = `
import { createMcpServer, type McpServerOptions, type McpToolRequestInfo, type McpCallerContext } from '@gnldev/mcp';
import type { Identify, Principal, EngineCaller } from '@gnldev/auth';
${HELPERS}
declare function check(principal: Principal, tool: string): Promise<boolean>;

const optOut = createMcpServer({ tools: {}, identify: () => undefined });
const server = createMcpServer({
  tools: {},
  identify: async (req) => (req.headers.get('x-staff') ? { kind: 'operator', roles: ['admin'], orgId: 'acme' } : null),
  allowTool: async ({ name, caller, principal, runsAs }) => {
    const transport: McpCallerContext = caller;
    const who: EngineCaller = runsAs;
    const staff: boolean = principal?.kind === 'operator';
    if (!principal) return false;
    return staff || (who.kind === 'user' && transport.sessionId !== undefined && (await check(principal, name)));
  },
  rateLimit: (info) => info.runsAs.kind !== 'unknown' && info.name !== 'bulk_export',
});
// The door takes the SAME function every door takes; both hooks are told the same four things.
const sameIdentify: Same<McpServerOptions['identify'], Identify | undefined> = true;
const allowInfo: Same<Parameters<NonNullable<McpServerOptions['allowTool']>>[0], McpToolRequestInfo> = true;
const rateInfo: Same<Parameters<Extract<NonNullable<McpServerOptions['rateLimit']>, (...a: never[]) => unknown>>[0], McpToolRequestInfo> = true;
const principalField: Same<McpToolRequestInfo['principal'], Principal | undefined> = true;
const runsAsField: Same<McpToolRequestInfo['runsAs'], EngineCaller> = true;
const nameField: Same<McpToolRequestInfo['name'], string> = true;
const allowResult: Same<ReturnType<NonNullable<McpServerOptions['allowTool']>>, boolean | Promise<boolean>> = true;
const notAny1: IsAny<McpServerOptions> = false;
const notAny2: IsAny<McpToolRequestInfo> = false;
const notAny3: IsAny<McpToolRequestInfo['principal']> = false;
const notAny4: IsAny<McpToolRequestInfo['runsAs']> = false;
const notAny5: IsAny<McpToolRequestInfo['caller']> = false;
const notAny6: IsAny<McpServerOptions['rateLimit']> = false;
// Same<> alone cannot see an any return (a function returning any is assignable both ways), so ask directly.
const notAny7: IsAny<ReturnType<NonNullable<McpServerOptions['identify']>>> = false;
const notAny8: IsAny<ReturnType<NonNullable<McpServerOptions['allowTool']>>> = false;
export { optOut, server, sameIdentify, allowInfo, rateInfo, principalField, runsAsField, nameField, allowResult, notAny1, notAny2, notAny3, notAny4, notAny5, notAny6, notAny7, notAny8 };
`;

describe('createMcpServer: identify, allowTool, rateLimit', () => {
  const cases = {
    readmeTenant: README_TENANT,
    readmeProvider: README_PROVIDER,
    readmeLayers: README_LAYERS,
    readmeSharedRate: README_SHARED_RATE,
    callbacks: CALLBACKS,
    // 0.6's hook, replaced in 0.7. It must not compile, even though the server also throws on it.
    removedIdentity: mutate(CALLBACKS, '{ tools: {}, identify: () => undefined }', "{ tools: {}, identity: () => ({ resourceId: 'u-1' }) }"),
    toolsRequired: mutate(README_PROVIDER, '  tools: {},\n', ''),
    // 0.6 handed the hooks \`identity\`; 0.7 hands them \`principal\` and \`runsAs\`.
    hookHasNoIdentity: mutate(README_LAYERS, 'allowTool: ({ name, caller })', 'allowTool: ({ name, caller, identity })'),
    allowToolReturnsBoolean: mutate(README_LAYERS, "(caller.authInfo?.scopes ?? []).includes(`tool:${name}`)", "(caller.authInfo?.scopes ?? []).join(',')"),
    // `principal` is undefined when identify answered nobody; a rule must say what happens then.
    principalMayBeAbsent: mutate(CALLBACKS, 'principal?.kind', 'principal.kind'),
    // `runsAs` is the engine's caller: only a user carries an id.
    runsAsNarrowsForId: mutate(CALLBACKS, "info.runsAs.kind !== 'unknown'", 'info.runsAs.id !== undefined'),
    rateObjectNeedsWindow: mutate(README_LAYERS, 'rateLimit: { maxCalls: 100, windowMs: 60_000 }', 'rateLimit: { maxCalls: 100 }'),
    identifyReturnsKindless: mutate(README_LAYERS, "{ kind: 'subject', id: 'acme-ltd', roles: [] }", "{ id: 'acme-ltd', roles: [] }"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('the README tenant snippet compiles', () => {
    expect(d.readmeTenant).toEqual([]);
  });
  it('the README provider snippet compiles', () => {
    expect(d.readmeProvider).toEqual([]);
  });
  it('the README five-layer snippet compiles', () => {
    expect(d.readmeLayers).toEqual([]);
  });
  it('the README shared rate-limit recipe compiles', () => {
    expect(d.readmeSharedRate).toEqual([]);
  });
  it('the hooks get { name, caller, principal, runsAs } and identify is Identify; nothing is any', () => {
    expect(d.callbacks).toEqual([]);
  });
  it('the replaced `identity` option does not compile, and the compiler points at identify (TS2561)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.removedIdentity).toEqual(only(2561, "'identity' does not exist in type 'McpServerOptions'. Did you mean to write 'identify'?"));
  });
  it('tools is required (TS2345)', () => {
    expect(d.readmeProvider).toEqual([]);
    expect(d.toolsRequired).toEqual(only(2345, "Property 'tools' is missing"));
  });
  it('the hooks are not handed 0.6 `identity` (TS2339)', () => {
    expect(d.readmeLayers).toEqual([]);
    expect(d.hookHasNoIdentity).toEqual(only(2339, "Property 'identity' does not exist on type 'McpToolRequestInfo'"));
  });
  it('allowTool answers a boolean (TS2322)', () => {
    expect(d.readmeLayers).toEqual([]);
    expect(d.allowToolReturnsBoolean).toEqual(only(2322, "Type 'string' is not assignable to type 'boolean | Promise<boolean>'"));
  });
  it('principal may be absent (TS18048)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.principalMayBeAbsent).toEqual(only(18048, "'principal' is possibly 'undefined'"));
  });
  it('runsAs has an id only once narrowed to a user (TS2339)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.runsAsNarrowsForId).toEqual(only(2339, "Property 'id' does not exist"));
  });
  it('the object form of rateLimit needs both maxCalls and windowMs (TS2322)', () => {
    expect(d.readmeLayers).toEqual([]);
    expect(d.rateObjectNeedsWindow).toEqual(only(2322, 'windowMs'));
  });
  it('identify returning a principal without kind is refused (TS2322)', () => {
    expect(d.readmeLayers).toEqual([]);
    expect(d.identifyReturnsKindless).toEqual(only(2322, "Property 'kind' is missing"));
  });
});
