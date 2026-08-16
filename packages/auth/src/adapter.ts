// Backward compatibility: wraps the old {read,write} predicate pair (StudioAuth / examples/app) into an AuthProvider.
import type { AuthProvider, Decision, AuthContext } from './types.js';

/** Old role-based hook: read = GET (viewer), write = POST/PUT/PATCH/DELETE (admin). */
export interface ReadWriteAuth {
  read?: (req: Request) => boolean | Promise<boolean>;
  write?: (req: Request) => boolean | Promise<boolean>;
}

/**
 * Can this provider ever produce a principal?
 *
 * `authenticate() === null` is ambiguous: it means EITHER "this request carried no token" (a
 * roleAuth caller who should get 401) OR "this provider has no principal model at all and never
 * will" (the {read,write} pair below). A host that scopes organizations by identity has to tell
 * those apart — the first is a per-request condition, the second is a configuration that cannot
 * isolate anything, because there is no identity to bind an org to. Collapsing them makes the
 * unauthenticated caller's 401 turn into a misleading 403, or leaves the unsafe configuration open.
 *
 * Absent on hand-written providers, so `!== false` is the compatible reading: unknown means capable.
 */
export function bindsIdentity(auth: AuthProvider | undefined): boolean {
  return !!auth && (auth as { bindsIdentity?: boolean }).bindsIdentity !== false;
}

/** {read,write} → AuthProvider. If there's no fn in that direction, it's unrestricted (preserves the existing `!fn || fn(c)` behavior). */
export function fromReadWrite(rw: ReadWriteAuth): AuthProvider {
  return {
    bindsIdentity: false,
    authenticate() {
      return null; // no principal model; the decision is made in the predicate.
    },
    async authorize(_p, req: Request, ctx: AuthContext): Promise<Decision> {
      const fn = ctx.action === 'read' ? rw.read : rw.write;
      if (!fn) return { allow: true };
      const ok = await fn(req);
      return ok ? { allow: true } : { allow: false, status: ctx.action === 'write' ? 403 : 401 };
    },
  };
}

function isProvider(x: AuthProvider | ReadWriteAuth): x is AuthProvider {
  return typeof (x as AuthProvider).authorize === 'function';
}

/** AuthProvider | {read,write} | undefined → AuthProvider | undefined (hosts reduce to a single type). */
export function normalizeAuth(auth?: AuthProvider | ReadWriteAuth): AuthProvider | undefined {
  if (!auth) return undefined;
  return isProvider(auth) ? auth : fromReadWrite(auth);
}
