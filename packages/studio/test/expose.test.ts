// Who can reach the Studio. Both cases here shipped broken and neither was catchable, because the
// decision was inline at the top of a bin script that runs on import.
//
// What was measured before the fix, on the publish candidate:
//   • `auth: { admin: { token } }` in gnl.config → `PUT /api/policy` succeeded with NO credentials.
//     cli.ts built its options object without ever reading `cfg.auth`, and then warned the user to
//     "configure roleAuth via --config" — the thing they had already done, which did nothing.
//   • `gnl-studio --host 0.0.0.0` (documented in packages/studio/README.md) served an unauthenticated
//     ADMIN panel — policy writes, retention purge, cache invalidation, a Playground that spends the
//     project's API keys — to every interface, and printed no warning at all. `allowOpenAccess` was
//     assigned `loopback`, so off-loopback it merely passed `false` to a gate that throws only under
//     NODE_ENV=production.
import { describe, it, expect } from 'vitest';
import { decideStudioExposure, isLoopbackHost, resolveConfigAuth, configCredentialTokens } from '../src/expose.js';
import { roleAuth } from '@gnldev/auth';

const on = (host: string, authed: boolean, allowOpenNetwork = false) =>
  decideStudioExposure({ host, authed, allowOpenNetwork });

describe('studio exposure decision', () => {
  it('refuses a network host with no auth — the combination that is unsafe by construction', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'studio.internal']) {
      const d = on(host, false);
      expect(d.refusal, `${host} must be refused`).toBeDefined();
      expect(d.refusal).toContain('refusing to serve');
      expect(d.refusal, 'the message must name both ways out').toContain('--allow-open-network');
      expect(d.refusal).toContain('auth: { admin: { token: ... } }');
      expect(d.allowOpenAccess, 'a refused start must not also assert open access').toBe(false);
    }
  });

  it('a network host WITH auth serves, and says what is exposed', () => {
    const d = on('0.0.0.0', true);
    expect(d.refusal).toBeUndefined();
    // The contradiction the old code could produce: auth configured AND open access asserted.
    expect(d.allowOpenAccess, 'auth is configured, so open access must not be claimed').toBe(false);
    expect(d.warnings.join(' ')).toContain('auth: protected');
  });

  it('a network host with no auth serves only on the explicit opt-in, and says so loudly', () => {
    const d = on('0.0.0.0', false, true);
    expect(d.refusal).toBeUndefined();
    expect(d.allowOpenAccess).toBe(true);
    const said = d.warnings.join(' ');
    expect(said).toContain('NO AUTH');
    expect(said, 'the flag that caused it is named, so the log explains itself').toContain('--allow-open-network');
  });

  it('loopback with no auth is allowed but never silent', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const d = on(host, false);
      expect(d.refusal).toBeUndefined();
      expect(d.allowOpenAccess).toBe(true);
      expect(d.warnings.join(' '), `${host} must warn`).toContain('open without auth');
    }
  });

  it('loopback WITH auth is quiet and does not assert open access', () => {
    const d = on('127.0.0.1', true);
    expect(d.refusal).toBeUndefined();
    expect(d.allowOpenAccess).toBe(false);
    expect(d.warnings, 'nothing is exposed and nothing is open — there is nothing to say').toEqual([]);
  });

  it('isLoopbackHost covers the forms a user actually types', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '10.0.0.1']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

// ── gnl.config's `auth` has two legitimate shapes, and conflating them was a fail-open ───────────
// The config type declares `auth?: { admin?: Cred; viewer?: Cred }` and `gnl add auth` scaffolds
// exactly that — a credential MAP, not an AuthProvider. Forwarding it raw to createStudioApp was
// worse than dropping it: normalizeAuth finds no `.authorize`, wraps it as a legacy {read,write}
// pair whose two predicates are both undefined, and adapter.ts answers `{ allow: true }` for read
// AND write. So every endpoint was open, while `authed` — computed from the presence of the object —
// read true, which printed "auth: protected" and skipped the non-loopback refusal.
//
// Measured before the fix: normalizeAuth({admin:{token:'s3cret'}}).authorize(...) → {"allow":true},
// and `gnl-studio --config` accepted an unauthenticated `PUT /api/policy` with 200.
//
// The reason it got through review: the end-to-end check used `roleAuth({...})` — a real provider —
// so it exercised the shape that already worked, not the shape the scaffold writes.
describe('resolveConfigAuth', () => {
  it('turns the scaffolded credential map into a provider that actually denies', async () => {
    const provider = resolveConfigAuth({ admin: { token: 's3cret' }, viewer: { token: 'v3wer' } });
    expect(provider, 'a credential map must resolve to a provider').toBeDefined();

    const write = (headers: Record<string, string> = {}) =>
      new Request('http://localhost:4747/api/policy', { method: 'PUT', headers, body: '{}' });

    const anon = await provider!.authorize(await provider!.authenticate(write()), write(), { action: 'write', path: '/api/policy', method: 'PUT' } as never);
    expect(anon.allow, 'an unauthenticated write must be refused').toBe(false);

    const withToken = write({ authorization: 'Bearer s3cret' });
    const principal = await provider!.authenticate(withToken);
    expect(principal, 'the admin token must authenticate').not.toBeNull();
    expect((await provider!.authorize(principal, withToken, { action: 'write', path: '/api/policy', method: 'PUT' } as never)).allow).toBe(true);
  });

  it('passes a real AuthProvider straight through', () => {
    const real = roleAuth({ admin: { token: 'adm' } })!;
    expect(resolveConfigAuth(real)).toBe(real);
  });

  it('returns undefined when nothing resolves, so the network refusal still fires', () => {
    // A provider that cannot authenticate must never read as auth — that is what made the
    // credential-map case dangerous rather than merely broken.
    for (const empty of [undefined, null, {}, { admin: undefined, viewer: undefined }, 'nonsense', 42]) {
      expect(resolveConfigAuth(empty as never), JSON.stringify(empty)).toBeUndefined();
    }
    expect(decideStudioExposure({ host: '0.0.0.0', authed: Boolean(resolveConfigAuth({})), allowOpenNetwork: false }).refusal)
      .toBeDefined();
  });
});

// ── the hole this file used to own ───────────────────────────────────────────────────────────────
// The decision now lives in @gnldev/auth (see exposure.ts), and the reason it moved is here: this
// copy did not know that `admin-dev` was published in this project's own npm tarball, so
// `gnl-studio --config gnl.config.ts --host 0.0.0.0` on a freshly scaffolded project served an
// unauthenticated ADMIN panel to the network and printed "(auth: protected)" above it.
describe('a published dev credential is not auth at the Studio surface either', () => {
  it('refuses a network host whose only credential is one this project shipped', () => {
    const cfgAuth = { admin: { token: 'admin-dev' } };
    const d = decideStudioExposure({
      host: '0.0.0.0',
      authed: Boolean(resolveConfigAuth(cfgAuth)),
      allowOpenNetwork: false,
      credentialTokens: configCredentialTokens(cfgAuth),
    });
    expect(d.refusal, 'admin-dev is readable in the registry — it protects nothing').toBeDefined();
    expect(d.refusal).toContain('npm tarball');
    expect(d.authModeLabel).toBe('shipped dev token — treat as OPEN');
  });

  it('a generated token on the same config is auth', () => {
    const cfgAuth = { admin: { token: 'gnl-9f2c41ab' } };
    const d = decideStudioExposure({
      host: '0.0.0.0',
      authed: Boolean(resolveConfigAuth(cfgAuth)),
      allowOpenNetwork: false,
      credentialTokens: configCredentialTokens(cfgAuth),
    });
    expect(d.refusal).toBeUndefined();
    expect(d.authModeLabel).toBe('protected');
  });

  it('a real AuthProvider keeps its secrets, and that reads as auth rather than as shipped', () => {
    // configCredentialTokens returns nothing for a provider, which must not be mistaken for "no
    // credentials" — isPublishedDevCredential([]) is false, so a provider still counts as auth.
    const real = roleAuth({ admin: { token: 'adm' } })!;
    expect(configCredentialTokens(real)).toEqual([]);
    const d = decideStudioExposure({
      host: '0.0.0.0',
      authed: true,
      allowOpenNetwork: false,
      credentialTokens: configCredentialTokens(real),
    });
    expect(d.refusal).toBeUndefined();
    expect(d.authModeLabel).toBe('protected');
  });
});
