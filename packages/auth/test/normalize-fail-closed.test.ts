// An `auth` option the host does not recognise must not become "allow everything".
//
// normalizeAuth read anything without an `authorize` function as a {read, write} pair, and
// fromReadWrite treats a missing direction as unrestricted. So an unrecognised object produced a
// provider that authorised every request — while the caller believed authentication was configured,
// and the surface looked protected from the outside (there IS a provider; it just says yes).
//
// The realistic way in is the credential map the scaffold writes:
//
//   createRestApi({ auth: { admin: { token: 's3cret' } } })
//
// That shape shipped once already. @gnldev/studio grew `resolveConfigAuth` to catch it, but
// @gnldev/server calls normalizeAuth directly (index.ts), so one host was fixed and the other was not
// — which is why the fix belongs here rather than at each call site.
import { describe, it, expect } from 'vitest';
import { normalizeAuth, fromReadWrite, roleAuth } from '../src/index.js';

const req = () => new Request('http://x/runs', { method: 'POST' });
const ctx = { action: 'write' } as never;

describe('normalizeAuth on an unrecognised object', () => {
  it('refuses a credential map instead of turning it into an allow-all provider', () => {
    // The message has to name the fix; an error that only says "invalid" sends the reader to the
    // source of a dependency.
    expect(() => normalizeAuth({ admin: { token: 's3cret' } } as never)).toThrow(/roleAuth/);
    expect(() => normalizeAuth({ admin: { token: 's3cret' } } as never)).toThrow(/authorise every request/);
  });

  it('refuses an empty object and a typo\'d key', () => {
    expect(() => normalizeAuth({} as never)).toThrow(TypeError);
    // `reader`/`writer` instead of `read`/`write` — a plausible slip that used to open everything.
    expect(() => normalizeAuth({ reader: () => true, writer: () => true } as never)).toThrow(TypeError);
  });

  it('still accepts the two shapes it is meant to accept', async () => {
    const provider = roleAuth({ admin: { token: 'a' } });
    expect(normalizeAuth(provider)).toBe(provider); // a real provider passes through untouched

    // A genuine {read, write} pair keeps working, including the documented "missing direction is
    // unrestricted" reading — that behaviour is intended and is NOT what this change alters.
    const rw = normalizeAuth({ write: async () => false })!;
    expect(await rw.authorize(null as never, req(), ctx)).toEqual({ allow: false, status: 403 });
    const readOnly = normalizeAuth({ read: async () => true })!;
    expect(await readOnly.authorize(null as never, req(), ctx)).toEqual({ allow: true }); // no write fn → unrestricted
  });

  it('undefined still means no restrictions — the intent is expressible without guessing', () => {
    expect(normalizeAuth(undefined)).toBeUndefined();
  });

  it('the old behaviour really was allow-all, so this is a fix and not a rename', async () => {
    // Reconstructed through the public helper: fromReadWrite over an object with neither direction is
    // exactly what normalizeAuth used to build from a credential map.
    const asItWas = fromReadWrite({ admin: { token: 's3cret' } } as never);
    expect(await asItWas.authorize(null as never, req(), ctx)).toEqual({ allow: true });
  });
});
