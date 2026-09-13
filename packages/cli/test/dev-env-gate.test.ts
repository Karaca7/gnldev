// The bind decision belongs to the command line, and for a while the environment could make it
// instead.
//
// `gnl dev` runs the server in a `tsx watch` child, so the choice travels by env. The parent spread
// `process.env` and overwrote GNL_HOST / GNL_ALLOW_OPEN_NETWORK only when a flag was PASSED — so an
// inherited value decided when no flag was given. Measured: `GNL_HOST=0.0.0.0
// GNL_ALLOW_OPEN_NETWORK=1 gnl dev` bound every interface with a bare command line, and the banner
// then blamed `--allow-open-network` for a decision nobody had made.
//
// `bind.ts` states the intent it broke: the flag exists so the answer is RECORDED in the command line
// rather than assumed. One line in a shell profile or a compose file would have opened every
// subsequent `gnl dev` in that shell. `gnl studio` never read these variables, so this was a leaking
// internal rather than a documented escape hatch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawned: { env: Record<string, string | undefined> }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
    spawned.push({ env: opts.env });
    return { on: () => {}, kill: () => {} };
  },
}));

import { devCommand } from '../src/commands/dev.js';

// Any existing file: the pre-spawn check is about EXISTENCE, and these tests are about env.
const CFG = 'package.json';
const saved = { ...process.env };
beforeEach(() => { spawned.length = 0; });
afterEach(() => { process.env = { ...saved }; });

describe('gnl dev does not let the environment make the bind decision', () => {
  it('an inherited GNL_HOST / GNL_ALLOW_OPEN_NETWORK does not reach the child', async () => {
    process.env.GNL_HOST = '0.0.0.0';
    process.env.GNL_ALLOW_OPEN_NETWORK = '1';
    await devCommand.run({ argv: ['--config', CFG] } as any);

    expect(spawned).toHaveLength(1);
    // Node drops env keys whose value is `undefined` (verified), so an absent flag means an absent
    // variable rather than the string "undefined" — which `resolveBind` would have treated as a host.
    expect(spawned[0]!.env.GNL_HOST, 'an inherited host must not survive').toBeUndefined();
    expect(spawned[0]!.env.GNL_ALLOW_OPEN_NETWORK, 'an inherited acknowledgement must not survive').toBeUndefined();
  });

  it('the flags still travel when they ARE given', async () => {
    await devCommand.run({ argv: ['--config', CFG, '--host', '0.0.0.0', '--allow-open-network'] } as any);
    expect(spawned[0]!.env.GNL_HOST).toBe('0.0.0.0');
    expect(spawned[0]!.env.GNL_ALLOW_OPEN_NETWORK).toBe('1');
  });

  it('a flag beats an inherited value rather than merging with it', async () => {
    process.env.GNL_HOST = '0.0.0.0';
    process.env.GNL_ALLOW_OPEN_NETWORK = '1';
    await devCommand.run({ argv: ['--config', CFG, '--host', '127.0.0.1'] } as any);
    expect(spawned[0]!.env.GNL_HOST).toBe('127.0.0.1');
    // The acknowledgement was inherited, not typed — it must not survive alongside an explicit host.
    expect(spawned[0]!.env.GNL_ALLOW_OPEN_NETWORK).toBeUndefined();
  });

  // PORT is a different case and deliberately kept: `--port` falls back to it by design, because the
  // alternative was editing gnl.config to move off 3000. It carries no security decision.
  it('PORT is still inherited — that fallback is intended', async () => {
    process.env.PORT = '4567';
    await devCommand.run({ argv: ['--config', CFG] } as any);
    expect(spawned[0]!.env.GNL_PORT).toBe('4567');
  });

  it('the rest of the environment is still passed through', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    await devCommand.run({ argv: ['--config', CFG] } as any);
    expect(spawned[0]!.env.OPENAI_API_KEY, 'the child still needs the ordinary environment').toBe('sk-test');
  });
});

// A config path that does not exist is the one startup failure `tsx watch` cannot hold open: there is
// no file to watch, so creating it later triggers nothing — measured, zero reruns — and `gnl dev`
// waited for an event that could never arrive. Every OTHER early failure (syntax error, busy port,
// refused bind) recovers on the next save, which is what a watcher is for, so only this one is
// refused up front.
describe('gnl dev refuses a config that does not exist, before spawning a watcher', () => {
  it('throws with the path it looked at, and never spawns', async () => {
    await expect(devCommand.run({ argv: ['--config', 'definitely-not-here.ts'] } as any))
      .rejects.toThrow(/not found \(looked in .*definitely-not-here\.ts\)/);
    expect(spawned, 'a watcher with nothing to watch is the hang').toHaveLength(0);
  });

  it('an existing config still spawns', async () => {
    // This file is its own fixture — any real path proves the check is about existence, not shape.
    await devCommand.run({ argv: ['--config', CFG] } as any);
    expect(spawned).toHaveLength(1);
  });
});
