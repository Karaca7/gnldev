// gnl.config convention: defineConfig (type helper) + loadConfig (dynamic loader).
import type { CreateGnlConfig } from '@gnl/durable';
import type { Cred } from '@gnl/auth';

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
  auth?: { admin?: Cred; viewer?: Cred };
  /** Paid @gnl/auth-ee license key (or GNL_LICENSE_KEY env). If installed, the premium provider takes over. */
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
