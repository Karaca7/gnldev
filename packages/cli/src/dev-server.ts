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
import { resolveBind, exposureNotice } from './bind.js';
import type { AuthProvider, Cred } from '@gnldev/auth';
import type * as Auth from '@gnldev/auth';
import { devMemoryFactory, devStudioMemory } from './memory.js';
import type { GnlDevConfig } from './config.js';
import { identityRow } from './protections-view.js';
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
  // `.mount()` (unlike the old `.route()` with a Hono sub-app) registers one blanket wildcard route per
  // call — a `/` mount would swallow every path, including `/studio/*`, if registered first. So the more
  // specific `/studio` mount MUST be added before the catch-all `/` REST mount.
  if (config.studio !== false) {
    const storage = config.storage;
    if (storage && !rt.memory) throw new Error('gnl: config.storage is set but no @gnldev/memory module was loaded (loadDevRuntime bug)');
    // Dev default: if storage is present, derive memory → Playground conversations automatically become threads.
    const gnl = rt.durable.createGnl({ ...config, ...(storage && config.memory !== false ? { memoryFactory: config.memoryFactory ?? devMemoryFactory(rt.memory!) } : {}) });
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
  // `protectionsBanner: false` — serveDev prints the matrix itself, a few lines down, and its copy
  // knows something this one cannot: that the branch above DERIVED a memory store which the project's
  // own src/app.ts does not have. Letting both print would put the less informed block on screen too.
  app.mount('/', rt.server.createRestApi(config, { title: config.title, auth: provider, protectionsBanner: false }));
  return app;
}

/**
 * Is `gnl dev` about to hand this project a memory store its own config does not carry?
 *
 * Mirrors buildDevApp's condition above rather than re-deciding it: memory is derived only when
 * Studio is mounted, storage exists, and the config supplied no factory of its own. Kept next to the
 * derivation so the two cannot drift into disagreeing about what the banner claims.
 */
function devOnlyMemory(config: GnlDevConfig): boolean {
  // `memory: false` is a deliberate opt-out, not an absence: the engine ignores any injected factory
  // when it is set (createGnl resolves memory to `false` outright), so claiming "derived from
  // storage" there would print the one lie this banner exists to prevent — and recommend `gnl add
  // memory` to someone who just said no.
  return config.studio !== false && !!config.storage && !config.memoryFactory && config.memory === undefined;
}

/** Boot the dev app (Node). `projectDir` = the directory containing the gnl.config that produced `config`. */
export async function serveDev(
  config: GnlDevConfig,
  projectDir: string,
  bindOpts?: { host?: string; port?: number; allowOpenNetwork?: boolean },
): Promise<void> {
  const rt = await loadDevRuntime(projectDir, config);
  const { serve } = await loadNodeServer(projectDir);
  const provider = await resolveAuthProvider(config, rt.auth, projectDir);
  const app = buildDevApp(config, rt, provider);
  // --port / PORT wins over the config, so a busy port is fixable without editing a file.
  const port = bindOpts?.port ?? config.port ?? 3000;
  if (bindOpts?.port !== undefined && !Number.isInteger(port)) {
    throw new Error(`gnl dev: --port must be an integer, got '${bindOpts.port}'`);
  }
  // Previously `serve({ fetch, port })` — with no hostname @hono/node-server binds EVERY interface,
  // while these very lines printed 'localhost'. See bind.ts.
  // A provider whose only credential is one this package used to SHIP is not auth: the value is
  // readable in the registry. Without this, `--host 0.0.0.0` printed "(auth: protected)" while
  // accepting `Bearer admin-dev`. The tokens are handed to resolveBind rather than checked here, so
  // the mode banner and the exposure notice below read the SAME answer — they did not, and printed
  // "treat as OPEN" and "(auth: protected)" two lines apart.
  const cfgAuth = (config as { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }).auth;
  const bind = resolveBind({
    host: bindOpts?.host,
    authed: !!provider,
    credentialTokens: [cfgAuth?.admin?.token, cfgAuth?.viewer?.token],
    allowOpenNetwork: !!bindOpts?.allowOpenNetwork,
    command: 'gnl dev',
  });
  const mode = bind.authModeLabel;
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    // EADDRINUSE arrives asynchronously from the listen call, so it surfaced as an unhandled Node
    // internals stack trace inside a hung `tsx watch` — no mention of the port, and nothing to act on.
    if (err?.code === 'EADDRINUSE') {
      console.error(`gnl dev: port ${port} is already in use on ${bind.hostname}.`);
      console.error('  Pass a different one with `gnl dev --port 3001`, set PORT, or stop whatever holds it.');
      process.exit(1);
    }
    throw err;
  });
  serve({ fetch: app.fetch, port, hostname: bind.hostname }, (info: { port: number }) => {
    console.log(`gnl dev → REST   http://${bind.displayHost}:${info.port}   (auth: ${mode})`);
    console.log(`          OpenAPI http://${bind.displayHost}:${info.port}/openapi.json`);
    if (config.studio !== false) console.log(`          Studio http://${bind.displayHost}:${info.port}/studio   (Playground)`);
    const notice = exposureNotice(bind);
    if (notice) console.log(notice);
    // WHAT IS PROTECTING THIS, under the three lines that say where it is listening.
    //
    // The rows are @gnldev/durable's, not a list kept here — the line above about `mode` is the whole
    // argument: this banner once said "protected" because a provider merely EXISTED, and the provider's
    // only credential was one published in the npm tarball. A protection list maintained beside the
    // config it describes says whatever it last said.
    //
    // Two rows this process fills in, because the config cannot:
    //  • identity — `gnl dev` mounts the REST host, whose subject is the authenticated principal when
    //    there is auth and the request body when there is not. Same reading as createRestApi's own.
    //  • memory — marked ─ when buildDevApp derived one. That asymmetry is the single most expensive
    //    thing on this screen: threads work here and quietly do not after deploy.
    //
    // GUARDED, not listed in REQUIRED_DURABLE_EXPORTS. The runtime is resolved from the PROJECT
    // (runtime.ts), so a newer CLI can meet an older @gnldev/durable and call an export that is not
    // there — the exact "X is not a function" the shape check exists to turn into a sentence. But
    // that check is a REFUSAL TO START, and refusing to start `gnl dev` over a banner would be a
    // worse bug than the missing banner. So this one degrades: no matrix, everything else runs.
    if (typeof rt.durable.describeProtections === 'function') console.log(
      rt.durable.formatProtections(
        rt.durable.describeProtections(config, {
          surface: 'gnl dev',
          ...(devOnlyMemory(config) ? { devOnly: { memory: true } } : {}),
          // ONE derivation, shared with `gnl doctor` — see protections-view.ts for why a second copy
          // of this row would be the same bug the matrix exists to fix.
          identity: identityRow(config, bind.authed),
        }),
        { title: '          protections' },
      ).join('\n'),
    );
  });
}
