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
export function ownedName(name: string, owner: { orgId?: string; resourceId?: string }): string {
  if (owner.orgId === undefined && owner.resourceId === undefined) return name;
  const enc = (v?: string) => (v === undefined ? '' : encodeURIComponent(v));
  return `${enc(owner.orgId)}:${enc(owner.resourceId)}:${name}`;
}
