// The identity types every GNL door shares: `Principal` (who the application says is calling),
// `PrincipalKind` (what that caller is), `Identify` (the one function that answers it, handed to the
// REST API, the chat and AG-UI routes and MCP alike) and `engineCallerOf` (the one mapping from a
// principal to the engine's caller). A door is only as closed as these types: if `kind` stopped being
// required, a principal minted without a declaration would compile, and if `Identify` widened to
// `any`, every door's `identify` would accept a function returning anything. Neither shows up at
// runtime until a caller is misread.
//
// Type-level, so it runs the compiler against the published declarations (dist): vitest does not
// type-check test files, and an `expectTypeOf` here would pass whatever the types said. Every negative
// case is a positive one with exactly ONE mutation, and asserts the SPECIFIC error code it produces —
// a typo'd import also fails to compile (TS2305), and a count-only check would pass for that reason.
import { describe, it, expect, beforeAll } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';

/** Applies ONE textual mutation; throws unless `from` occurs exactly once, so a stale mutation fails loudly. */
/** Exactly one diagnostic, with this code, whose message names what the mutation broke. */
const only = (code: number, names: string) => [{ code, message: expect.stringContaining(names) }];

const HELPERS = `
type IsAny<T> = 0 extends 1 & T ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
`;

// ---------------------------------------------------------------------------------------------------
// Principal and PrincipalKind
// ---------------------------------------------------------------------------------------------------
const PRINCIPAL = `
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from '@gnldev/auth';
${HELPERS}
// Each kind, as a host mints it. \`id\`, \`orgId\` and \`permissions\` are optional; \`kind\` and \`roles\` are not.
const user: Principal = { kind: 'subject', id: 'u-1', roles: [], orgId: 'acme' };
const staff: Principal = { kind: 'operator', roles: ['admin'] };
const app: Principal = { kind: 'application', id: 'backend', roles: ['client'], permissions: ['agents:run'] };
// Exactly three kinds: an exhaustive switch needs no default, and a fourth member would break it.
function rank(k: PrincipalKind): number {
  switch (k) {
    case 'operator': return 0;
    case 'application': return 1;
    case 'subject': return 2;
  }
}
const exact: Same<PrincipalKind, 'operator' | 'application' | 'subject'> = true;
const tuple: Same<(typeof PRINCIPAL_KINDS)[number], PrincipalKind> = true;
const kindField: Same<Principal['kind'], PrincipalKind> = true;
const roles: Same<Principal['roles'], string[]> = true;
const id: Same<Principal['id'], string | undefined> = true;
const orgId: Same<Principal['orgId'], string | undefined> = true;
const notAny1: IsAny<Principal> = false;
const notAny2: IsAny<PrincipalKind> = false;
const notAny3: IsAny<Principal['kind']> = false;
const notAny4: IsAny<Principal['roles']> = false;
export { user, staff, app, rank, exact, tuple, kindField, roles, id, orgId, notAny1, notAny2, notAny3, notAny4 };
`;

describe('Principal and PrincipalKind', () => {
  const cases = {
    baseline: PRINCIPAL,
    kindRequired: mutate(PRINCIPAL, "{ kind: 'operator', roles: ['admin'] }", "{ roles: ['admin'] }"),
    rolesRequired: mutate(PRINCIPAL, "{ kind: 'operator', roles: ['admin'] }", "{ kind: 'operator' }"),
    // The engine's word for staff is not a principal's kind; nor is a role name.
    noEngineKind: mutate(PRINCIPAL, "kind: 'operator', roles: ['admin']", "kind: 'staff', roles: ['admin']"),
    noRoleAsKind: mutate(PRINCIPAL, "kind: 'subject', id: 'u-1'", "kind: 'admin', id: 'u-1'"),
    idIsString: mutate(PRINCIPAL, "id: 'u-1'", 'id: 42'),
    orgIdIsString: mutate(PRINCIPAL, "orgId: 'acme' }", 'orgId: 7 }'),
    noFourthKind: mutate(PRINCIPAL, "Same<PrincipalKind, 'operator' | 'application' | 'subject'>", "Same<PrincipalKind, 'operator' | 'application' | 'subject' | 'staff'>"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('the canonical principals of each kind compile, and no field is any', () => {
    expect(d.baseline).toEqual([]);
  });
  it('kind is required (TS2741)', () => {
    expect(d.kindRequired).toEqual(only(2741, "Property 'kind' is missing"));
  });
  it('roles is required (TS2741)', () => {
    expect(d.rolesRequired).toEqual(only(2741, "Property 'roles' is missing"));
  });
  it("'staff' is the engine's word, not a principal kind (TS2322)", () => {
    expect(d.noEngineKind).toEqual(only(2322, `Type '"staff"' is not assignable`));
  });
  it('a role name is not a kind (TS2322)', () => {
    expect(d.noRoleAsKind).toEqual(only(2322, `Type '"admin"' is not assignable`));
  });
  it('id is a string, despite the index signature (TS2322)', () => {
    expect(d.idIsString).toEqual(only(2322, "Type 'number' is not assignable to type 'string'"));
  });
  it('orgId is a string, despite the index signature (TS2322)', () => {
    expect(d.orgIdIsString).toEqual(only(2322, "Type 'number' is not assignable to type 'string'"));
  });
  it('PrincipalKind is exactly three members (TS2322 when a fourth is assumed)', () => {
    expect(d.noFourthKind).toEqual(only(2322, "Type 'true' is not assignable to type 'false'"));
  });
});

// ---------------------------------------------------------------------------------------------------
// Identify
// ---------------------------------------------------------------------------------------------------
const IDENTIFY = `
import type { Identify, Principal, AuthProvider } from '@gnldev/auth';
${HELPERS}
declare function userOf(req: Request): Promise<string | undefined>;
declare const auth: AuthProvider;
// Sync, async, and "nobody": all are answers.
const sync: Identify = (req) => (req.headers.get('authorization') === 'Bearer k' ? { kind: 'subject', id: 'u-1', roles: [] } : undefined);
const nobody: Identify = () => null;
const optOut: Identify = () => undefined;
const fromSession: Identify = async (req): Promise<Principal | undefined> => {
  const id = await userOf(req);
  return id ? { kind: 'subject', id, roles: [] } : undefined;
};
// An AuthProvider's authenticate IS one, as it is.
const fromProvider: Identify = (req) => auth.authenticate(req);
// It is handed the web Request (not a framework context) and nothing else.
const param: Same<Parameters<Identify>, [req: Request]> = true;
const result: Same<Awaited<ReturnType<Identify>>, Principal | null | undefined> = true;
const notAny1: IsAny<Identify> = false;
const notAny2: IsAny<Parameters<Identify>[0]> = false;
const notAny3: IsAny<ReturnType<Identify>> = false;
export { sync, nobody, optOut, fromSession, fromProvider, param, result, notAny1, notAny2, notAny3 };
`;

describe('Identify', () => {
  const cases = {
    baseline: IDENTIFY,
    // A bare user id is not a principal: the door could not tell a user from staff.
    returnsString: mutate(IDENTIFY, 'const optOut: Identify = () => undefined;', "const optOut: Identify = () => 'u-1';"),
    // A principal with no declared kind.
    returnsKindless: mutate(IDENTIFY, 'const nobody: Identify = () => null;', "const nobody: Identify = () => ({ id: 'u-1', roles: [] });"),
    // It takes the web Request, not a framework context.
    takesContext: mutate(IDENTIFY, 'const optOut: Identify = () => undefined;', 'const optOut: Identify = (c: { req: { raw: Request } }) => undefined;'),
    asyncKindless: mutate(IDENTIFY, "return id ? { kind: 'subject', id, roles: [] } : undefined;", 'return id ? { id, roles: [] } : undefined;'),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('sync, async, null, undefined and an AuthProvider all satisfy it; nothing is any', () => {
    expect(d.baseline).toEqual([]);
  });
  it('returning a bare id is refused (TS2322)', () => {
    expect(d.returnsString).toEqual(only(2322, "Type 'string' is not assignable"));
  });
  it('returning a principal without kind is refused (TS2322)', () => {
    expect(d.returnsKindless).toEqual(only(2322, "Property 'kind' is missing"));
  });
  it('a function of a framework context is refused (TS2322)', () => {
    expect(d.takesContext).toEqual(only(2322, "Types of parameters 'c' and 'req' are incompatible"));
  });
  it('an async answer without kind is refused (TS2741)', () => {
    expect(d.asyncKindless).toEqual(only(2741, "Property 'kind' is missing"));
  });
});

// ---------------------------------------------------------------------------------------------------
// engineCallerOf and EngineCaller
// ---------------------------------------------------------------------------------------------------
const ENGINE = `
import { engineCallerOf, type EngineCaller, type Principal } from '@gnldev/auth';
${HELPERS}
declare const p: Principal;
// A principal, null, or undefined; and optionally the user an application names on this request.
const a: EngineCaller = engineCallerOf(p);
const b: EngineCaller = engineCallerOf(null);
const c: EngineCaller = engineCallerOf(undefined, 'u-1');
function describeCaller(x: EngineCaller): string {
  switch (x.kind) {
    case 'user': { const id: string = x.id; return id; }
    case 'staff': return x.orgId ?? 'platform';
    case 'unknown': return 'nobody';
  }
}
const ret: Same<ReturnType<typeof engineCallerOf>, EngineCaller> = true;
const kinds: Same<EngineCaller['kind'], 'user' | 'staff' | 'unknown'> = true;
const args: Same<Parameters<typeof engineCallerOf>, [principal: Principal | null | undefined, named?: string]> = true;
const notAny1: IsAny<EngineCaller> = false;
const notAny2: IsAny<ReturnType<typeof engineCallerOf>> = false;
const notAny3: IsAny<Parameters<typeof engineCallerOf>[0]> = false;
export { a, b, c, describeCaller, ret, kinds, args, notAny1, notAny2, notAny3 };
`;

describe('engineCallerOf and EngineCaller', () => {
  const cases = {
    baseline: ENGINE,
    namedIsString: mutate(ENGINE, "engineCallerOf(undefined, 'u-1')", 'engineCallerOf(undefined, 42)'),
    principalHasKind: mutate(ENGINE, 'engineCallerOf(p)', "engineCallerOf({ id: 'u-1', roles: [] })"),
    // Staff names nobody: reading an id off it without narrowing to a user does not compile.
    staffHasNoId: mutate(ENGINE, "case 'staff': return x.orgId ?? 'platform';", "case 'staff': return x.id;"),
    userNeedsId: mutate(ENGINE, 'const b: EngineCaller = engineCallerOf(null);', "const b: EngineCaller = { kind: 'user' };"),
  };
  let d: Record<keyof typeof cases, TypeDiagnostic[]>;
  beforeAll(() => { d = typeDiagnostics(__dirname, cases) as typeof d; }, 60_000);

  it('maps a principal, null or undefined to one of three callers; nothing is any', () => {
    expect(d.baseline).toEqual([]);
  });
  it('the named user is a string (TS2345)', () => {
    expect(d.namedIsString).toEqual(only(2345, "Argument of type 'number' is not assignable to parameter of type 'string'"));
  });
  it('a principal without kind is refused (TS2345)', () => {
    expect(d.principalHasKind).toEqual(only(2345, "Property 'kind' is missing"));
  });
  it('staff carries no id (TS2339)', () => {
    expect(d.staffHasNoId).toEqual(only(2339, "Property 'id' does not exist"));
  });
  it('a user caller carries its id (TS2322)', () => {
    expect(d.userNeedsId).toEqual(only(2322, "Property 'id' is missing"));
  });
});
