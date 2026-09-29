// The public type contract of @gnldev/studio, as a USER's code meets it: `createStudioApi` in both of
// its input forms (a bare `JournalReader`, or `StudioApiOptions`), the `users` store a host plugs in,
// `userErasure: { storage, erasers?, memory?, settleMs? }` behind `DELETE /users/:id`, and the `auth`
// provider — which must stay the SAME `AuthProvider` @gnldev/auth defines, so one provider (with its
// `onDecision` audit hook) serves the server and Studio alike.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` or
// `// @ts-expect-error` here would pass at runtime whatever the types said. Each snippet is compiled
// against the published declarations (dist), resolved from this package's own dependencies exactly as
// a user's code would be.
//
// Every negative case is its baseline with ONE mutation, and asserts the SPECIFIC error code it must
// produce. A count-only negative passes for the wrong reason: a typo'd import is an error too (TS2305).
// A contract that loosens — `userErasure.storage` made optional, an option turned `any` — makes the
// baseline still compile and the negative stop failing, and that is what turns this red.
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

const IS_ANY = `
type IsAny<T> = 0 extends 1 & T ? true : false;
type AnyKeys<T> = { [K in keyof T]-?: IsAny<T[K]> extends true ? K : never }[keyof T];
`;

const codesOf = (d: TypeDiagnostic[] | undefined) => (d ?? []).map((x) => x.code).sort((a, b) => a - b);

// ---------------------------------------------------------------------------------------------------
// createStudioApi: both input forms, users, userErasure
// ---------------------------------------------------------------------------------------------------

// The README's user-deletion snippet imports `jobEraser` from @gnldev/queue and `createJournalUserStore`
// from the paid @gnldev/auth-ee; neither is a dependency studio's users resolve through, so both are
// declared here with the shapes those packages export. The createStudioApi line is the README's own.
const API = `
import { createStudioApi, type StudioApiOptions, type StudioUserStore, type StudioUser } from '@gnldev/studio';
import { toJournal, type Storage, type SubjectEraser } from '@gnldev/durable';

declare const storage: Storage;
declare const memoryStorage: Storage;
declare function jobEraser(storage: Storage): SubjectEraser;
declare const users: StudioUserStore;

// packages/studio/README.md, "Deleting a user" — with the reader built by \`toJournal\`, as every
// shipped host builds it: a storage's raw \`runs\` pages its run list, a JournalReader does not.
createStudioApi({ reader: toJournal(storage.runs), users, userErasure: { storage, erasers: [jobEraser(storage)] } });

const reader = toJournal(storage.runs);

// A bare JournalReader is shorthand for { reader }.
export const bare = createStudioApi(reader);
export const minimal = createStudioApi({ reader });

// A host's own eraser, and every userErasure field.
const crmEraser: SubjectEraser = {
  name: 'crm',
  erase: async (owner) => (owner.orgId === undefined ? 1 : 2) + owner.resourceId.length * 0,
};
const fullErasure: StudioApiOptions['userErasure'] = {
  storage,
  erasers: [jobEraser(storage), crmEraser],
  memory: memoryStorage,
  settleMs: 5_000,
};

// A hand-written user store: list/create/remove are the contract, revoke/update are optional.
const myUsers: StudioUserStore = {
  list: (): StudioUser[] => [{ id: 'u-1', roles: ['member'], kind: 'subject' }],
  create: async (input) => ({ user: { id: 'u-2', roles: input.roles ?? [], orgId: input.orgId }, token: 't' }),
  remove: async (_id) => {},
};

export const full = createStudioApi({
  reader,
  users: myUsers,
  userErasure: fullErasure,
  org: { resolve: (req) => req.headers.get('x-gnl-org') ?? undefined },
  allowOpenAccess: false,
  retention: { olderThanMs: 86_400_000, keepSuspended: true },
});

export const res: Promise<Response> = bare.fetch(new Request('http://x/runs'));
`;

const API_NOT_ANY = `
import { createStudioApi, type StudioApiOptions, type StudioUserStore } from '@gnldev/studio';
${IS_ANY}
export const optionsNotAny: IsAny<StudioApiOptions> = false;
export const noOptionIsAny: [AnyKeys<StudioApiOptions>] extends [never] ? true : false = true;
export const erasureNotAny: IsAny<NonNullable<StudioApiOptions['userErasure']>> = false;
export const noErasureFieldIsAny: [AnyKeys<NonNullable<StudioApiOptions['userErasure']>>] extends [never] ? true : false = true;
export const usersNotAny: IsAny<NonNullable<StudioApiOptions['users']>> = false;
export const noUserStoreMemberIsAny: [AnyKeys<StudioUserStore>] extends [never] ? true : false = true;
export const inputNotAny: IsAny<Parameters<typeof createStudioApi>[0]> = false;
export const returnNotAny: IsAny<ReturnType<typeof createStudioApi>> = false;
`;

const API_NEGATIVES: Negative[] = [
  { name: 'userErasure.storage is required', from: 'userErasure: { storage, erasers: [jobEraser(storage)] }', to: 'userErasure: { erasers: [jobEraser(storage)] }', codes: [2741] },
  { name: 'userErasure.storage is a Storage, not a run journal', from: 'userErasure: { storage, erasers', to: 'userErasure: { storage: storage.runs, erasers', codes: [2739] },
  { name: 'a misspelled userErasure field is rejected', from: 'memory: memoryStorage,', to: 'memroy: memoryStorage,', codes: [2561] },
  { name: 'userErasure.settleMs is a number', from: 'settleMs: 5_000,', to: "settleMs: '5s',", codes: [2322] },
  { name: 'an eraser must be named', from: "  name: 'crm',\n", to: '', codes: [2741] },
  { name: 'an eraser reports a count', from: '(owner.orgId === undefined ? 1 : 2) + owner.resourceId.length * 0', to: "'erased'", codes: [2322] },
  { name: 'a user store must remove', from: '  remove: async (_id) => {},\n', to: '', codes: [2741] },
  { name: 'a stored user carries roles', from: "{ id: 'u-1', roles: ['member'], kind: 'subject' }", to: "{ id: 'u-1', kind: 'subject' }", codes: [2741] },
  { name: 'reader is required in the options form', from: 'createStudioApi({ reader });', to: 'createStudioApi({ users });', codes: [2345] },
  { name: "a storage's raw paged run journal is not a JournalReader", from: 'createStudioApi(reader);', to: 'createStudioApi(storage.runs);', codes: [2345] },
  { name: 'a misspelled top-level option is rejected', from: 'allowOpenAccess: false,', to: 'allowOpenAcess: false,', codes: [2353] },
  { name: 'org.resolve takes a web Request, not a framework context', from: "org: { resolve: (req) => req.headers.get('x-gnl-org') ?? undefined }", to: "org: { resolve: (c: { req: { header(n: string): string | undefined } }) => c.req.header('x-gnl-org') }", codes: [2322] },
  { name: 'retention.olderThanMs is required', from: 'retention: { olderThanMs: 86_400_000, keepSuspended: true }', to: 'retention: { keepSuspended: true }', codes: [2741] },
];

describe('@gnldev/studio public types: createStudioApi, users, userErasure', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => { d = compileBlock(API, API_NEGATIVES, API_NOT_ANY); }, 60_000);

  it('both input forms, the README snippet and every userErasure field compile clean', () => {
    expect(d.baseline).toEqual([]);
  });
  it('no option, userErasure field, user-store member, input or return type is any', () => {
    expect(d.notAny).toEqual([]);
  });
  it.each(API_NEGATIVES)('$name', (n) => {
    expect(codesOf(d[n.name]), JSON.stringify(d[n.name])).toEqual(n.codes);
  });
});

// ---------------------------------------------------------------------------------------------------
// auth: the same AuthProvider as @gnldev/auth, onDecision included
// ---------------------------------------------------------------------------------------------------

const AUTH = `
import { createStudioApi, roleAuth, type AuthProvider, type StudioApiOptions } from '@gnldev/studio';
import type { AuthProvider as CoreAuthProvider, AccessDecision, RefusalReason } from '@gnldev/auth';
import { toJournal, type Storage } from '@gnldev/durable';

declare const storage: Storage;
const reader = toJournal(storage.runs);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const sameProvider: Same<AuthProvider, CoreAuthProvider> = true;

export const seen: RefusalReason[] = [];
const provider: AuthProvider = {
  authenticate: () => ({ kind: 'operator', roles: ['admin'] }),
  authorize: () => ({ allow: true }),
  onDecision: (decision: AccessDecision) => { if (decision.reason) seen.push(decision.reason); },
};

export const withProvider = createStudioApi({ reader, auth: provider });
export const withPair = createStudioApi({ reader, auth: { read: () => true, write: async () => false } });
export const withRoles = createStudioApi({ reader, auth: roleAuth({ admin: { token: 'a' } }) });
`;

const AUTH_NOT_ANY = `
import type { AuthProvider, StudioApiOptions } from '@gnldev/studio';
${IS_ANY}
export const authNotAny: IsAny<NonNullable<StudioApiOptions['auth']>> = false;
export const providerNotAny: IsAny<AuthProvider> = false;
`;

const AUTH_NEGATIVES: Negative[] = [
  { name: 'a provider must authorize', from: '  authorize: () => ({ allow: true }),\n', to: '', codes: [2741] },
  { name: 'onDecision reasons are the closed union', from: 'seen.push(decision.reason)', to: "seen.push('expired')", codes: [2345] },
  { name: 'an unknown key in the {read, write} pair is rejected', from: 'auth: { read: () => true,', to: 'auth: { raed: () => true,', codes: [2353] },
  { name: 'the {read, write} pair answers booleans', from: 'write: async () => false', to: "write: async () => 'no'", codes: [2322] },
];

describe('@gnldev/studio public types: auth', () => {
  let d: Record<string, TypeDiagnostic[]>;
  beforeAll(() => { d = compileBlock(AUTH, AUTH_NEGATIVES, AUTH_NOT_ANY); }, 60_000);

  it("studio's AuthProvider is @gnldev/auth's, and all three auth forms compile clean", () => {
    expect(d.baseline).toEqual([]);
  });
  it('neither the auth option nor the provider is any', () => {
    expect(d.notAny).toEqual([]);
  });
  it.each(AUTH_NEGATIVES)('$name', (n) => {
    expect(codesOf(d[n.name]), JSON.stringify(d[n.name])).toEqual(n.codes);
  });
});
