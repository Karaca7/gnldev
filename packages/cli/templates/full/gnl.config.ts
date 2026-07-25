import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { CreateGnlConfig } from '@gnldev/durable';
import { assistant } from './src/model.js';

// gnl dev → REST API + Studio Playground (single port). gnl studio → inspector + playground.
// storage = all store ports (run + memory + ...) → Playground conversations get written to a thread.
// The `assistant` agent charges an order through a durable, argument-idempotent tool — inspect the
// run in Studio, or resume/fork it from the terminal (`gnl run <id>`, `gnl inspect <id> --step N`).
// The config imports only from the project's own runtime (@gnldev/durable) — not from the `gnl` CLI,
// which is an external tool (run via `npx @gnldev/cli` or the local `gnl` bin), never bundled into the app.
export default {
  storage: new SqliteStorage('runs.db'),
  agents: { assistant },
  port: 3000,
  studio: true,
} satisfies CreateGnlConfig & { port?: number; studio?: boolean };
