// Backward compatibility: wraps the old {read,write} predicate pair (StudioAuth / examples/app) into an AuthProvider.
import type { Context } from 'hono';
import type { AuthProvider, Decision, AuthContext } from './types.js';

/** Old role-based hook: read = GET (viewer), write = POST/PUT/PATCH/DELETE (admin). */
export interface ReadWriteAuth {
  read?: (c: Context) => boolean | Promise<boolean>;
  write?: (c: Context) => boolean | Promise<boolean>;
}

/** {read,write} → AuthProvider. If there's no fn in that direction, it's unrestricted (preserves the existing `!fn || fn(c)` behavior). */
export function fromReadWrite(rw: ReadWriteAuth): AuthProvider {
  return {
    authenticate() {
      return null; // no principal model; the decision is made in the predicate.
    },
    async authorize(_p, c: Context, ctx: AuthContext): Promise<Decision> {
      const fn = ctx.action === 'read' ? rw.read : rw.write;
      if (!fn) return { allow: true };
      const ok = await fn(c);
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
