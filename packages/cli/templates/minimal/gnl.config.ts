import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { CreateGnlConfig } from '@gnldev/durable';
import { assistant } from './src/model.js';

// gnl dev → REST API + Studio Playground (single port). gnl studio → inspector + playground.
// storage = all store ports (run + memory + ...) → Playground conversations get written to a thread.
// The config imports only from the project's own runtime (@gnldev/durable) — not from the `gnl` CLI,
// which is an external tool (run via `npx @gnldev/cli` or the local `gnl` bin), never bundled into the app.
export default {
  storage: new SqliteStorage('runs.db'),
  agents: { assistant },

  // WHAT A REPEATED SIDE EFFECT SHOULD DO. One switch, because the honest answer depends on whether
  // anyone is there to ask — and a tool's own `effectClass` declaration is read ONLY through this:
  // with no profile, a tool that carefully declared itself `transactional` is treated exactly like
  // one that declared nothing.
  //   assistant — a human is on screen, so a repeat can be turned into a question
  //   headless  — nobody is there to ask, so a repeated payment is refused outright (typed → DLQ)
  //   critical  — the above, plus a run lock, input fingerprinting and tombstones
  preset: 'assistant',

  // CONVERSATION MEMORY, and the asymmetry it closes. `gnl dev` DERIVES a memory store from
  // `storage` so the Playground has threads; `src/app.ts` — the file you deploy — does not. So
  // conversations remember on your machine and quietly forget in production. `gnl add memory` writes
  // src/memory.ts; then import it above and uncomment this line.
  // memoryFactory,

  // RETENTION is not scheduled by anything here, deliberately. Runs stay — and a run holds the
  // prompt it was given — until something sweeps them: `gnl sweep --older-than 30d` from cron or
  // your scheduler, or `sweepRuns(storage.runs, { olderThanMs: 30 * 864e5 })` in your own job. One
  // person's data is erased with `purgeResource`, not by waiting.

  port: 3000,
  studio: true,
} satisfies CreateGnlConfig & { port?: number; studio?: boolean };
