// End users with a password, for tests. `roleAuth` mints only staff and applications — a credential
// written into the deployment's config is staff by construction — so a test that needs an END USER
// who logs in wraps it here. Roles are untouched, so `authorize` answers exactly as it did; the only
// difference is `kind`, which is what the ownership gates read.
import type { AuthProvider } from '@gnldev/auth';

export function asEndUsers(inner: AuthProvider | undefined, names: readonly string[]): AuthProvider {
  if (!inner) throw new Error('asEndUsers: no provider to wrap');
  return {
    ...inner,
    authenticate: async (req) => {
      const p = await inner.authenticate(req);
      return p?.id && names.includes(p.id) ? { ...p, kind: 'subject' } : p;
    },
    authorize: (p, req, ctx) => inner.authorize(p, req, ctx),
  };
}
