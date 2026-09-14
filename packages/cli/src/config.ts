// gnl.config convention: defineConfig (type helper) + loadConfig (dynamic loader).
import type { CreateGnlConfig } from '@gnldev/durable';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

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
   * WHO the runs in this deployment belong to — a DECLARATION, read by nothing at runtime.
   *
   * It exists because of the difference between two silences. `@gnldev/durable` cannot tell whether a
   * subject is bound: that is a property of the route in front of the config, so the protections
   * matrix honestly prints `? identity` when nobody says. But "nobody said" and "this is an internal
   * tool and there is deliberately no owner" are very different states, and the first is how a
   * deployment ends up with fail-open ownership gates that nobody ever decided on.
   *
   * So `gnl init` asks once and writes the answer down. `'internal'` turns the `?` into an explicit
   * `○` — unowned, on purpose, said out loud. `'end-users'` is the claim that src/identity.ts is
   * wired, and the matrix still reports what the SURFACE actually does rather than taking its word
   * for it: a declaration cannot bind a subject, only a resolver can.
   */
  subjects?: 'internal' | 'end-users';
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

/**
 * `.env` in the project root, loaded before the config module runs — because the config is exactly
 * where provider keys get read (`src/model.ts` does `process.env.NVIDIA_API_KEY`). Without this,
 * every command that loads the config (`gnl dev`, `gnl studio`, `gnl doctor`, …) silently ignored
 * the one file every provider's docs tell people to create; measured on a fresh scaffold, the model
 * answered 401 while `.env` sat correct in the project root. The shell still wins: a variable that
 * is already set is never overwritten, so CI and `KEY=x gnl dev` behave as they always did. Sits in
 * `loadConfig` rather than any single command so `gnl dev`'s hot-reload child re-reads it on every
 * restart — editing `.env` behaves like editing code.
 */
function loadDotEnv(): void {
  try {
    const parsed = parseEnv(readFileSync('.env', 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Dynamically load gnl.config (also works with .ts under tsx). Accepts default | config | module. */
export async function loadConfig(path: string): Promise<GnlDevConfig> {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  loadDotEnv();
  let mod: any;
  try {
    mod = await import(pathToFileURL(resolve(path)).href);
  } catch (e) {
    // THE FIRST ERROR A NEW PROJECT CAN PRODUCE, and it used to arrive as Node's own sentence:
    // "Cannot find package '@gnldev/durable' imported from …/gnl.config.ts". That is accurate and
    // useless — it names a package the reader never typed, in a file they did not write, and says
    // nothing about the one thing to do. A scaffold that has not been installed yet is not a broken
    // project; it is step two of three.
    const msg = (e as Error).message ?? '';
    const missing = /Cannot find package '([^']+)'/.exec(msg);
    if (missing) {
      const { existsSync } = await import('node:fs');
      const { dirname, join } = await import('node:path');
      const here = dirname(resolve(path));
      const installed = existsSync(join(here, 'node_modules'));
      throw new Error(
        `'${missing[1]}' is not installed, so ${path} cannot be loaded.\n` +
        (installed
          ? `  It is imported by your config but missing from node_modules — add it:  pnpm add ${missing[1]}\n` +
            '  (`gnl add <feature>` writes the dependency for you; a hand-written import does not.)'
          : '  Dependencies have not been installed here yet:  pnpm install'),
      );
    }
    throw e;
  }
  const cfg = mod.default ?? mod.config ?? mod;
  if (!cfg?.journal && !cfg?.storage) throw new Error(`gnl: '${path}' is not a valid gnl.config (storage or journal required).`);
  return cfg as GnlDevConfig;
}
