/**
 * A caller-chosen name (a job id, a trigger id, an event id) stored WITHIN its owner, and the one rule
 * for what an owner id may be.
 *
 * The queue, the scheduler and the event bus each keep one log for every organization, and took the
 * caller's name as the key: globex's `weekly-report` collapsed into acme's, and the second user to
 * schedule a workflow without an id got the first one's trigger back. The name is a name under its
 * owner — the rule the chat turn key and the workKey already follow.
 *
 * Owned and system names live in DISJOINT namespaces: an owned name starts with the reserved marker
 * `~o~`, which a system name may not start with (`assertSystemName`), so a system id such as
 * `acme:bob:x` never reads as bob's `x`. Each owner part is escaped by a TOTAL, injective escape, so no
 * name can be spelled into another owner's, and no id throws on the way in.
 *
 * One module for every package: two copies of a key rule are how two stores end up disagreeing.
 */

const OWNED = '~o~';

/**
 * A lone surrogate is a valid JS string but not valid UTF-8. Postgres (through `pg`) stores it as
 * U+FFFD, so `u\uD800`, `u\uDC00` and `u\uFFFD` became ONE key there — measured: three owners'
 * jobs, one row, two writes reported as done and dropped. So the escape writes it as `%uXXXX`.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** @internal — true when every store can hold `s` unchanged (no lone surrogate). `String#isWellFormed`, pre-ES2024. */
export const isWellFormed = (s: string): boolean => s.search(LONE_SURROGATE) < 0;

// `%` first, so every `%` in the output is one this escape wrote. The output is well-formed UTF-16
// and contains no `:` or `~`, which is what makes the `:`-separated layout below unambiguous.
const esc = (v: string) =>
  v.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/~/g, '%7E')
    .replace(LONE_SURROGATE, (s) => `%u${s.charCodeAt(0).toString(16).toUpperCase()}`);
const unesc = (v: string) =>
  v.replace(/%(25|3A|7E|u[0-9A-F]{4})/g, (_m, c: string) =>
    c === '25' ? '%' : c === '3A' ? ':' : c === '7E' ? '~' : String.fromCharCode(parseInt(c.slice(1), 16)));

/**
 * Prefixes a subject id may not carry: a staff or synthetic id is written `operator:ops`,
 * `application:svc`, and no end user may be minted into those names.
 *
 * MIRRORS `RESERVED_SUBJECT_PREFIXES` in @gnldev/auth. This package depends on no other `@gnldev/*`
 * package (ADR-0002), so the rule is written twice and held equal by a parity test
 * (packages/server/test/owner-id-parity.test.ts). Change both, or the test fails.
 */
export const RESERVED_OWNER_PREFIXES: readonly string[] = ['operator:', 'application:', 'role:', 'token:'];

const MAX_OWNER_ID = 200;

/**
 * Why a string cannot be an end user's (an owner's) id, or `null` when it can. The ONE rule, used by
 * `ownedName` and every vector store's `owner` label, and the same answer as auth's
 * `subjectIdProblem` (parity test): empty or over 200 characters, a control character (C0, DEL, C1)
 * or a line/paragraph separator, or a reserved prefix.
 */
export function ownerIdProblem(id: string): 'length' | 'control characters' | 'reserved prefix' | null {
  if (id.length === 0 || id.length > MAX_OWNER_ID) return 'length';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(id)) return 'control characters';
  if (RESERVED_OWNER_PREFIXES.some((p) => id.startsWith(p))) return 'reserved prefix';
  return null;
}

/**
 * An owner id no end user can carry was handed to a place that stores data for one. Refused, never
 * stored: an empty id would name the organization's own space (`~o~acme::`), and a reserved one a
 * staff member's. A `TypeError`, so a caller already catching bad input catches it. The message says
 * what is wrong, never the id.
 */
export class OwnerIdError extends TypeError {
  readonly code = 'owner_id_invalid';
  constructor(readonly problem: string, where: string) {
    super(`@gnldev/durable: ${where} is not an id an end user can carry (${problem}).`);
    this.name = 'OwnerIdError';
  }
}

/** Throws `OwnerIdError` unless `id` passes `ownerIdProblem`. `where` names the field for the message. */
export function assertOwnerId(id: unknown, where: string): asserts id is string {
  const problem = typeof id !== 'string' ? 'not a string' : ownerIdProblem(id);
  if (problem !== null) throw new OwnerIdError(problem, where);
}

type Owner = { orgId?: string; resourceId?: string };

/** The owner part of a stored name. Checked here, so every writer and every eraser use the same rule. */
function ownerPart(owner: Owner): string {
  if (owner.orgId !== undefined && (typeof owner.orgId !== 'string' || owner.orgId === '')) {
    // An empty organization would read as "no organization": `{ orgId: '', resourceId: 'x' }` and
    // `{ resourceId: 'x' }` were the same owner.
    throw new OwnerIdError(typeof owner.orgId !== 'string' ? 'not a string' : 'length', 'orgId');
  }
  if (owner.resourceId !== undefined) assertOwnerId(owner.resourceId, 'resourceId');
  return `${OWNED}${owner.orgId === undefined ? '' : esc(owner.orgId)}:${owner.resourceId === undefined ? '' : esc(owner.resourceId)}:`;
}

/**
 * `name` stored within its owner: `~o~<org>:<user>:<name>`, each owner part escaped. With no owner, the
 * system's own name, kept exactly as given (and refused if it wears the owned marker). Throws
 * `OwnerIdError` for an owner no end user can carry.
 */
export function ownedName(name: string, owner: Owner): string {
  if (owner.orgId === undefined && owner.resourceId === undefined) {
    assertSystemName(name);
    return name;
  }
  return `${ownerPart(owner)}${name}`;
}

/** The id prefix every name this owner owns starts with (erasure finds them by it). Same checks as `ownedName`. */
export function ownedPrefix(owner: Owner): string {
  return ownerPart(owner);
}

/** A system (ownerless) name may not wear the owned marker. */
export function assertSystemName(name: string): void {
  if (name.startsWith(OWNED)) {
    throw new TypeError(`@gnldev/durable: '${name}' starts with the reserved owned-name marker '${OWNED}' — a system name cannot claim an owner.`);
  }
}

/** The owner a stored name carries — read from the NAME the engine wrote, never from a payload. */
export function ownerOfName(stored: string): { orgId?: string; resourceId?: string; name: string } {
  if (!stored.startsWith(OWNED)) return { name: stored };
  const rest = stored.slice(OWNED.length);
  const a = rest.indexOf(':');
  const b = rest.indexOf(':', a + 1);
  if (a < 0 || b < 0) return { name: stored };
  const org = rest.slice(0, a);
  const res = rest.slice(a + 1, b);
  return { ...(org ? { orgId: unesc(org) } : {}), ...(res ? { resourceId: unesc(res) } : {}), name: rest.slice(b + 1) };
}
