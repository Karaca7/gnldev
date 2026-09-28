// How the tests name a caller: an `identify` that reads the bearer token, the way an application's
// does. The transport's validated token reaches it as `authorization: Bearer <token>`.
import type { Identify, Principal } from '@gnldev/auth';

export const bearerOf = (req: Request): string => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

export const subject = (id: string, orgId?: string): Principal => ({ kind: 'subject', id, roles: [], ...(orgId ? { orgId } : {}) });
export const operator = (id: string, orgId?: string): Principal => ({ kind: 'operator', id, roles: ['admin'], ...(orgId ? { orgId } : {}) });
export const application = (id: string, orgId?: string): Principal => ({ kind: 'application', id, roles: [], ...(orgId ? { orgId } : {}) });

/** token → principal; an unknown token is nobody. */
export const byToken = (table: Record<string, Principal>): Identify => (req) => table[bearerOf(req)];

/** token → end user id (a subject), for the tests that only need "which user". */
export const usersByToken = (table: Record<string, string>): Identify => (req) => {
  const id = table[bearerOf(req)];
  return id ? subject(id) : undefined;
};
