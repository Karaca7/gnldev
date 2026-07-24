#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { toJournal } from '@gnl/durable';
import { SqliteStorage } from '@gnl/durable/sqlite';
import { createStudioApp, type StudioAppOptions } from './server.js';
import { createStudioRunner } from './runner.js';
import { aiToolSchema } from './ai-schema.js';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const db = getArg('db');
const configPath = getArg('config');
const port = Number(getArg('port') ?? 4111);
// Default is loopback-only (audit #2): the Studio CLI opens without auth, so it must not leak onto
// the network unintentionally. Deliberate external access is opted into via --host 0.0.0.0 (or another address).
const host = getArg('host') ?? '127.0.0.1';
const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';

async function main(): Promise<void> {
  let opts: StudioAppOptions;
  if (configPath) {
    // --config: load gnl.config → createGnl + Playground (run agents in the browser / streaming).
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    const mod: any = await import(pathToFileURL(resolve(configPath)).href);
    const cfg = mod.default ?? mod.config ?? mod;
    const { createGnl } = await import('@gnl/durable');
    const gnl = createGnl(cfg);
    const reader = cfg.storage ? toJournal(cfg.storage.runs) : cfg.journal;
    opts = { reader, gnl: createStudioRunner(gnl, { ...cfg, journal: cfg.storage?.runs ?? cfg.journal }, { toJsonSchema: aiToolSchema }) };
  } else {
    if (!db || db.startsWith('--')) {
      console.error('Usage: gnl-studio --db <runs.db> [--port 4111] [--host 127.0.0.1]   (inspector)');
      console.error('    or: gnl-studio --config <gnl.config.ts> [--port 4111] [--host 127.0.0.1]   (+ Playground)');
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
