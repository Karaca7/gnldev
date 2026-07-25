// Ready-made auth providers: plug into the StudioAuth.read/write hook (productizes the admin↔API split).
// The new role-based default (bearer+basic, viewer/admin) is re-exported from the free @gnldev/auth.
import type { Context } from 'hono';
import { safeEqual } from '@gnldev/auth';
export { roleAuth } from '@gnldev/auth';
export type { AuthProvider, Principal, Decision, AuthCapabilities, Cred } from '@gnldev/auth';

/** Auth function that checks Authorization: Bearer <token> (constant-time comparison). */
export function bearerAuth(token: string): (c: Context) => boolean {
  const expected = `Bearer ${token}`;
  return (c) => safeEqual(c.req.header('authorization') ?? '', expected);
}

/** Auth function that checks basic auth (user:pass) (constant-time comparison). */
export function basicAuth(creds: { user: string; pass: string }): (c: Context) => boolean {
  const expected = 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  return (c) => safeEqual(c.req.header('authorization') ?? '', expected);
}
