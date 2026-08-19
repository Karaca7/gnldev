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

/**
 * AuthProvider | {read,write} | undefined → AuthProvider | undefined (hosts reduce to a single type).
 *
 * Throws on an object that is neither, because the alternative is the worst possible answer. The
 * previous reading was "not a provider ⇒ it must be {read,write}", and `fromReadWrite` treats a
 * missing direction as unrestricted — so ANY unrecognised object became a provider that allows
 * everything. The realistic way to hit that is the credential map the scaffold writes:
 *
 *   createRestApi({ auth: { admin: { token: 's3cret' } } })   // looks protected, allows everyone
 *
 * That exact shape shipped once already: @gnldev/studio grew `resolveConfigAuth` for it, but
 * @gnldev/server still calls this directly, so the hole stayed open on the other host. Refusing here
 * closes it for every caller and turns a silent, invisible failure into an error at startup — the one
 * moment it can still be fixed. A caller that really wants no restrictions passes `undefined`; that
 * intent is expressible and needs no guessing.
 */
export function normalizeAuth(auth?: AuthProvider | ReadWriteAuth): AuthProvider | undefined {
  if (!auth) return undefined;
  if (isProvider(auth)) return auth;
  const rw = auth as ReadWriteAuth;
  // Each side that is PRESENT must be a function. The check used to be `read is fn OR write is fn`,
  // which short-circuits: `{ read: fn, write: { admin: { token } } }` — one direction a predicate, the
  // other a credential map, which is what a half-finished config looks like — passed here and then
  // threw at REQUEST time, on the first write, in production. That is the silent invisible failure
  // this whole function exists to move to startup.
  const sides = (['read', 'write'] as const).filter((k) => rw[k] !== undefined);
  if (sides.length > 0) {
    const bad = sides.filter((k) => typeof rw[k] !== 'function');
    if (bad.length === 0) return fromReadWrite(rw);
    throw new TypeError(
      `@gnldev/auth: \`auth.${bad.join('\` and \`auth.')}\` must be a function ` +
      `(got ${bad.map((k) => `${k}: ${typeof rw[k]}`).join(', ')}). ` +
      `A {read, write} pair takes predicates; a credential map like { admin: { token } } has to be ` +
      `wrapped: \`roleAuth({ admin: { token } })\`. Left as it is, this authorises nothing until the ` +
      `first request and then throws there instead.`,
    );
  }
  const keys = Object.keys(auth as object).slice(0, 5).join(', ') || '(no keys)';
  throw new TypeError(
    `@gnldev/auth: \`auth\` is neither an AuthProvider (no \`authorize\` function) nor a {read, write} ` +
    `pair (no \`read\`/\`write\` function). Got an object with: ${keys}. ` +
    `If this is a credential map like { admin: { token } }, wrap it: \`roleAuth({ admin: { token } })\`. ` +
    `Passing it directly would authorise every request. For no restrictions, omit \`auth\` entirely.`,
  );
}
