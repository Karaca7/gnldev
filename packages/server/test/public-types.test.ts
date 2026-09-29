// The public type contract of @gnldev/server, as a USER's code meets it: `createRestApi(config, opts)`
// and its options (`auth`, `org`, `surfaces`, `cors`, ...), and the `AuthProvider` a user writes for
// `auth` — including `onDecision` and the decision it receives, whose `reason` is a CLOSED union a
// user switches over exhaustively.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` or
// `// @ts-expect-error` here would pass at runtime whatever the types said. Each snippet is compiled
// against the published declarations (dist), resolved from this package's own dependencies exactly as
// a user's code would be.
//
// Every negative case is its baseline with ONE mutation, and asserts the SPECIFIC error code it must
// produce. A count-only negative passes for the wrong reason: a typo'd import is an error too (TS2305).
// A contract that loosens — an option turned `any`, a reason union opened with a string fallback —
// makes the baseline still compile and the negative stop failing, and that is what turns this red.
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** Replace `from` (which must occur exactly once, so the mutation is exactly one) with `to`. */

interface Negative { name: string; from: string; to: string; codes: number[] }

/**
 * Compile the baseline, every negative and the not-`any` checks in ONE program; return the diagnostics
 * per case. The not-`any` checks are their own snippet, not part of the baseline, so a type that turns
 * `any` fails the check that names it instead of every negative derived from the baseline.
 */
function compileBlock(base: string, negatives: Negative[], notAny?: string): Record<string, TypeDiagnostic[]> {
  const snippets: Record<string, string> = { baseline: base };
  if (notAny !== undefined) snippets.notAny = notAny;
  negatives.forEach((n, i) => { snippets[`neg${i}`] = mutate(base, n.from, n.to); });
  const out = typeDiagnostics(__dirname, snippets);
  return Object.fromEntries([['baseline', out.baseline], ['notAny', out.notAny], ...negatives.map((n, i) => [n.name, out[`neg${i}`]])]);
}

const codesOf = (d: TypeDiagnostic[] | undefined) => (d ?? []).map((x) => x.code).sort((a, b) => a - b);

const IS_ANY = `
type IsAny<T> = 0 extends 1 & T ? true : false;
type AnyKeys<T> = { [K in keyof T]-?: IsAny<T[K]> extends true ? K : never }[keyof T];
`;

// ---------------------------------------------------------------------------------------------------
// createRestApi options
// ---------------------------------------------------------------------------------------------------

const OPTIONS = `
import { createRestApi, type OrgOptions } from '@gnldev/server';
import type { CreateGnlConfig } from '@gnldev/durable';

declare const config: CreateGnlConfig;

// packages/server/README.md, "Other wire formats and browsers": the canonical cors usage.
export const api = createRestApi(config, { cors: { origins: ['https://app.example.com'], maxAge: 600 } });

// \`opts\` is optional; \`config\` is not.
export const bare = createRestApi(config);

const org: OrgOptions = {
  resolve: (req) => req.headers.get('x-tenant') ?? undefined,
  required: true,
  requireRegistration: true,
  maxInstances: 64,
};

export const full = createRestApi(config, {
  title: 'Support API',
  auth: { read: () => true, write: (req) => req.headers.get('x-admin') === 'yes' },
  allowOpenAccess: false,
  org,
  budgets: { default: { usdLimit: 10 }, perOrg: { acme: { tokenLimit: 1000 } } },
  limits: {},
  a2aSecret: 'shared-secret',
  resourceAuth: (principal, resource, action) => principal !== null && (resource.type !== 'tool' || action === 'run'),
  requireAgentApproval: true,
  protectionsBanner: false,
  cors: { origins: '*' },
});

// Every OrgOptions field is optional: an empty object reads the x-gnl-org header.
export const headerOrg = createRestApi(config, { org: {} });

// The handler is callable and carries .fetch.
export const res: Promise<Response> = api.fetch(new Request('http://x/agents'));
export const res2: Promise<Response> = api(new Request('http://x/agents'));
`;

const OPTIONS_NOT_ANY = `
import { createRestApi, type RestApiOptions, type OrgOptions, type StreamSurface } from '@gnldev/server';
${IS_ANY}
export const optionsNotAny: IsAny<RestApiOptions> = false;
export const noOptionIsAny: [AnyKeys<RestApiOptions>] extends [never] ? true : false = true;
export const orgNotAny: IsAny<NonNullable<RestApiOptions['org']>> = false;
export const noOrgFieldIsAny: [AnyKeys<OrgOptions>] extends [never] ? true : false = true;
export const surfaceNotAny: IsAny<StreamSurface> = false;
export const configParamNotAny: IsAny<Parameters<typeof createRestApi>[0]> = false;
export const optsParamNotAny: IsAny<Parameters<typeof createRestApi>[1]> = false;
export const returnNotAny: IsAny<ReturnType<typeof createRestApi>> = false;
`;

const OPTIONS_NEGATIVES: Negative[] = [
  { name: 'a misspelled top-level option is rejected', from: 'protectionsBanner: false', to: 'protectionBanner: false', codes: [2561] },
  { name: 'an unknown top-level option is rejected', from: "title: 'Support API',", to: "title: 'Support API', verbose: true,", codes: [2353] },
  { name: 'a misspelled org option is rejected', from: 'required: true,', to: 'requried: true,', codes: [2561] },
  { name: 'org.resolve must return a string or undefined', from: "req.headers.get('x-tenant') ?? undefined", to: "req.headers.get('x-tenant') ?? 0", codes: [2322] },
  { name: 'org.maxInstances is a number', from: 'maxInstances: 64', to: "maxInstances: '64'", codes: [2322] },
  { name: 'org is an object, not a flag', from: 'createRestApi(config, { org: {} })', to: 'createRestApi(config, { org: true })', codes: [2559] },
  { name: 'cors.origins is required', from: "cors: { origins: '*' }", to: 'cors: { maxAge: 1 }', codes: [2741] },
  { name: "cors.origins is a list or '*', no other string", from: "cors: { origins: '*' }", to: "cors: { origins: 'all' }", codes: [2322] },
  { name: 'an unknown key in the {read, write} auth pair is rejected', from: 'auth: { read: () => true,', to: 'auth: { raed: () => true,', codes: [2353] },
  { name: 'budgets carry usdLimit/tokenLimit, nothing else', from: 'default: { usdLimit: 10 }', to: 'default: { usd: 10 }', codes: [2353] },
  { name: 'resourceAuth answers a boolean', from: "principal !== null && (resource.type !== 'tool' || action === 'run')", to: "'yes'", codes: [2322] },
  { name: 'resourceAuth resource types are a closed union', from: "resource.type !== 'tool'", to: "resource.type !== 'toolz'", codes: [2367] },
  { name: 'config is required', from: 'export const bare = createRestApi(config);', to: 'export const bare = createRestApi();', codes: [2554] },
  { name: 'config refuses a single `agent` (the registry form only)', from: 'export const bare = createRestApi(config);', to: 'export const bare = createRestApi({ ...config, agent: {} });', codes: [2322] },
];

describe('@gnldev/server public types: createRestApi options', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => { d = compileBlock(OPTIONS, OPTIONS_NEGATIVES, OPTIONS_NOT_ANY); }, 60_000);

  it('the documented and the full option set compile clean', () => {
    expect(d.baseline).toEqual([]);
  });
  it('no option, org field, surface, parameter or return type is any', () => {
    expect(d.notAny).toEqual([]);
  });
  it.each(OPTIONS_NEGATIVES)('$name', (n) => {
    expect(codesOf(d[n.name]), JSON.stringify(d[n.name])).toEqual(n.codes);
  });
});

// ---------------------------------------------------------------------------------------------------
// The AuthProvider a user implements, onDecision and the decision it receives
// ---------------------------------------------------------------------------------------------------

const AUTH = `
import { createRestApi } from '@gnldev/server';
import type { AuthProvider, AccessDecision, RefusalReason, Principal } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';

declare const config: CreateGnlConfig;

// A user's audit sink switches over every refusal reason; \`never\` proves the switch is exhaustive,
// so a reason added to (or a string fallback opened in) the union breaks this code, as it should.
function explain(reason: RefusalReason): string {
  switch (reason) {
    case 'unauthenticated': return 'no usable identity';
    case 'rbac': return 'role or permission';
    case 'ownership': return 'someone else owns it';
    case 'organization': return 'organization scope';
    case 'resource': return 'resource-level check';
    case 'policy': return 'another host rule';
    default: { const unreachable: never = reason; return unreachable; }
  }
}

export const recorded: AccessDecision[] = [];

const auth: AuthProvider = {
  authenticate: (req): Principal | null => (req.headers.get('authorization') ? { kind: 'subject', id: 'u-1', roles: ['member'] } : null),
  authorize: (principal, _req, ctx) => (principal ? { allow: true } : { allow: false, status: 401, reason: 'no principal for ' + ctx.action }),
  onDecision(decision) {
    const allowed: boolean = decision.allowed;
    const status: number = decision.status;
    const kind: 'operator' | 'application' | 'subject' | 'unnamed' = decision.kind;
    const action: 'read' | 'write' = decision.action;
    if (!allowed && decision.reason !== undefined) explain(decision.reason);
    recorded.push({ ...decision, detail: [status, kind, action].join(' ') });
  },
};

export const api = createRestApi(config, { auth });

// An async onDecision is accepted too (an audit write).
export const asyncAuth = createRestApi(config, { auth: { ...auth, onDecision: async (d: AccessDecision) => { await Promise.resolve(d.allowed); } } });
`;

const AUTH_NOT_ANY = `
import type { AuthProvider, AccessDecision, RefusalReason } from '@gnldev/auth';
${IS_ANY}
export const noDecisionFieldIsAny: [AnyKeys<AccessDecision>] extends [never] ? true : false = true;
export const noProviderMemberIsAny: [AnyKeys<AuthProvider>] extends [never] ? true : false = true;
export const decisionParamNotAny: IsAny<Parameters<NonNullable<AuthProvider['onDecision']>>[0]> = false;
export const reasonNotAny: IsAny<RefusalReason> = false;
export const reasonIsExactlySix: [RefusalReason] extends ['unauthenticated' | 'rbac' | 'ownership' | 'organization' | 'resource' | 'policy'] ? true : false = true;
`;

const AUTH_NEGATIVES: Negative[] = [
  { name: 'a reason outside the union is not a case', from: "case 'policy': return 'another host rule';", to: "case 'policy': return 'another host rule';\n    case 'expired': return 'x';", codes: [2678] },
  { name: 'dropping a reason breaks the exhaustive switch', from: "case 'policy': return 'another host rule';", to: '', codes: [2322] },
  { name: "decision.kind includes 'unnamed' (a narrower annotation is rejected)", from: "'subject' | 'unnamed' = decision.kind", to: "'subject' = decision.kind", codes: [2322] },
  { name: 'decision.allowed is a boolean, not a string', from: 'const allowed: boolean = decision.allowed;', to: 'const allowed: string = decision.allowed;', codes: [2322] },
  { name: 'decision.status is a number', from: 'const status: number = decision.status;', to: 'const status: string = decision.status;', codes: [2322] },
  { name: 'a principal must carry its kind', from: "{ kind: 'subject', id: 'u-1', roles: ['member'] }", to: "{ id: 'u-1', roles: ['member'] }", codes: [2741] },
  { name: 'a principal kind is a closed union', from: "kind: 'subject', id: 'u-1'", to: "kind: 'user', id: 'u-1'", codes: [2322] },
  { name: 'a denial status is 401 or 403', from: 'status: 401', to: 'status: 500', codes: [2322] },
  { name: 'authorize is required', from: "  authorize: (principal, _req, ctx) => (principal ? { allow: true } : { allow: false, status: 401, reason: 'no principal for ' + ctx.action }),\n", to: '', codes: [2741] },
  { name: 'onDecision takes the decision, not a narrower shape', from: 'onDecision: async (d: AccessDecision)', to: 'onDecision: async (d: { allowed: string })', codes: [2322] },
];

describe('@gnldev/server public types: AuthProvider and onDecision', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => { d = compileBlock(AUTH, AUTH_NEGATIVES, AUTH_NOT_ANY); }, 60_000);

  it('a provider with onDecision and an exhaustive reason switch compiles clean', () => {
    expect(d.baseline).toEqual([]);
  });
  it('no decision field or provider member is any, and the reason union is exactly the six', () => {
    expect(d.notAny).toEqual([]);
  });
  it.each(AUTH_NEGATIVES)('$name', (n) => {
    expect(codesOf(d[n.name]), JSON.stringify(d[n.name])).toEqual(n.codes);
  });
});

// ---------------------------------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------------------------------

// chatSurface is imported from the sibling package's dist: @gnldev/server does not depend on
// @gnldev/chat-adapter (ADR-0002: a door package stands alone), and the runtime test
// (chat-surface.test.ts) reaches it the same way. The local `echo` surface holds the contract itself.
const SURFACES = `
import { createRestApi, type StreamSurface, type StreamSurfaceInput } from '@gnldev/server';
import type { CreateGnlConfig } from '@gnldev/durable';
import { chatSurface } from '../../chat-adapter/dist/index.js';

declare const config: CreateGnlConfig;

const echo: StreamSurface = {
  path: '/agents/:name/echo',
  decode: (body: { text: string }): StreamSurfaceInput => ({ prompt: body.text, turnKey: 't-1' }),
  encode: (_result, meta) => Response.json({ runId: meta.runId, thread: meta.threadId ?? null }),
};

export const api = createRestApi(config, { surfaces: [chatSurface(), echo] });
`;

const SURFACES_NEGATIVES: Negative[] = [
  { name: 'a surface must encode', from: "  encode: (_result, meta) => Response.json({ runId: meta.runId, thread: meta.threadId ?? null }),\n", to: '', codes: [2741] },
  { name: 'decode yields the stream input shape (prompt is a string)', from: 'prompt: body.text', to: 'prompt: 42', codes: [2322] },
  { name: 'decode may not invent input fields', from: "turnKey: 't-1'", to: "turnKey: 't-1', owner: 'u-1'", codes: [2353] },
  { name: 'encode meta has runId, not a guessed name', from: 'runId: meta.runId,', to: 'runId: meta.runID,', codes: [2551] },
  { name: 'surfaces are surface objects, not names', from: 'surfaces: [chatSurface(), echo]', to: "surfaces: [chatSurface(), 'echo']", codes: [2322] },
];

describe('@gnldev/server public types: surfaces', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => { d = compileBlock(SURFACES, SURFACES_NEGATIVES); }, 60_000);

  it('chatSurface() and a hand-written surface compile clean', () => {
    expect(d.baseline).toEqual([]);
  });
  it.each(SURFACES_NEGATIVES)('$name', (n) => {
    expect(codesOf(d[n.name]), JSON.stringify(d[n.name])).toEqual(n.codes);
  });
});
