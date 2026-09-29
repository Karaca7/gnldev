// `createChatRoute`'s identity options, as a user of the package writes them: `identify` (the
// application's one answer to "who is calling", @gnldev/auth `Identify`), `onDecision` (where the
// outcome of each request is reported), and the options 0.7 removed (`identity`, `resolveResourceId`).
// The route throws at construction when handed a removed option, but only a JavaScript caller or a
// cast reaches that throw; for a TypeScript user the contract is that the option does not COMPILE.
// If `CreateChatRouteOptions` ever gained an index signature or went `any`, a 0.6 config would compile
// again and the first sign would be a runtime TypeError — or, for a caller that cast, nothing.
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

// README "Chat route (standalone)": a session lookup as `identify`, mounted on a Hono app.
const README_SESSION = `
import { createChatRoute } from '@gnldev/chat-adapter';
import type { Principal } from '@gnldev/auth';
import type { Hono } from 'hono';
import type { createGnl } from '@gnldev/durable';
declare const app: Hono;
declare const gnl: ReturnType<typeof createGnl>;

// Your session lookup: who this request is, as YOUR server established it.
declare function userOf(req: Request): Promise<string | undefined>;

app.route('/api', createChatRoute({ gnl }, {
  identify: async (req): Promise<Principal | undefined> => {
    const id = await userOf(req);
    return id ? { kind: 'subject', id, roles: [] } : undefined;
  },
}));
`;

// README "Who is calling?" and "Recording who asked": an AuthProvider as `identify`, its hook as `onDecision`.
const README_PROVIDER = `
import { createChatRoute } from '@gnldev/chat-adapter';
import { roleAuth } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';
declare const config: CreateGnlConfig;

const auth = roleAuth({ endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' } })!;

const chat = createChatRoute(config, {
  identify: (req) => auth.authenticate(req),
  onDecision: (d) => auth.onDecision?.(d), // @gnldev/auth-ee's provider writes its audit trail here
});
export { chat };
`;

// What the callbacks receive and must return, and that the options are the shared contract.
const CALLBACKS = `
import { createChatRoute, type CreateChatRouteOptions } from '@gnldev/chat-adapter';
import type { Identify, AccessDecision, Principal, PrincipalKind } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';
${HELPERS}
declare const config: CreateGnlConfig;
declare function log(line: string): void;

// Options are optional as a whole, and \`identify: () => undefined\` is the explicit opt-out.
const bare = createChatRoute(config);
const optOut = createChatRoute(config, { identify: () => undefined });
const route = createChatRoute(config, {
  identify: (req) => {
    const header: string | null = req.headers.get('authorization');
    return header ? { kind: 'operator', roles: ['admin'], orgId: 'acme' } : null;
  },
  onDecision: (d) => {
    const kind: PrincipalKind | 'unnamed' = d.kind;
    const who: Principal | null = d.principal;
    const allowed: boolean = d.allowed;
    const status: number = d.status;
    log(\`\${kind} \${who?.id ?? '-'} \${allowed} \${status}\`);
  },
});
// The door takes the SAME function every door takes, and reports the same record the server does.
const sameIdentify: Same<CreateChatRouteOptions['identify'], Identify | undefined> = true;
const sameDecision: Same<Parameters<NonNullable<CreateChatRouteOptions['onDecision']>>[0], AccessDecision> = true;
const notAny1: IsAny<CreateChatRouteOptions> = false;
const notAny2: IsAny<CreateChatRouteOptions['identify']> = false;
const notAny3: IsAny<Parameters<NonNullable<CreateChatRouteOptions['identify']>>[0]> = false;
const notAny4: IsAny<Parameters<NonNullable<CreateChatRouteOptions['onDecision']>>[0]> = false;
const notAny5: IsAny<ReturnType<typeof createChatRoute>> = false;
// Same<> alone cannot see an any return (a function returning any is assignable both ways), so ask directly.
const notAny6: IsAny<ReturnType<NonNullable<CreateChatRouteOptions['identify']>>> = false;
export { bare, optOut, route, sameIdentify, sameDecision, notAny1, notAny2, notAny3, notAny4, notAny5, notAny6 };
`;

describe('createChatRoute: identity options', () => {
  const cases = {
    readmeSession: README_SESSION,
    readmeProvider: README_PROVIDER,
    callbacks: CALLBACKS,
    // 0.6's hook, removed in 0.7. It must not compile, even though the route also throws on it.
    removedIdentity: mutate(CALLBACKS, '{ identify: () => undefined }', "{ identity: () => ({ resourceId: 'u-1', orgId: 'acme' }) }"),
    removedResolveResourceId: mutate(CALLBACKS, '{ identify: () => undefined }', "{ resolveResourceId: () => 'u-1' }"),
    // A bare user id is not a principal: the route could not tell a user from staff.
    identifyReturnsId: mutate(CALLBACKS, '{ identify: () => undefined }', "{ identify: () => 'u-1' }"),
    identifyReturnsKindless: mutate(README_SESSION, "return id ? { kind: 'subject', id, roles: [] } : undefined;", 'return id ? { id, roles: [] } : undefined;'),
    // It is handed the web Request, not the Hono context (a host bridging from Express has no context).
    identifyTakesContext: mutate(CALLBACKS, '{ identify: () => undefined }', '{ identify: (c: { req: { raw: Request } }) => undefined }'),
    decisionIsARecord: mutate(CALLBACKS, 'const status: number = d.status;', 'const status: number = d.identity;'),
    decisionKindIsNotAString: mutate(CALLBACKS, "const kind: PrincipalKind | 'unnamed' = d.kind;", "const kind: 'subject' = d.kind;"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('the README session snippet compiles', () => {
    expect(d.readmeSession).toEqual([]);
  });
  it('the README provider snippet (identify + onDecision) compiles', () => {
    expect(d.readmeProvider).toEqual([]);
  });
  it('identify is @gnldev/auth Identify, onDecision gets an AccessDecision; nothing is any', () => {
    expect(d.callbacks).toEqual([]);
  });
  it('the removed `identity` option does not compile, and the compiler points at identify (TS2561)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.removedIdentity).toEqual(only(2561, "'identity' does not exist in type 'CreateChatRouteOptions'. Did you mean to write 'identify'?"));
  });
  it('the removed `resolveResourceId` option does not compile (TS2353)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.removedResolveResourceId).toEqual(only(2353, "'resolveResourceId' does not exist"));
  });
  it('identify returning a bare id is refused (TS2322)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.identifyReturnsId).toEqual(only(2322, "Type 'string' is not assignable"));
  });
  it('identify returning a principal without kind is refused (TS2741)', () => {
    expect(d.readmeSession).toEqual([]);
    expect(d.identifyReturnsKindless).toEqual(only(2741, "Property 'kind' is missing"));
  });
  it('identify of a framework context is refused (TS2322)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.identifyTakesContext).toEqual(only(2322, "Property 'req' is missing in type 'Request'"));
  });
  it('onDecision reads only what an AccessDecision has (TS2339)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.decisionIsARecord).toEqual(only(2339, "Property 'identity' does not exist"));
  });
  it("onDecision's kind is the caller-kind union, not one member (TS2322)", () => {
    expect(d.callbacks).toEqual([]);
    expect(d.decisionKindIsNotAString).toEqual(only(2322, 'is not assignable to type \'"subject"\''));
  });
});
