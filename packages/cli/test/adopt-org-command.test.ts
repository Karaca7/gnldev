// `gnl adopt-org` — the five paths that were driven by hand and nothing else.
//
// This command wraps an IRREVERSIBLE migration: adopting into a mistyped id moves every row under
// `org:<typo>:`, and running it again with the right name fixes nothing, because those rows now carry
// a prefix and count as already-scoped. So the interesting behaviour is all refusal and restraint —
// what it declines to do when it is not sure — and none of that was covered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AdoptIntoOrgResult } from '@gnldev/durable';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));

const { adoptOrgCommand, renderAdoptResult } = await import('../src/commands/adopt-org.js');

const RESULT = (over: Partial<AdoptIntoOrgResult> = {}): AdoptIntoOrgResult => ({
  orgId: 'acme', dryRun: true,
  moved: { runs: 4, memory: 2, vectors: 1, work: 0, cache: 0, meta: 0 },
  alreadyScoped: 0, skippedPlatformKeys: [], ...over,
});

/** A storage whose adoption calls are recorded, so restraint can be asserted rather than inferred. */
function storageSpy(onAdopt?: (id: string, opts?: { dryRun?: boolean }) => void) {
  const calls: Array<{ orgId: string; dryRun: boolean }> = [];
  return {
    calls,
    storage: {
      name: 'in-memory',
      adoptIntoOrg: vi.fn(async (orgId: string, opts?: { dryRun?: boolean }) => {
        calls.push({ orgId, dryRun: opts?.dryRun === true });
        onAdopt?.(orgId, opts);
        return RESULT({ orgId, dryRun: opts?.dryRun === true });
      }),
    },
  };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); loadConfig.mockReset(); });

/** Runs the command with a given argv and TTY state. */
async function run(argv: string[], opts: { tty?: boolean; storage?: unknown } = {}) {
  loadConfig.mockResolvedValue({ storage: opts.storage ?? storageSpy().storage });
  const stdin = process.stdin as unknown as { isTTY: boolean };
  const stdout = process.stdout as unknown as { isTTY: boolean };
  const [inWas, outWas] = [stdin.isTTY, stdout.isTTY];
  stdin.isTTY = stdout.isTTY = opts.tty ?? false;
  try { await adoptOrgCommand.run({ argv }); }
  finally { stdin.isTTY = inWas; stdout.isTTY = outWas; }
}

describe('renderAdoptResult', () => {
  it('says "Would move" for a preview and "Moved" for the real thing', () => {
    expect(renderAdoptResult(RESULT({ dryRun: true }))[0]).toMatch(/Would move 7 row/);
    expect(renderAdoptResult(RESULT({ dryRun: false }))[0]).toMatch(/^Moved 7 row/);
  });

  it('names the target prefix, not just the organization', () => {
    expect(renderAdoptResult(RESULT())[0], 'the operator cannot see where the rows are going')
      .toContain('org:acme:');
  });

  it('lists every store, including the ones that moved nothing', () => {
    const out = renderAdoptResult(RESULT()).join('\n');
    for (const store of ['runs', 'memory', 'vectors', 'work', 'cache', 'meta']) {
      expect(out, `${store} is missing from the report`).toContain(store);
    }
  });

  // The platform keys are the ones whose migration would break the deployment. Counted rather than
  // named, an operator cannot tell `schema_version` from a stray row.
  it('names the platform keys it declined to move', () => {
    const out = renderAdoptResult(RESULT({ skippedPlatformKeys: ['__org__', '__eetoken__', 'schema_version'] })).join('\n');

    expect(out, 'the report does not say what it left at the root').toContain('__org__');
    expect(out).toContain('__eetoken__');
    expect(out, 'schema_version was omitted — the one whose migration makes the store look unversioned')
      .toContain('schema_version');
  });

  it('mentions already-scoped rows only when there are some', () => {
    expect(renderAdoptResult(RESULT({ alreadyScoped: 3 })).join('\n')).toMatch(/already scoped/);
    expect(renderAdoptResult(RESULT({ alreadyScoped: 0 })).join('\n'),
      'a first run reports "already scoped 0", which reads like something was skipped').not.toMatch(/already scoped/);
  });
});

describe('it refuses to guess the organization', () => {
  it('with no id and no terminal, it stops rather than picking one', async () => {
    const spy = storageSpy();
    await expect(run([], { tty: false, storage: spy.storage }),
      'the command chose an organization on its own — the one mistake that cannot be undone')
      .rejects.toThrow(/no organization id/);

    expect(spy.calls, 'it touched the storage before it had an id').toEqual([]);
  });

  /**
   * An EMPTY id must land in the same refusal as a missing one, from whatever source.
   *
   * `askOrgId` already maps a blank prompt answer to `undefined` (`answer || undefined`), so the blank
   * terminal case merges into the test above. The branch that still needs its own cover is an empty id
   * arriving as a POSITIONAL — `ctx.argv.find(a => !a.startsWith('-'))` matches `''` happily — because
   * `''` is what produces `org::`, one shared prefix that every organization would write into.
   *
   * An earlier version of this test mocked `node:readline/promises` to simulate a blank answer. It
   * passed, and it was a decoration: the mock never took effect, so it re-ran the no-TTY path and the
   * mutation that treats `''` as a valid id survived it.
   */
  it('an empty id supplied as an argument is refused, not adopted into org::', async () => {
    const spy = storageSpy();
    await expect(run([''], { tty: false, storage: spy.storage }),
      "an empty organization id reached the storage — every organization would share the `org::` prefix")
      .rejects.toThrow(/no organization id/);

    expect(spy.calls, 'the storage was called with an empty organization id').toEqual([]);
  });

  it('and the refusal says why it will not guess', async () => {
    let message = '';
    await run([], { tty: false }).catch((e: Error) => { message = e.message; });

    expect(message, 'the operator is not told that this is irreversible').toMatch(/cannot be undone/i);
    expect(message, 'the operator is not told how to supply the id').toMatch(/gnl adopt-org acme/);
  });
});

describe('it previews by default', () => {
  it('without --yes it runs the dry run and nothing else', async () => {
    const spy = storageSpy();
    await run(['acme'], { storage: spy.storage });

    expect(spy.calls, 'the command applied the migration without being asked to')
      .toEqual([{ orgId: 'acme', dryRun: true }]);
    expect(logged.join('\n'), 'nothing told the operator this was only a preview').toMatch(/Preview only/);
    expect(logged.join('\n'), 'the operator is not told how to apply it').toMatch(/--yes/);
  });

  it('with --yes it previews and then applies, in that order', async () => {
    const spy = storageSpy();
    await run(['acme', '--yes'], { storage: spy.storage });

    expect(spy.calls, 'the preview was skipped, or the order is wrong')
      .toEqual([{ orgId: 'acme', dryRun: true }, { orgId: 'acme', dryRun: false }]);
    expect(logged.join('\n'), 'it still claims to be a preview after applying').not.toMatch(/Preview only/);
  });

  it('and says the command is safe to repeat', async () => {
    await run(['acme', '--yes']);
    expect(logged.join('\n'), 'an operator cannot tell whether re-running would double-move')
      .toMatch(/again/i);
  });
});

describe('it surfaces the storage\'s own refusals', () => {
  // The registration guard lives in the adapter; the command must not swallow it or reword it into
  // something less alarming.
  it('an unregistered organization stops the command', async () => {
    const storage = {
      name: 'in-memory',
      adoptIntoOrg: vi.fn(async () => { throw new Error("organization 'acmee' is not registered, so adopting…"); }),
    };
    await expect(run(['acmee'], { storage }), 'the typo guard was swallowed by the command')
      .rejects.toThrow(/not registered/);
  });

  it('a journal-only deployment is told it has nothing to migrate', async () => {
    loadConfig.mockResolvedValue({ storage: undefined });
    await expect(adoptOrgCommand.run({ argv: ['acme'] })).rejects.toThrow(/journal-only|needs `storage`/);
  });

  it('an engine without adoptIntoOrg is named, rather than failing on undefined', async () => {
    loadConfig.mockResolvedValue({ storage: { name: 'custom-engine' } });
    await expect(adoptOrgCommand.run({ argv: ['acme'] })).rejects.toThrow(/custom-engine/);
  });
});
