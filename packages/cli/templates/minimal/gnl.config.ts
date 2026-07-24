import { SqliteStorage } from '@gnl/durable/sqlite';
import type { CreateGnlConfig } from '@gnl/durable';
import { assistant } from './src/model.js';

// gnl dev → REST API + Studio Playground (single port). gnl studio → inspector + playground.
// storage = all store ports (run + memory + ...) → Playground conversations get written to a thread.
// The config imports only from the project's own runtime (@gnl/durable) — not from the `gnl` CLI,
// which is an external tool (run via `npx @gnl/cli` or the local `gnl` bin), never bundled into the app.
export default {
  storage: new SqliteStorage('runs.db'),
  agents: { assistant },
  port: 3000,
  studio: true,
} satisfies CreateGnlConfig & { port?: number; studio?: boolean };
