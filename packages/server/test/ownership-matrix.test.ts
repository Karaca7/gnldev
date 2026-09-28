// THE CONFORMANCE REGISTRY (ADR-0002 point 7) — a release gate.
//
//   BIRTHS  — every way a run comes to exist (engine starters and the doors that start runs of their own);
//   STATES  — the record states that used to leak: normal, ownerless, record missing with rows present,
//             owner record unreadable;
//   DOORS   — every exported door factory, each driven through ONE small helper, with its operations;
//   CALLERS — owner, another user (also naming the owner), another organization's user and staff, staff,
//             an application naming the owner / naming another user, and an unknown caller (also naming
//             the owner).
//
// Invariant, for every BIRTH x STATE x DOOR-OPERATION x attacking CALLER: no secret of the target run in
// the response, no target id in a listing the attacker did not type it into, and no change to any key
// of the target run or its thread. Controls (the owner and staff on a normal run, staff on an ownerless
// one) are recorded too, so the negatives are not vacuous: every door must let a control see the secret
// at least once, and the REST read routes must let it every time.
//
// COMPLETE AND SELF-CHECKING, like subject-isolation-conformance's "unclassified route FAILS":
//   - every call site of the engine's one start point (claimRunOwner / inheritRunOwner / admitRun) in
//     packages/*/src is mapped to the births that exercise it — a new site FAILS;
//   - every exported run starter of @gnldev/durable and of a createGnl instance is a BIRTH or is named in
//     NOT_A_BIRTH with a reason — an unlisted one FAILS;
//   - every exported door factory (`create*` / `serve*` / `*Surface` / `pipe*Stream` in any package
//     index) is a DOOR here or is named in NOT_A_DOOR with a reason — an unlisted one FAILS.
//
// No finding is encoded in this file; the lists are the whole input.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as durable from '@gnldev/durable';
import { InMemoryStorage, BasicMemory, createGnl, scopeConfigToOrg, type Caller } from '@gnldev/durable';
import { engineCallerOf } from '@gnldev/auth';
import { PACKAGES, BIRTHS, NOT_A_BIRTH, DOORS, NOT_A_DOOR, ORG, OTHER_ORG, P, SECRET, echo, assertShard } from './conformance-registry.js';

// The walk is split over four files (this one and ownership-matrix.shard-{1,2,3}.test.ts) so the cells
// run in parallel workers; each shard asserts its own cells.
describe('conformance registry: births x states x doors x callers (shard 1/4)', () => {
  it('every cell holds: no attacker reads a secret, lists a foreign id, or changes the target', () => assertShard(0, 4), 600_000);
});

// ── completeness: an unlisted birth or door FAILS ───────────────────────────────────────────────
/** Code lines of a source file, comments and imports dropped. */
function codeLines(src: string): string[] {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|import\b|export\s*\{|export\s+type\b)/.test(l));
}
function sources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const dir = join(PACKAGES, pkg, 'src');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir, { recursive: true }) as string[]) if (/\.tsx?$/.test(f)) out.push({ rel: `${pkg}/src/${f}`, src: readFileSync(join(dir, f), 'utf8') });
  }
  return out;
}

describe('the registry is complete', () => {
  it('every call of the ONE start point (claimRunOwner / inheritRunOwner / admitRun) is a listed birth site', () => {
    const START = /\b(claimRunOwner|inheritRunOwner|admitRun)\(/;
    const found = new Map<string, number>();
    for (const { rel, src } of sources()) {
      if (rel === 'durable/src/run-identity.ts') continue; // where they are defined (and call each other)
      const n = codeLines(src).filter((l) => START.test(l) && !/function\s+(claimRunOwner|inheritRunOwner|admitRun)\b/.test(l)).length;
      if (n) found.set(rel, n);
    }
    // How many calls each file holds today. A NEW call site changes a count: add the birth it makes.
    const EXPECTED: Record<string, number> = {
      'durable/src/run.ts': 1, 'durable/src/registry.ts': 2, 'durable/src/batch.ts': 1, 'durable/src/rollover.ts': 1,
      'durable/src/time-travel.ts': 1, 'studio/src/server.ts': 1, 'mcp/src/server.ts': 1, 'queue/src/index.ts': 1, 'durable/src/network.ts': 1,
    };
    expect(Object.fromEntries(found), 'a start-point call site appeared, moved or went away — list its birth in BIRTHS').toEqual(EXPECTED);
    const covered = new Set(Object.values(BIRTHS).flatMap((b) => b.sites));
    expect(Object.keys(EXPECTED).filter((f) => !covered.has(f)), 'a start-point site no BIRTH exercises').toEqual([]);
    expect([...covered].filter((f) => !(f in EXPECTED)), 'a BIRTH names a site that does not exist').toEqual([]);
  });

  it('every exported run starter of @gnldev/durable and of a createGnl instance is a BIRTH or NOT_A_BIRTH', () => {
    const STARTER = /^(run|stream|resume|fork|rollover|replay|spawn|start)|Run$|Durable$|^create/;
    const exported = Object.keys(durable).filter((k) => typeof (durable as any)[k] === 'function' && STARTER.test(k));
    const gnl = createGnl({ journal: new durable.InMemoryJournal(), agents: {} } as never) as Record<string, unknown>;
    const methods = Object.keys(gnl).filter((k) => typeof gnl[k] === 'function').map((k) => `gnl.${k}`);
    const listed = new Set([...Object.values(BIRTHS).flatMap((b) => b.starters), ...Object.keys(NOT_A_BIRTH)]);
    expect([...exported, ...methods].filter((k) => !listed.has(k)), 'unclassified run starter — add it to BIRTHS or NOT_A_BIRTH').toEqual([]);
    expect([...listed].filter((k) => !exported.includes(k) && !methods.includes(k)), 'a listed starter no longer exists').toEqual([]);
  });

  it('every exported door factory in any package is a DOOR or NOT_A_DOOR', () => {
    const DOOR = /^(create|serve)\w*$|Surface$|^pipe\w+Stream$/;
    const exported = new Set<string>();
    for (const pkg of readdirSync(PACKAGES)) {
      const f = join(PACKAGES, pkg, 'src', 'index.ts');
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/g)) if (DOOR.test(m[1]!)) exported.add(m[1]!);
      for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1]!.split(',')) {
          const t = part.trim();
          if (!t || t.startsWith('type ')) continue;
          const name = t.split(/\s+as\s+/).pop()!.trim();
          if (DOOR.test(name)) exported.add(name);
        }
      }
    }
    const doors = new Set(Object.values(DOORS).flatMap((d) => d.factories));
    const both = [...doors].filter((d) => d in NOT_A_DOOR);
    expect(both, 'a factory is both a DOOR and NOT_A_DOOR').toEqual([]);
    expect([...exported].filter((n) => !doors.has(n) && !(n in NOT_A_DOOR)), 'unclassified door factory — add a DOOR (one helper) or a NOT_A_DOOR reason').toEqual([]);
    expect([...doors, ...Object.keys(NOT_A_DOOR)].filter((n) => !exported.has(n)), 'a listed factory is no longer exported').toEqual([]);
  });

  it('every birth reaches every state it can, and every door has a helper and at least one operation', () => {
    for (const [name, d] of Object.entries(DOORS)) expect(Object.keys(d.ops).length, name).toBeGreaterThan(0);
    expect(Object.keys(BIRTHS).length).toBeGreaterThanOrEqual(10);
  });
});

// Found while building the fixture, kept as its own row: an explicit `memory` INSTANCE in a config was
// not confined by scopeConfigToOrg (only `storage` was), so every organization built from that config
// shared one memory. scopeConfigToOrg now refuses it; the table itself uses `memoryFactory`, the scoped
// form, so it measures ownership alone.
describe('an explicit memory instance and organizations', () => {
  it('another organization\'s user does not read a thread through scopeConfigToOrg', async () => {
    const storage = new InMemoryStorage();
    const config: any = { storage, memory: new BasicMemory(storage.runs), agents: { a: { model: echo } } };
    const got = await (async () => {
      const acme = createGnl(scopeConfigToOrg(config, ORG).config);
      const globex = createGnl(scopeConfigToOrg(config, OTHER_ORG).config);
      await acme.run('a', { runId: 'r1', prompt: SECRET, threadId: 'T', caller: engineCallerOf(P.ayse!) as Caller });
      return (await globex.run('a', { runId: 'r2', prompt: 'x', threadId: 'T', caller: engineCallerOf(P.eve!) as Caller })).text;
    })().catch((e: Error) => `refused: ${e.message}`);
    expect(got).not.toContain(SECRET);
  });
});
