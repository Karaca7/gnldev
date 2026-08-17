// Gnl studio [--config gnl.config.ts] [--port 4747] — Studio inspector + Playground.
// Behavior unchanged from the original cli.ts switch-statement version, only moved into the
// Command-module shape. Runtime (@gnldev/durable/@gnldev/studio/@gnldev/memory/@hono/node-server) is resolved
// From the PROJECT (see runtime.ts), not bundled with @gnldev/cli.
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { resolveBind, exposureNotice, isPublishedDevCredential } from '../bind.js';

export const studioCommand: Command = {
  name: 'studio',
  group: 'project',
  summary: 'Studio inspector + Playground',
  usage: 'gnl studio [--config gnl.config.ts] [--port 4747] [--host 127.0.0.1] [--allow-open-network]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const port = Number(flag(ctx.argv, 'port') ?? 4747);
    const { loadConfig } = await import('../config.js');
    const { devMemoryFactory, devStudioMemory } = await import('../memory.js');
    const { loadDurable, loadStudio, loadStudioAi, loadMemory, loadNodeServer, loadAuth, projectDirOf } = await import('../runtime.js');
    const { resolveAuthProvider } = await import('../dev-server.js');
    const config = await loadConfig(configPath);
    const dir = projectDirOf(configPath);
    const [d, studio, studioAi, { serve }] = await Promise.all([loadDurable(dir), loadStudio(dir), loadStudioAi(dir), loadNodeServer(dir)]);
    const storage = config.storage;
    const memory = storage ? await loadMemory(dir) : undefined;
    // Dev default: if storage is present, derive memory → Playground conversations automatically become threads.
    const gnl = d.createGnl({ ...config, ...(storage ? { memoryFactory: config.memoryFactory ?? devMemoryFactory(memory!) } : {}) });
    // `gnl dev` has always resolved an auth provider from config/env; this command simply never did,
    // So its admin surface was open regardless of what the operator had configured.
    const provider = await resolveAuthProvider(config, await loadAuth(dir), dir);
    // A provider whose only credential is one this package used to SHIP is not auth: the value is
    // readable in the registry. Without this, `--host 0.0.0.0` printed "(auth: protected)" while
    // accepting `Bearer admin-dev`. See isPublishedDevCredential.
    const shippedCreds = isPublishedDevCredential([
      (config as { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }).auth?.admin?.token,
      (config as { auth?: { admin?: { token?: string }; viewer?: { token?: string } } }).auth?.viewer?.token,
    ]);
    const bind = resolveBind({
      host: flag(ctx.argv, 'host'),
      authed: !!provider && !shippedCreds,
      allowOpenNetwork: flagBool(ctx.argv, 'allow-open-network'),
      command: 'gnl studio',
    });
    const app = studio.createStudioApp({
      reader: storage ? d.toJournal(storage.runs) : (config.journal as any),
      gnl: studio.createStudioRunner(gnl, { ...config, journal: storage ? storage.runs : config.journal }, { toJsonSchema: studioAi.aiToolSchema }),
      ...(storage ? { memory: devStudioMemory(memory!, storage) } : {}),
      auth: provider,
    });
    serve({ fetch: app.fetch, port, hostname: bind.hostname }, (info: { port: number }) => {
      console.log(`gnl studio → http://${bind.displayHost}:${info.port}   (Playground, auth: ${provider ? 'protected' : 'open'})`);
      const notice = exposureNotice(bind, !!provider);
      if (notice) console.log(notice);
    });
  },
};
