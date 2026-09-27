/**
 * A caller-chosen name (a job id, a trigger id) stored WITHIN its owner.
 *
 * The queue and the scheduler each keep one log for every organization, and took the caller's name as
 * the key: globex's `weekly-report` collapsed into acme's, and the second user to schedule a workflow
 * without an id got the first one's trigger back. The name is a name under its owner — the rule the
 * chat turn key and the workKey already follow — so it is stored as `<org>:<user>:<name>`, the two owner
 * parts URI-encoded so that no name can be spelled into another owner's. A name with no owner (the
 * system's own work) is kept exactly as given.
 *
 * One function for both packages: two copies of a key rule are how two stores end up disagreeing.
 */
/**
 * Owned and system names live in DISJOINT namespaces: an owned name starts with the reserved marker
 * `~o~`, which a system name may not start with (`assertSystemName`). Each owner part is escaped by a
 * TOTAL, injective escape (`%`, `:`, `~` only — no URIError on a lone surrogate), so no name can be
 * spelled into another owner's and a system id can never read as someone's.
 */
const OWNED = '~o~';
const esc = (v: string) => v.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/~/g, '%7E');
const unesc = (v: string) => v.replace(/%7E/g, '~').replace(/%3A/g, ':').replace(/%25/g, '%');

export function ownedName(name: string, owner: { orgId?: string; resourceId?: string }): string {
  if (owner.orgId === undefined && owner.resourceId === undefined) {
    assertSystemName(name);
    return name;
  }
  return `${OWNED}${owner.orgId === undefined ? '' : esc(owner.orgId)}:${owner.resourceId === undefined ? '' : esc(owner.resourceId)}:${name}`;
}

/** The id prefix every name this owner owns starts with (erasure finds them by it). */
export function ownedPrefix(owner: { orgId?: string; resourceId?: string }): string {
  return `${OWNED}${owner.orgId === undefined ? '' : esc(owner.orgId)}:${owner.resourceId === undefined ? '' : esc(owner.resourceId)}:`;
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
