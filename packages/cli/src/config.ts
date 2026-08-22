// Gnl.config convention: defineConfig (type helper) + loadConfig (dynamic loader).
import type { CreateGnlConfig } from '@gnldev/durable';

/**
 * A static credential — structurally `Cred` from `@gnldev/auth`, declared here instead of imported.
 *
 * `@gnldev/auth` is an OPTIONAL peer: auth is opt-in, and a project without it still writes a
 * `gnl.config.ts`. But `GnlDevConfig` is what `defineConfig` types, so the import landed in the
 * emitted `config.d.ts`, and a consumer compiling with `skipLibCheck: false` got
 * `TS2307: Cannot find module '@gnldev/auth'` for a package they deliberately did not install. An
 * optional dependency that breaks the build when it is absent is not optional.
 *
 * `CreateGnlConfig` above stays imported on purpose: a project with a gnl.config has `@gnldev/durable`
 * — it is the framework the config configures — so that reference always resolves.
 *
 * Kept honest by `assertCredCompatible` below rather than by comment: if `Cred` gains a field or
 * changes one, THIS package fails to build, where the drift is cheap to see.
 */
export type GnlCred = {
  token?: string;
  user?: string;
  pass?: string;
  orgId?: string;
  /** Explicit platform-admin grant (scope: 'platform') — see @gnldev/auth scope.ts. */
  platformAdmin?: boolean;
};

/** `true` only when both sides have exactly the same key set — see `assertCredCompatible`. */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;

/**
 * Compile-time only: pins `GnlCred` against `@gnldev/auth`'s `Cred` on two independent axes.
 *
 * Mutual assignability alone is NOT enough, and measuring it is the only reason this is written the
 * way it is. Against the four ways `Cred` can drift:
 *
 *   field becomes required   ->  assignability catches it   (4 build errors)
 *   field changes type       ->  assignability catches it   (5 build errors)
 *   OPTIONAL field added     ->  assignability says nothing (0)  <- the likeliest drift of all
 *   field removed            ->  assignability says nothing (0)
 *
 * Both blind spots are the same rule: excess-property checking does not apply to assignments from a
 * non-literal, so `{} as GnlCred` satisfies a `Cred` that has grown a field, and vice versa. The
 * failure would be silent in the direction that matters — `Cred` gains an option and `gnl.config.ts`
 * quietly stops offering it. `SameKeys` closes both by comparing the key sets directly.
 *
 * Deliberately a function BODY. Declaration emit elides a type-only import that no exported signature
 * mentions, so `@gnldev/auth` is checked here and still absent from `config.d.ts` — which is the whole
 * point of moving the type in the first place. (`config.d.ts` does still SAY `@gnldev/auth` five times,
 * in preserved JSDoc; a grep will report this fix as broken, an import check will not.) Never called;
 * `@gnldev/auth` is a devDependency of this package, so both axes run on every `pnpm build`.
 */
async function assertCredCompatible(): Promise<void> {
  type Cred = import('@gnldev/auth').Cred;
  const _toAuth: Cred = {} as GnlCred;
  const _fromAuth: GnlCred = {} as Cred;
  const _sameKeys: SameKeys<GnlCred, Cred> = true;
  void _toAuth;
  void _fromAuth;
  void _sameKeys;
}
void assertCredCompatible;

/** gnl.config shape: createGnl config + dev server options. */
export interface GnlDevConfig extends CreateGnlConfig {
  /** gnl dev port (default 3000). */
  port?: number;
  /** Mount Studio Playground (default true). */
  studio?: boolean;
  /** OpenAPI title. */
  title?: string;
  /**
   * Optional role-based auth (opt-in). If not given, REST + Studio stay OPEN. Can also be supplied via env:
   * GNL_ADMIN_TOKEN / GNL_VIEWER_TOKEN, GNL_ADMIN_USER+GNL_ADMIN_PASS / GNL_VIEWER_USER+GNL_VIEWER_PASS.
   */
  auth?: { admin?: GnlCred; viewer?: GnlCred };
  /** Paid @gnldev/auth-ee license key (or GNL_LICENSE_KEY env). If installed, the premium provider takes over. */
  license?: string;
  /** License signature public key (base64url DER spki; or GNL_EE_PUBLIC_KEY env). */
  licensePublicKey?: string;
  /** true → instead of silently falling back to free when the license is invalid, throw at boot (recommended for paid deployments). */
  licenseStrict?: boolean;
}

/** Inside gnl.config.ts: `export default defineConfig({...})`. Identity function, only for typing. */
export function defineConfig(config: GnlDevConfig): GnlDevConfig {
  return config;
}

/** Dynamically load gnl.config (also works with .ts under tsx). Accepts default | config | module. */
export async function loadConfig(path: string): Promise<GnlDevConfig> {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const mod: any = await import(pathToFileURL(resolve(path)).href);
  const cfg = mod.default ?? mod.config ?? mod;
  if (!cfg?.journal && !cfg?.storage) throw new Error(`gnl: '${path}' is not a valid gnl.config (storage or journal required).`);
  return cfg as GnlDevConfig;
}
