// `createAguiRoute`'s identity options, as a user of the package writes them: `identify` (the
// application's one answer to "who is calling", @gnldev/auth `Identify`), `onDecision` (where the
// outcome of each request is reported), and the options 0.7 removed (`identity`, `resolveResourceId`).
// The route throws at construction when handed a removed option, but only a JavaScript caller or a
// cast reaches that throw; for a TypeScript user the contract is that the option does not COMPILE.
// If `CreateAguiRouteOptions` ever gained an index signature or went `any`, a 0.6 config would compile
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

// README quickstart: the explicit opt-out, served as a fetch handler. (`serve` from @hono/node-server
// is replaced by the one thing it reads, `app.fetch`: that package is not a dependency of this one.)
const README_QUICKSTART = `
import { createAguiRoute } from '@gnldev/agui';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { AgentConfig } from '@gnldev/durable';
declare const tools: NonNullable<AgentConfig['tools']>;
declare const guard: NonNullable<AgentConfig['guard']>;

const app = createAguiRoute({
  journal: new SqliteStorage('runs.db').runs,
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
}, {
  // Who is calling. In production the route refuses to start without this: pass your auth
  // (see "identify" below), or say explicitly that there is no per-user identity.
  // With end users, prefer \`aguiSurface()\` on createRestApi: the API's auth decides it for you.
  identify: () => undefined,
});
const fetch: (request: Request) => Promise<Response> = app.fetch;
export { fetch };
`;

// README "Who is calling?": an AuthProvider as `identify`.
const README_PROVIDER = `
import { createAguiRoute } from '@gnldev/agui';
import { roleAuth } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';
declare const config: CreateGnlConfig;

const auth = roleAuth({ endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' } })!;

const route = createAguiRoute(config, {
  identify: (req) => auth.authenticate(req), // an end user's signed token → that user, in acme
  onDecision: (d) => auth.onDecision?.(d),
});
export { route };
`;

// What the callbacks receive and must return, and that the options are the shared contract.
const CALLBACKS = `
import { createAguiRoute, type CreateAguiRouteOptions } from '@gnldev/agui';
import type { Identify, AccessDecision, Principal, PrincipalKind } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';
${HELPERS}
declare const config: CreateGnlConfig;
declare function log(line: string): void;

// Options are optional as a whole; the opt-out is an explicit function answering nobody.
const bare = createAguiRoute(config);
const optOut = createAguiRoute(config, { identify: () => undefined });
const route = createAguiRoute(config, {
  identify: async (req) => {
    const header: string | null = req.headers.get('authorization');
    return header ? { kind: 'application', id: 'backend', roles: ['client'], orgId: 'acme' } : null;
  },
  onDecision: async (d) => {
    const kind: PrincipalKind | 'unnamed' = d.kind;
    const who: Principal | null = d.principal;
    const allowed: boolean = d.allowed;
    const status: number = d.status;
    log(\`\${kind} \${who?.id ?? '-'} \${allowed} \${status}\`);
  },
});
// The door takes the SAME function every door takes, and reports the same record the server does.
const sameIdentify: Same<CreateAguiRouteOptions['identify'], Identify | undefined> = true;
const sameDecision: Same<Parameters<NonNullable<CreateAguiRouteOptions['onDecision']>>[0], AccessDecision> = true;
const notAny1: IsAny<CreateAguiRouteOptions> = false;
const notAny2: IsAny<CreateAguiRouteOptions['identify']> = false;
const notAny3: IsAny<Parameters<NonNullable<CreateAguiRouteOptions['identify']>>[0]> = false;
const notAny4: IsAny<Parameters<NonNullable<CreateAguiRouteOptions['onDecision']>>[0]> = false;
const notAny5: IsAny<ReturnType<typeof createAguiRoute>> = false;
// Same<> alone cannot see an any return (a function returning any is assignable both ways), so ask directly.
const notAny6: IsAny<ReturnType<NonNullable<CreateAguiRouteOptions['identify']>>> = false;
export { bare, optOut, route, sameIdentify, sameDecision, notAny1, notAny2, notAny3, notAny4, notAny5, notAny6 };
`;

describe('createAguiRoute: identity options', () => {
  const cases = {
    readmeQuickstart: README_QUICKSTART,
    readmeProvider: README_PROVIDER,
    callbacks: CALLBACKS,
    // 0.6's hook, removed in 0.7. It must not compile, even though the route also throws on it.
    removedIdentity: mutate(CALLBACKS, '{ identify: () => undefined }', "{ identity: () => ({ resourceId: 'u-1', orgId: 'acme' }) }"),
    removedResolveResourceId: mutate(CALLBACKS, '{ identify: () => undefined }', "{ resolveResourceId: () => 'u-1' }"),
    // A bare user id is not a principal: the route could not tell a user from staff.
    identifyReturnsId: mutate(CALLBACKS, '{ identify: () => undefined }', "{ identify: () => 'u-1' }"),
    identifyReturnsKindless: mutate(CALLBACKS, "{ kind: 'application', id: 'backend',", "{ id: 'backend',"),
    // It is handed the web Request, not the Hono context (a host bridging from Express has no context).
    identifyTakesContext: mutate(CALLBACKS, '{ identify: () => undefined }', '{ identify: (c: { req: { raw: Request } }) => undefined }'),
    decisionIsARecord: mutate(CALLBACKS, 'const status: number = d.status;', 'const status: number = d.identity;'),
    // Unlike the chat route, this one takes a config only: a prebuilt \`{ gnl }\` cannot be split by organization.
    configOnly: mutate(README_QUICKSTART, 'journal: new SqliteStorage', 'gnl: new SqliteStorage'),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('the README quickstart (explicit opt-out) compiles', () => {
    expect(d.readmeQuickstart).toEqual([]);
  });
  it('the README provider snippet compiles', () => {
    expect(d.readmeProvider).toEqual([]);
  });
  it('identify is @gnldev/auth Identify, onDecision gets an AccessDecision; nothing is any', () => {
    expect(d.callbacks).toEqual([]);
  });
  it('the removed `identity` option does not compile, and the compiler points at identify (TS2561)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.removedIdentity).toEqual(only(2561, "'identity' does not exist in type 'CreateAguiRouteOptions'. Did you mean to write 'identify'?"));
  });
  it('the removed `resolveResourceId` option does not compile (TS2353)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.removedResolveResourceId).toEqual(only(2353, "'resolveResourceId' does not exist"));
  });
  it('identify returning a bare id is refused (TS2322)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.identifyReturnsId).toEqual(only(2322, "Type 'string' is not assignable"));
  });
  it('identify returning a principal without kind is refused (TS2322)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.identifyReturnsKindless).toEqual(only(2322, "Property 'kind' is missing"));
  });
  it('identify of a framework context is refused (TS2322)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.identifyTakesContext).toEqual(only(2322, "Property 'req' is missing in type 'Request'"));
  });
  it('onDecision reads only what an AccessDecision has (TS2339)', () => {
    expect(d.callbacks).toEqual([]);
    expect(d.decisionIsARecord).toEqual(only(2339, "Property 'identity' does not exist"));
  });
  it('the route takes a config, not a prebuilt instance (TS2353)', () => {
    expect(d.readmeQuickstart).toEqual([]);
    expect(d.configOnly).toEqual(only(2353, "'gnl' does not exist in type 'CreateGnlConfig'"));
  });
});
