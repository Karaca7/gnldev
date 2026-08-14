// Gnl studio [--config gnl.config.ts] [--port 4747] — Studio inspector + Playground.
// Behavior unchanged from the original cli.ts switch-statement version, only moved into the
// Command-module shape. Runtime (@gnldev/durable/@gnldev/studio/@gnldev/memory/@hono/node-server) is resolved
// From the PROJECT (see runtime.ts), not bundled with @gnldev/cli.
import type { Command } from './types.js';
import { flag } from '../args.js';

export const studioCommand: Command = {
  name: 'studio',
  group: 'project',
  summary: 'Studio inspector + Playground',
  usage: 'gnl studio [--config gnl.config.ts] [--port 4747]',
  async run(ctx) {
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const port = Number(flag(ctx.argv, 'port') ?? 4747);
    const { loadConfig } = await import('../config.js');
    const { devMemoryFactory, devStudioMemory } = await import('../memory.js');
    const { loadDurable, loadStudio, loadStudioAi, loadMemory, loadNodeServer, projectDirOf } = await import('../runtime.js');
    const config = await loadConfig(configPath);
    const dir = projectDirOf(configPath);
    const [d, studio, studioAi, { serve }] = await Promise.all([loadDurable(dir), loadStudio(dir), loadStudioAi(dir), loadNodeServer(dir)]);
    const storage = config.storage;
    const memory = storage ? await loadMemory(dir) : undefined;
    // Dev default: if storage is present, derive memory → Playground conversations automatically become threads.
    const gnl = d.createGnl({ ...config, ...(storage ? { memoryFactory: config.memoryFactory ?? devMemoryFactory(memory!) } : {}) });
    const app = studio.createStudioApp({
      reader: storage ? d.toJournal(storage.runs) : (config.journal as any),
      gnl: studio.createStudioRunner(gnl, { ...config, journal: storage ? storage.runs : config.journal }, { toJsonSchema: studioAi.aiToolSchema }),
      ...(storage ? { memory: devStudioMemory(memory!, storage) } : {}),
    });
    serve({ fetch: app.fetch, port }, (info: { port: number }) => console.log(`gnl studio → http://localhost:${info.port}   (Playground)`));
  },
};
