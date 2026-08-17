// Gnl dev server: REST API (@gnldev/server) + Studio Playground (@gnldev/studio) on a single port.
// All runtime packages (hono, @gnldev/server, @gnldev/durable, @gnldev/studio, @gnldev/auth, @gnldev/memory) are
// Resolved from the TARGET PROJECT (see runtime.ts) — this module itself only has `import type`s of
// Them (erased at compile time), so loading @gnldev/cli's own dist does not pull any runtime in.
import type * as HonoNs from 'hono';
import type * as Server from '@gnldev/server';
import type * as Durable from '@gnldev/durable';
import type * as Studio from '@gnldev/studio';
import type * as StudioAi from '@gnldev/studio/ai';
import type * as Memory from '@gnldev/memory';
import { resolveBind, exposureNotice, isPublishedDevCredential } from './bind.js';
import type { AuthProvider, Cred } from '@gnldev/auth';
import type * as Auth from '@gnldev/auth';
import { devMemoryFactory, devStudioMemory } from './memory.js';
import type { GnlDevConfig } from './config.js';
import { loadAuth, loadDurable, loadHono, loadMemory, loadNodeServer, loadServer, loadStudio, loadStudioAi } from './runtime.js';

/** Runtime modules a dev app needs — all resolved from the project (see runtime.ts). `memory` is only
 *  Loaded when `config.storage` is present (it's an optional feature). */
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
 * From the SAME project as everything else — see runtime.ts) → in a free install, if @gnldev/auth-ee is
 * Missing it silently falls back to free behavior (try/catch).
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
      // FailClosed throws on an invalid license → in strict paid deployments there's no silent boot without premium.
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
  // `.mount()` (unlike the old `.route()` with a Hono sub-app) registers one blanket wildcard route per
  // Call — a `/` mount would swallow every path, including `/studio/*`, if registered first. So the more
  // Specific `/studio` mount MUST be added before the catch-all `/` REST mount.
  if (config.studio !== false) {
    const storage = config.storage;
    if (storage && !rt.memory) throw new Error('gnl: config.storage is set but no @gnldev/memory module was loaded (loadDevRuntime bug)');
    // Dev default: if storage is present, derive memory → Playground conversations automatically become threads.
    const gnl = rt.durable.createGnl({ ...config, ...(storage ? { memoryFactory: config.memoryFactory ?? devMemoryFactory(rt.memory!) } : {}) });
    app.mount(
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
  app.mount('/', rt.server.createRestApi(config, { title: config.title, auth: provider }));
  return app;
}

/** Boot the dev app (Node). `projectDir` = the directory containing the gnl.config that produced `config`. */
export async function serveDev(
  config: GnlDevConfig,
  projectDir: string,
  bindOpts?: { host?: string; allowOpenNetwork?: boolean },
): Promise<void> {
  const rt = await loadDevRuntime(projectDir, config);
  const { serve } = await loadNodeServer(projectDir);
  const provider = await resolveAuthProvider(config, rt.auth, projectDir);
  const app = buildDevApp(config, rt, provider);
  const port = config.port ?? 3000;
  // Previously `serve({ fetch, port })` — with no hostname @hono/node-server binds EVERY interface,
  // While these very lines printed 'localhost'. See bind.ts.
  // A provider whose only credential is one this package used to SHIP is not auth: the value is
  // readable in the registry. Without this, `--host 0.0.0.0` printed "(auth: protected)" while
  // accepting `Bearer admin-dev`. See isPublishedDevCredential.
  const shippedCreds = isPublishedDevCredential([
    (config as { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }).auth?.admin?.token,
    (config as { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }).auth?.viewer?.token,
  ]);
  // The banner said 'protected' whenever a provider existed, so a project still carrying the shipped
  // token was told it was protected by a credential published in the registry. Say what is true.
  const mode = !provider ? 'open' : shippedCreds ? 'shipped dev token — treat as OPEN' : 'protected';
  const bind = resolveBind({
    host: bindOpts?.host,
    authed: !!provider && !shippedCreds,
    allowOpenNetwork: !!bindOpts?.allowOpenNetwork,
    command: 'gnl dev',
  });
  serve({ fetch: app.fetch, port, hostname: bind.hostname }, (info: { port: number }) => {
    console.log(`gnl dev → REST   http://${bind.displayHost}:${info.port}   (auth: ${mode})`);
    console.log(`          OpenAPI http://${bind.displayHost}:${info.port}/openapi.json`);
    if (config.studio !== false) console.log(`          Studio http://${bind.displayHost}:${info.port}/studio   (Playground)`);
    const notice = exposureNotice(bind, !!provider);
    if (notice) console.log(notice);
  });
}
