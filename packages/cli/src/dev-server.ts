// gnl dev server: REST API (@gnldev/server) + Studio Playground (@gnldev/studio) on a single port.
// All runtime packages (hono, @gnldev/server, @gnldev/durable, @gnldev/studio, @gnldev/auth, @gnldev/memory) are
// resolved from the TARGET PROJECT (see runtime.ts) — this module itself only has `import type`s of
// them (erased at compile time), so loading @gnldev/cli's own dist does not pull any runtime in.
import type * as HonoNs from 'hono';
import type * as Server from '@gnldev/server';
import type * as Durable from '@gnldev/durable';
import type * as Studio from '@gnldev/studio';
import type * as StudioAi from '@gnldev/studio/ai';
import type * as Memory from '@gnldev/memory';
import type { AuthProvider, Cred } from '@gnldev/auth';
import type * as Auth from '@gnldev/auth';
import { devMemoryFactory, devStudioMemory } from './memory.js';
import type { GnlDevConfig } from './config.js';
import { loadAuth, loadDurable, loadHono, loadMemory, loadNodeServer, loadServer, loadStudio, loadStudioAi } from './runtime.js';

/** Runtime modules a dev app needs — all resolved from the project (see runtime.ts). `memory` is only
 *  loaded when `config.storage` is present (it's an optional feature). */
export interface DevRuntimeModules {
  hono: typeof HonoNs;
  server: typeof Server;
  durable: typeof Durable;
  studio: typeof Studio;
  studioAi: typeof StudioAi;
  auth: typeof Auth;
  memory?: typeof Memory;
}

/** Resolves every runtime module `buildDevApp`/`serveDev` needs, from `projectDir`. */
export async function loadDevRuntime(projectDir: string, config: GnlDevConfig): Promise<DevRuntimeModules> {
  const [hono, server, durable, studio, studioAi, auth] = await Promise.all([
    loadHono(projectDir),
    loadServer(projectDir),
    loadDurable(projectDir),
    loadStudio(projectDir),
    loadStudioAi(projectDir),
    loadAuth(projectDir),
  ]);
  const memory = config.storage ? await loadMemory(projectDir) : undefined;
  return { hono, server, durable, studio, studioAi, auth, memory };
}

/** Credentials for a single role from env: GNL_<ROLE>_TOKEN or GNL_<ROLE>_USER+PASS. */
function credFromEnv(role: 'ADMIN' | 'VIEWER'): Cred | undefined {
  const token = process.env[`GNL_${role}_TOKEN`];
  const user = process.env[`GNL_${role}_USER`];
  const pass = process.env[`GNL_${role}_PASS`];
  return token || (user && pass) ? { token, user, pass } : undefined;
}

/** Free role-based provider (sync): config.auth → env fallback. undefined if no role is set (opt-in). */
function freeAuth(config: GnlDevConfig, auth: typeof Auth): AuthProvider | undefined {
  return auth.roleAuth({
    admin: config.auth?.admin ?? credFromEnv('ADMIN'),
    viewer: config.auth?.viewer ?? credFromEnv('VIEWER'),
  });
}

/**
 * Premium provider if EE is installed + a license is present; free otherwise. Dynamic import (resolved
 * from the SAME project as everything else — see runtime.ts) → in a free install, if @gnldev/auth-ee is
 * missing it silently falls back to free behavior (try/catch).
 */
export async function resolveAuthProvider(config: GnlDevConfig, auth: typeof Auth, projectDir: string): Promise<AuthProvider | undefined> {
  const free = freeAuth(config, auth);
  const license = config.license ?? process.env.GNL_LICENSE_KEY;
  if (license) {
    let ee: { createEnterpriseAuth(opts: { licenseKey?: string; fallback?: AuthProvider; publicKey?: string; failClosed?: boolean }): AuthProvider | undefined } | undefined;
    try {
      const { resolveFromProject } = await import('./runtime.js');
      ee = (await resolveFromProject('@gnldev/auth-ee', projectDir)) as typeof ee;
    } catch {
      // @gnldev/auth-ee is not installed → fall back to free behavior (in strict mode this is also an error).
      if (config.licenseStrict) throw new Error('gnl: license key present but @gnldev/auth-ee is not installed (licenseStrict)');
    }
    if (ee) {
      // failClosed throws on an invalid license → in strict paid deployments there's no silent boot without premium.
      return ee.createEnterpriseAuth({
        licenseKey: license,
        fallback: free,
        publicKey: config.licensePublicKey,
        failClosed: config.licenseStrict,
      });
    }
  }
  return free;
}

/**
 * Combines REST + (optional) Studio Playground into a single Hono app. Separate from serve() → testable.
 * If `auth` is not given, a free provider is derived from config/env (for EE: serveDev → resolveAuthProvider).
 */
export function buildDevApp(config: GnlDevConfig, rt: DevRuntimeModules, auth?: AuthProvider): HonoNs.Hono {
  const provider = auth ?? freeAuth(config, rt.auth);
  const app = new rt.hono.Hono();
  app.route('/', rt.server.createRestApi(config, { title: config.title, auth: provider }));
  if (config.studio !== false) {
    const storage = config.storage;
    if (storage && !rt.memory) throw new Error('gnl: config.storage is set but no @gnldev/memory module was loaded (loadDevRuntime bug)');
    // Dev default: if storage is present, derive memory → Playground conversations automatically become threads.
    const gnl = rt.durable.createGnl({ ...config, ...(storage ? { memoryFactory: config.memoryFactory ?? devMemoryFactory(rt.memory!) } : {}) });
    app.route(
      '/studio',
      rt.studio.createStudioApp({
        reader: storage ? rt.durable.toJournal(storage.runs) : (config.journal as any),
        apiBase: '/studio',
        gnl: rt.studio.createStudioRunner(gnl, { ...config, journal: storage ? storage.runs : config.journal }, { toJsonSchema: rt.studioAi.aiToolSchema }),
        ...(storage ? { memory: devStudioMemory(rt.memory!, storage) } : {}),
        auth: provider,
      }),
    );
  }
  return app;
}

/** Boot the dev app (Node). `projectDir` = the directory containing the gnl.config that produced `config`. */
export async function serveDev(config: GnlDevConfig, projectDir: string): Promise<void> {
  const rt = await loadDevRuntime(projectDir, config);
  const { serve } = await loadNodeServer(projectDir);
  const provider = await resolveAuthProvider(config, rt.auth, projectDir);
  const app = buildDevApp(config, rt, provider);
  const port = config.port ?? 3000;
  const mode = provider ? 'protected' : 'open';
  serve({ fetch: app.fetch, port }, (info: { port: number }) => {
    console.log(`gnl dev → REST   http://localhost:${info.port}   (auth: ${mode})`);
    console.log(`          OpenAPI http://localhost:${info.port}/openapi.json`);
    if (config.studio !== false) console.log(`          Studio http://localhost:${info.port}/studio   (Playground)`);
  });
}
