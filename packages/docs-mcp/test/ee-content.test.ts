// docs-mcp is a public package that documents a PAID one. That combination has one failure mode worth
// pinning: an AI assistant reads these docs and tells a public user to `npm install @gnldev/auth-ee`,
// the user gets E404, and neither of them knows the package was never on the public registry. The
// audit counted 15 auth-ee references; most are import statements documenting the API surface (which
// is the point — the capability should be discoverable), one was an npm-install command contradicting
// the EE_NOTE printed right under it.
import { describe, it, expect } from 'vitest';
import { FEATURES, EE_NOTE } from '../src/content.js';
import { buildFeatureText } from '../src/text.js';

describe('paid-tier content in a public package', () => {
  it('no install command tells anyone to npm-install auth-ee', () => {
    for (const f of FEATURES) {
      const installLines = (f.install ?? '').split('\n').filter((l) => l.includes('npm install'));
      for (const line of installLines) {
        // The package may be MENTIONED (a trailing comment saying it arrives separately is exactly
        // right) — what it must never be is an argument to the install command itself.
        const command = line.split('#')[0]!;
        expect(command, `${f.slug}: npm-install command names a package that 404s publicly`).not.toContain('auth-ee');
      }
    }
  });

  it('every ee-tier feature carries the not-on-npm note in its rendered text', () => {
    const ee = FEATURES.filter((f) => f.tier === 'ee');
    expect(ee.length, 'the paid tier exists and is documented — discoverability is deliberate').toBeGreaterThan(0);
    for (const f of ee) {
      expect(buildFeatureText(f), `${f.slug} renders without the EE note`).toContain(EE_NOTE);
    }
  });

  it('the note says where the package actually comes from', () => {
    expect(EE_NOTE).toContain('not published to the public npm registry');
    expect(EE_NOTE).toContain('gnl.dev');
  });
});
