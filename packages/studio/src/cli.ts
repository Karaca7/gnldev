#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { toJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createStudioApp, type StudioAppOptions } from './server.js';
import { createStudioRunner } from './runner.js';
import { aiToolSchema } from './ai-schema.js';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const db = getArg('db');
const configPath = getArg('config');
const port = Number(getArg('port') ?? 4747);
// Default is loopback-only (audit #2): the Studio CLI opens without auth, so it must not leak onto
// the network unintentionally. Deliberate external access is opted into via --host 0.0.0.0 (or another address).
const host = getArg('host') ?? '127.0.0.1';
const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';

async function main(): Promise<void> {
  let opts: StudioAppOptions;
  if (configPath) {
    // --config: load gnl.config → createGnl + Playground (run agents in the browser / streaming).
    const { pathToFileURL } = await import('node:url');
    const { resolve, dirname, join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const configFile = resolve(configPath);
    const projectDir = dirname(configFile);
    const mod: any = await import(pathToFileURL(configFile).href);
    const cfg = mod.default ?? mod.config ?? mod;
    const { createGnl } = await import('@gnldev/durable');
    // Dev default: if the config has storage, derive memory so Playground conversations become threads —
    // this is what powers the History sidebar (thread list + resume). @gnldev/studio deliberately does NOT
    // depend on @gnldev/memory (it stays lean; memory is optional), so it's resolved dynamically from the
    // PROJECT (the dir gnl.config lives in) — the same "resolved from the project" pattern @gnldev/cli's
    // runtime.ts uses (createRequire from projectDir, NOT from @gnldev/studio's own location, so a real
    // project's `node_modules/@gnldev/memory` is found). Absent/unresolvable → the Playground still runs,
    // just without the thread list (prior behavior, no crash).
    let memory: StudioAppOptions['memory'] | undefined;
    let memoryFactory: ((storage: unknown) => unknown) | undefined;
    if (cfg.storage) {
      const req = createRequire(join(projectDir, 'noop.js'));
      const mem: any = await (async () => {
        try { return await import(pathToFileURL(req.resolve('@gnldev/memory')).href); }
        catch { return undefined; }
      })();
      if (mem?.memoryPreset) {
        const view = mem.memoryPreset(cfg.storage, 'chat');
        memory = {
          listThreads: (rid?: string) => (rid ? view.listThreads({ resourceId: rid }) : view.listAllThreads()),
          getMessages: (tid: string) => view.getMessages(tid),
          getWorkingMemory: (tid: string) => view.getWorkingMemory(tid),
          updateThread: (tid: string, patch: { title?: string; metadata?: Record<string, unknown> }) => view.updateThread(tid, patch),
          deleteThread: (tid: string) => view.deleteThread(tid),
        };
        // createGnl's memoryFactory is what makes Playground RUNS write to a thread (the view above only
        // reads). Respect a user-provided factory in the config; otherwise use the 'chat' preset.
        memoryFactory = cfg.memoryFactory ?? ((storage: unknown) => mem.memoryPreset(storage, 'chat'));
      } else {
        console.warn('gnl studio: config has storage but @gnldev/memory could not be resolved — Playground works, but the thread list/history is off. Install @gnldev/memory in the project to enable it.');
      }
    }
    const gnl = createGnl(memoryFactory ? { ...cfg, memoryFactory } : cfg);
    const reader = cfg.storage ? toJournal(cfg.storage.runs) : cfg.journal;
    opts = {
      reader,
      gnl: createStudioRunner(gnl, { ...cfg, journal: cfg.storage?.runs ?? cfg.journal }, { toJsonSchema: aiToolSchema }),
      ...(memory ? { memory } : {}),
    };
  } else {
    if (!db || db.startsWith('--')) {
      console.error('Usage: gnl-studio --db <runs.db> [--port 4747] [--host 127.0.0.1]   (inspector)');
      console.error('    or: gnl-studio --config <gnl.config.ts> [--port 4747] [--host 127.0.0.1]   (+ Playground)');
      process.exit(1);
      return;
    }
    opts = { reader: toJournal(new SqliteStorage(db).runs) };
  }
  // The CLI doesn't carry auth: open access on loopback is considered deliberate (local machine only).
  // A non-loopback host + NODE_ENV=production → makeGate throws at setup (no silent fail-open, audit #2).
  opts.allowOpenAccess = loopback;
  if (loopback) {
    // Loopback = access from THIS machine only; but on a shared/multi-user machine (e.g. dev server,
    // virtual desktop) other LOCAL users can also reach the panel without auth (audit #3).
    console.warn(
      'gnl studio: loopback host (127.0.0.1/::1/localhost) → panel open without auth. On a shared ' +
      'machine, other local users can also reach it; configure roleAuth via --config to add auth, ' +
      'or restrict access.',
    );
  }
  const app = createStudioApp(opts);
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`gnl studio → http://${loopback ? 'localhost' : host}:${info.port}${configPath ? '   (Playground open)' : `   (db: ${db})`}`);
  });
}

void main();
