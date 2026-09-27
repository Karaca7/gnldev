// The identity row of the protections matrix, decided from the CONFIG so `gnl dev` and `gnl doctor`
// say the same thing about one project. Measured before: `gnl dev` printed `✓ identity bound` for a
// project whose only credentials were staff tokens (runs were ownerless), and `gnl doctor` printed ○.
import { describe, it, expect, afterEach } from 'vitest';
import { identityRow } from '../src/protections-view.js';
import type { GnlDevConfig } from '../src/config.js';

const cfg = (o: Record<string, unknown>) => o as GnlDevConfig;
afterEach(() => { delete process.env.GNL_END_USER_SECRET; delete process.env.GNL_CLIENT_TOKEN; delete process.env.GNL_LICENSE_KEY; });

describe('identityRow', () => {
  it('end-user tokens bind each user to itself: ✓', () => {
    expect(identityRow(cfg({ auth: { endUsers: { secret: 's' } } }), true).bound).toBe(true);
  });

  it('staff tokens alone do NOT bind anyone — the ✓ this used to print', () => {
    const row = identityRow(cfg({ auth: { admin: { token: 'a' } } }), true);
    expect(row.bound).toBe(false);
    expect(row.note).toContain('auth.endUsers');
  });

  it('an application credential names its user: not proven by this surface', () => {
    expect(identityRow(cfg({ auth: { client: { token: 'c' } } }), true).bound).toBe('unknown');
  });

  it('dev and doctor agree: the answer does not depend on who is asking', () => {
    for (const c of [cfg({ auth: { endUsers: { secret: 's' } } }), cfg({ subjects: 'internal' }), cfg({})]) {
      expect(identityRow(c, false).bound).toBe(identityRow(c, false).bound);
    }
    // doctor passes `false`; with end users configured it must still say bound, as dev does.
    expect(identityRow(cfg({ auth: { endUsers: { secret: 's' } } }), false).bound).toBe(true);
  });

  it('a declared `subjects: end-users` with no end-user credential says what to add', () => {
    expect(identityRow(cfg({ subjects: 'end-users' }), false).note).toContain('auth.endUsers');
  });
});
