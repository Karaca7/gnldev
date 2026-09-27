/**
 * Studio is a staff console, and the KIND says who is staff.
 *
 * The door used to refuse one ROLE, `client`. Everything else walked in — including an end user from
 * @gnldev/auth-ee's user store, whose default role is `viewer`: measured, such a user read `/runs`
 * (every end user's, with `resourceId` attached) and full journals. What Studio shows is anyone's data
 * in the organization, which is exactly what `kind: 'operator'` grants and nothing else does.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const PRINCIPALS: Record<string, unknown> = {
  ops: { kind: 'operator', roles: ['viewer'] },
  app: { kind: 'application', roles: ['admin'] },
  // Same role as `ops`, and more of it. Only the kind differs.
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] },
  nameless: { kind: 'subject', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: (p: unknown) => (p ? { allow: true } : { allow: false, status: 401 }),
};
const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never });
const get = (who: string | null, path: string) =>
  api(new Request(`http://x${path}`, who ? { headers: { authorization: `Bearer ${who}` } } : {}));

describe('Studio admits staff only', () => {
  it('an operator reads', async () => {
    expect((await get('ops', '/runs')).status).toBe(200);
  });

  it.each(['ayse', 'app', 'nameless'])('%s is refused, whatever its role', async (who) => {
    const r = await get(who, '/runs');
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toContain('staff');
  });

  it('no credential is still a 401, not a 403 — the per-endpoint gate answers that', async () => {
    expect((await get(null, '/runs')).status).toBe(401);
  });
});
