// resolveAuthProvider — the `gnl dev` license path: config/env credentials → free roleAuth, and
// (license present) → @gnldev/auth-ee resolved FROM THE PROJECT. The risky branches are the silent
// ones: EE missing → fall back to free, unless licenseStrict, in which case booting unprotected is
// exactly what must NOT happen. `serveDev` itself (Node boot + listen) is not covered here — it
// needs a fully installed project; dev-server.test.ts covers the app it builds.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Auth from '@gnldev/auth';
import { resolveAuthProvider } from '../src/dev-server.js';
import type { GnlDevConfig } from '../src/config.js';

const created: string[] = [];
const envKeys = ['GNL_LICENSE_KEY', 'GNL_ADMIN_TOKEN', 'GNL_VIEWER_TOKEN', 'GNL_ADMIN_USER', 'GNL_ADMIN_PASS'];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of envKeys) delete process.env[k];
});

/** A throwaway project root. Kept outside the monorepo so the upward node_modules walk starts clean;
 *  note this alone is NOT enough to simulate "package missing" — see withUnresolvableEE below. */
function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-devauth-'));
  created.push(dir);
  return dir;
}

/** Installs a fake @gnldev/auth-ee into `dir` whose createEnterpriseAuth echoes back what it received. */
function installFakeEE(dir: string): void {
  const pkgDir = join(dir, 'node_modules', '@gnldev', 'auth-ee');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@gnldev/auth-ee', version: '1.0.0', type: 'module', main: 'index.js' }));
  writeFileSync(
    join(pkgDir, 'index.js'),
    'export function createEnterpriseAuth(opts) {\n' +
      '  return { __ee: true, licenseKey: opts.licenseKey, failClosed: opts.failClosed, publicKey: opts.publicKey, hasFallback: !!opts.fallback,\n' +
      '           authenticate: () => null, authorize: () => ({ allow: true }) };\n' +
      '}\n',
  );
}

const cfg = (o: Partial<GnlDevConfig> = {}): GnlDevConfig => o as GnlDevConfig;

describe('resolveAuthProvider — no license (free path)', () => {
  it('config.auth roles produce a working free provider', async () => {
    const p = await resolveAuthProvider(cfg({ auth: { admin: { token: 'adm' } } }) as any, Auth, tmpProject());
    expect(p).toBeDefined();
    expect((p as any).__ee).toBeUndefined();
    const ok = await p!.authorize!(p!.authenticate!(new Request('http://x/', { headers: { authorization: 'Bearer adm' } })) as any,
      new Request('http://x/', { headers: { authorization: 'Bearer adm' } }), { action: 'write' } as any);
    expect(ok.allow).toBe(true);
  });

  it('no roles anywhere → undefined (auth stays opt-in; dev boots open)', async () => {
    expect(await resolveAuthProvider(cfg(), Auth, tmpProject())).toBeUndefined();
  });

  it('env GNL_ADMIN_TOKEN is picked up when config.auth is absent', async () => {
    process.env.GNL_ADMIN_TOKEN = 'from-env';
    const p = await resolveAuthProvider(cfg(), Auth, tmpProject());
    expect(p).toBeDefined();
  });

  it('env GNL_ADMIN_USER without GNL_ADMIN_PASS is NOT a credential (half a pair opens nothing)', async () => {
    process.env.GNL_ADMIN_USER = 'admin';
    expect(await resolveAuthProvider(cfg(), Auth, tmpProject())).toBeUndefined();
    process.env.GNL_ADMIN_PASS = 'pw';
    expect(await resolveAuthProvider(cfg(), Auth, tmpProject())).toBeDefined();
  });

  it('config.auth wins over the env fallback', async () => {
    process.env.GNL_ADMIN_TOKEN = 'env-token';
    const p = await resolveAuthProvider(cfg({ auth: { admin: { token: 'config-token' } } }) as any, Auth, tmpProject());
    const asks = (t: string) => new Request('http://x/', { headers: { authorization: `Bearer ${t}` } });
    expect((await p!.authorize!(p!.authenticate!(asks('config-token')) as any, asks('config-token'), { action: 'write' } as any)).allow).toBe(true);
    expect((await p!.authorize!(p!.authenticate!(asks('env-token')) as any, asks('env-token'), { action: 'write' } as any)).allow).toBe(false);
  });
});

describe('resolveAuthProvider — license present', () => {
  it('EE installed → the enterprise provider, carrying licenseKey + the free provider as fallback', async () => {
    const dir = tmpProject();
    installFakeEE(dir);
    const p: any = await resolveAuthProvider(cfg({ license: 'ee_key', auth: { admin: { token: 'a' } } }) as any, Auth, dir);
    expect(p.__ee).toBe(true);
    expect(p.licenseKey).toBe('ee_key');
    expect(p.hasFallback).toBe(true); // an invalid license must degrade to free, not to nothing
  });

  it('licenseStrict is forwarded as failClosed (paid deployments must not boot unprotected)', async () => {
    const dir = tmpProject();
    installFakeEE(dir);
    const p: any = await resolveAuthProvider(cfg({ license: 'ee_key', licenseStrict: true, licensePublicKey: 'pub' }) as any, Auth, dir);
    expect(p.failClosed).toBe(true);
    expect(p.publicKey).toBe('pub');
  });

  it('GNL_LICENSE_KEY from env is honored when config.license is unset', async () => {
    const dir = tmpProject();
    installFakeEE(dir);
    process.env.GNL_LICENSE_KEY = 'ee_from_env';
    const p: any = await resolveAuthProvider(cfg(), Auth, dir);
    expect(p.__ee).toBe(true);
    expect(p.licenseKey).toBe('ee_from_env');
  });

  it('config.license wins over GNL_LICENSE_KEY', async () => {
    const dir = tmpProject();
    installFakeEE(dir);
    process.env.GNL_LICENSE_KEY = 'env-key';
    const p: any = await resolveAuthProvider(cfg({ license: 'config-key' }) as any, Auth, dir);
    expect(p.licenseKey).toBe('config-key');
  });

  // "@gnldev/auth-ee is not installed" cannot be produced by pointing at an empty directory: vitest
  // puts `node_modules/.pnpm/node_modules` on NODE_PATH, so createRequire().resolve() finds every
  // workspace package from ANY cwd. The branch is reached by making the resolver itself throw, which
  // is exactly what a free install does at this line.
  async function withUnresolvableEE<T>(fn: (resolve: typeof resolveAuthProvider) => Promise<T>): Promise<T> {
    vi.resetModules();
    vi.doMock('../src/runtime.js', () => ({
      resolveFromProject: () => {
        throw new Error("gnl: couldn't resolve '@gnldev/auth-ee'");
      },
    }));
    try {
      const mod = await import('../src/dev-server.js');
      return await fn(mod.resolveAuthProvider);
    } finally {
      vi.doUnmock('../src/runtime.js');
      vi.resetModules();
    }
  }

  it('EE NOT installed + non-strict → silently degrades to the free provider (free installs keep working)', async () => {
    const p: any = await withUnresolvableEE((resolve) =>
      resolve(cfg({ license: 'ee_key', auth: { admin: { token: 'a' } } }) as any, Auth, tmpProject()),
    );
    expect(p).toBeDefined();
    expect(p.__ee).toBeUndefined();
  });

  it('EE NOT installed + licenseStrict → THROWS instead of quietly booting without premium', async () => {
    await expect(
      withUnresolvableEE((resolve) => resolve(cfg({ license: 'ee_key', licenseStrict: true }) as any, Auth, tmpProject())),
    ).rejects.toThrow(/auth-ee is not installed/);
  });

  it('a license with no roles configured still yields the EE provider (license alone is enough to protect)', async () => {
    const dir = tmpProject();
    installFakeEE(dir);
    const p: any = await resolveAuthProvider(cfg({ license: 'ee_key' }) as any, Auth, dir);
    expect(p.__ee).toBe(true);
  });
});
