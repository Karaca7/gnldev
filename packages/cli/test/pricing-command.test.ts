// `gnl pricing` through the real plumbing: a temp gnl.config.ts, the real loadConfig, the actual
// Command.run() including its argument parsing and --json contract.
//
// The command exists because DEFAULT_PRICING is compiled into @gnldev/durable and providers change
// prices on their own schedule. A model missing from that table prices at $0, and a $0 step cannot
// exceed any maxCostUsd — so the ceiling stops capping without failing. Editing the journal's
// `__pricing__` document is the way out that does not require us to publish a release; this is the way
// to edit it without writing a script.
//
// The assertions that matter are the ones about NOT breaking things: that setting one model leaves
// every other price intact, and that `test` reports which entry answered — because `priceFor` matches
// by longest prefix, so a whole model family can silently share one price and the wrong answer looks
// exactly like the right one.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pricingCommand } from '../src/commands/pricing.js';
import { captureLog } from './helpers.js';

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project whose journal survives across command invocations in one test (module-level singleton). */
function writeFixtureConfig(): string {
  const dir = mkdtempSync(join(__dirname, '.tmp-pricing-'));
  created.push(dir);
  const cfgPath = join(dir, 'gnl.config.ts');
  writeFileSync(cfgPath, `
import { InMemoryJournal } from '@gnldev/durable';
const journal = new InMemoryJournal();
export default { journal };
`);
  return cfgPath;
}

const run = (cfgPath: string, ...argv: string[]) =>
  captureLog(async () => { await pricingCommand.run({ argv: [...argv, '--config', cfgPath] }); });

const json = (lines: string[]) => JSON.parse(lines.join('\n'));

describe('gnl pricing', () => {
  it('list starts from the shipped table and says so', async () => {
    const cfg = writeFixtureConfig();
    const out = json(await run(cfg, 'list', '--json'));
    expect(out.source).toBe('defaults');
    expect(out.overrides).toEqual({});
    expect(out.effective['gpt-4o'].inputPer1M).toBe(2.5);
  });

  it('set adds a model the shipped table has never heard of', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'acme/new-model', '--input', '10', '--output', '30');

    const out = json(await run(cfg, 'list', '--json'));
    expect(out.overrides['acme/new-model']).toEqual({ inputPer1M: 10, outputPer1M: 30 });
    expect(out.source).toContain('layered');
  });

  it('setting one model does NOT un-price the rest', async () => {
    // The document used to REPLACE the shipped table. Through this command that would mean: add
    // tomorrow's model, and gpt-4o silently starts counting as $0 — a ceiling that stops capping as a
    // side effect of fixing a ceiling.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'acme/new-model', '--input', '10', '--output', '30');

    const out = json(await run(cfg, 'list', '--json'));
    expect(out.effective['gpt-4o'].inputPer1M, 'gpt-4o lost its price').toBe(2.5);
    expect(out.effective['claude-opus-4'].inputPer1M).toBe(15);
  });

  it('test prices a hypothetical run and names the entry that answered', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'acme/new-model', '--input', '10', '--output', '30');

    const out = json(await run(cfg, 'test', 'acme/new-model', '--in', '1000000', '--out', '1000000', '--json'));
    expect(out.costUsd).toBe(40);
    expect(out.source).toBe('journal override');
    expect(out.matched).toBe('acme/new-model');
  });

  it('test reveals a PREFIX match rather than presenting it as exact', async () => {
    // `claude-opus-4-5-20251101` resolves through the `claude-opus-4-5` key. Showing the matched entry
    // is the difference between "this model is priced" and "something that starts like it is priced" —
    // the shape that had Opus 4 billed at Opus 4.5's rate, a third of the real one.
    const cfg = writeFixtureConfig();
    const out = json(await run(cfg, 'test', 'claude-opus-4-5-20251101', '--in', '1000000', '--out', '1000000', '--json'));
    expect(out.matched).toBe('claude-opus-4-5');
    expect(out.source).toBe('shipped default');
    expect(out.costUsd).toBe(30); // $5 in + $25 out
  });

  it('test says plainly when a model has no price at all', async () => {
    const cfg = writeFixtureConfig();
    const out = json(await run(cfg, 'test', 'nobody/prices-this', '--in', '1000', '--out', '1000', '--json'));
    expect(out.priced).toBe(false);
    expect(out.costUsd).toBe(0);
  });

  it('rm removes an override and leaves the shipped table alone', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'gpt-4o', '--input', '999', '--output', '999');
    expect(json(await run(cfg, 'list', '--json')).effective['gpt-4o'].inputPer1M).toBe(999);

    await run(cfg, 'rm', 'gpt-4o');
    expect(json(await run(cfg, 'list', '--json')).effective['gpt-4o'].inputPer1M).toBe(2.5);
  });

  it('refuses a price that would silently become NaN', async () => {
    // A NaN price is stored, produces NaN costs, and NaN > limit is false — the ceiling stops capping
    // and nothing errors. Rejecting at the edge is the only place this stays visible.
    const cfg = writeFixtureConfig();
    await expect(run(cfg, 'set', 'x/y', '--input', 'abc', '--output', '1')).rejects.toThrow(/non-negative number/);
    await expect(run(cfg, 'set', 'x/y', '--input', '-1', '--output', '1')).rejects.toThrow(/non-negative number/);
  });

  it('set requires both directions rather than defaulting one to zero', async () => {
    const cfg = writeFixtureConfig();
    await expect(run(cfg, 'set', 'x/y', '--input', '1')).rejects.toThrow(/--output is required/);
  });

  it('a write moves the version, so Studio\'s optimistic lock can see it', async () => {
    // Without this, two editors silently clobber each other: Studio loads v3, the CLI saves (still v3),
    // Studio saves with ifVersion:3 and the check passes because nothing moved. The CLI's change is gone
    // and no conflict is reported — a lock that cannot detect the other writer, which is worse than no
    // lock because the UI says it is protecting you.
    const cfg = writeFixtureConfig();
    const v0 = json(await run(cfg, 'list', '--json')).version ?? 0;
    await run(cfg, 'set', 'a/b', '--input', '1', '--output', '2');
    const v1 = json(await run(cfg, 'list', '--json')).version;
    expect(v1, 'the CLI wrote without moving the version').toBeGreaterThan(v0);

    await run(cfg, 'set', 'c/d', '--input', '1', '--output', '2');
    expect(json(await run(cfg, 'list', '--json')).version).toBeGreaterThan(v1);
  });

  it('rm moves the version too — a removal is a change another editor must notice', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'a/b', '--input', '1', '--output', '2');
    const v = json(await run(cfg, 'list', '--json')).version;
    await run(cfg, 'rm', 'a/b');
    expect(json(await run(cfg, 'list', '--json')).version).toBeGreaterThan(v);
  });

  it('refuses a write that would clobber another writer, instead of silently winning', async () => {
    // Read-modify-write with no compare-and-set: two `gnl pricing set` runs a second apart discarded one
    // of the two edits, with both reporting success. A conflict the operator is told about is
    // recoverable; a price nobody set is not.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'a/b', '--input', '1', '--output', '2');

    // Simulate the other writer landing between this command's read and its write, by writing straight
    // to the journal the command is about to compare against.
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig(cfg);
    const j = (config as { journal: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> } }).journal;
    const current = await j.get('__pricing__') as { version: number; models: Record<string, unknown> };
    await j.put('__pricing__', { ...current, version: current.version + 1, models: { ...current.models, 'other/admin': { inputPer1M: 9, outputPer1M: 9 } } });

    // The command re-reads, so to force the race the stale operand has to be what it compares with —
    // which is exactly what happens when two processes overlap. Here the second write simply has to
    // notice it is not the only writer.
    await run(cfg, 'set', 'c/d', '--input', '3', '--output', '4');
    const out = json(await run(cfg, 'list', '--json'));
    expect(out.overrides['other/admin'], 'the other writer\'s row was discarded').toBeDefined();
    expect(out.overrides['c/d'], 'this write was lost').toBeDefined();
  });

  it('a genuinely concurrent write is reported, not swallowed', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'a/b', '--input', '1', '--output', '2');

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig(cfg);
    const j = (config as { journal: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> } }).journal;

    // Move the document out from under the command AFTER it reads: patch get() to write once, on the way
    // out, which is the shape of a real overlap.
    const realGet = j.get.bind(j);
    let armed = true;
    j.get = async (k: string) => {
      const v = await realGet(k);
      if (armed && k === '__pricing__') {
        armed = false;
        const cur = v as { version: number; models: Record<string, unknown> };
        await j.put('__pricing__', { ...cur, version: cur.version + 1, models: { ...cur.models, sneaky: { inputPer1M: 1, outputPer1M: 1 } } });
      }
      return v;
    };

    await expect(run(cfg, 'set', 'e/f', '--input', '5', '--output', '6')).rejects.toThrow(/changed while this command was running/);
    j.get = realGet;

    // And nothing of this command's landed — the refusal is before the write.
    expect(json(await run(cfg, 'list', '--json')).overrides['e/f']).toBeUndefined();
  });

  it('reads the model name even when the flags come FIRST', async () => {
    // The positionals were taken with `argv.filter(a => !a.startsWith('-'))`, which counts a flag's
    // VALUE as a positional. So this exact invocation priced a model literally named "5": the command
    // printed success, the table gained a junk row, and `acme/flags-first` — the model the user was
    // trying to price — stayed unpriced. For a pricing table that means maxCostUsd goes on not capping
    // the very model they just tried to fix, and nothing anywhere said so.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', '--input', '5', '--output', '10', 'acme/flags-first');

    const out = json(await run(cfg, 'list', '--json'));
    expect(out.overrides['acme/flags-first'], 'the model name was read from a flag value').toEqual({ inputPer1M: 5, outputPer1M: 10 });
    expect(Object.keys(out.overrides), 'a model named after a flag value was created').toEqual(['acme/flags-first']);
  });

  it('refuses the rm that would leave a replace:true table with nothing priced', async () => {
    // `replace: true` means the document IS the table, so removing the last row prices EVERY model at
    // $0 — and $0 cannot exceed any ceiling. This is the one `rm` that turns maxCostUsd off for the
    // whole deployment rather than restoring a default, and it looked like every other rm.
    // Studio's PUT already refuses `{replace: true, models: {}}`; the CLI reached the same state by a
    // different door, which is the recurring shape of these: one rule, two call sites, one of them
    // never told.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'only/model', '--input', '1', '--output', '1');
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig(cfg);
    const j = (config as { journal: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> } }).journal;
    const cur = await j.get('__pricing__') as Record<string, unknown>;
    await j.put('__pricing__', { ...cur, replace: true });

    await expect(run(cfg, 'rm', 'only/model')).rejects.toThrow(/prices EVERY model at \$0/);
    // And the row is still there — the refusal happens before the write, not after a partial one.
    expect(json(await run(cfg, 'list', '--json')).overrides['only/model']).toEqual({ inputPer1M: 1, outputPer1M: 1 });
  });

  it('a NON-replace document may be emptied — that restores the shipped table, it does not erase it', async () => {
    // The other direction, so the refusal above cannot be read as "rm of a last row is forbidden".
    // Without `replace`, the document layers over DEFAULT_PRICING, so removing the last override hands
    // pricing back to the shipped table. That is a return to the default, not a table of zeros.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'only/model', '--input', '1', '--output', '1');
    await run(cfg, 'rm', 'only/model');

    const out = json(await run(cfg, 'list', '--json'));
    expect(out.overrides).toEqual({});
    expect(out.effective['gpt-4o'].inputPer1M, 'emptying a layered document unpriced the shipped table').toBe(2.5);
  });
});

// An empty value is not a price.
//
// `Number('')`, `Number(' ')` and `Number('\n')` are all 0, so `--input ""` was accepted and stored as
// a free model. Zero is a legitimate price — a free tier is real, and rejecting it would report a
// genuinely free model as unpriced — but it has to be WRITTEN. An operator whose shell expanded a
// variable to nothing meant to set a price and got a model no ceiling can cap.
describe('gnl pricing set — the value must be a number', () => {
  it.each(['', ' ', '\n'])('refuses %j instead of storing it as free', async (bad) => {
    const cfg = writeFixtureConfig();
    await expect(run(cfg, 'set', 'a/b', '--input', bad as string, '--output', '1'))
      .rejects.toThrow(/empty value/);
  });

  it('still accepts an explicit zero, because a free model is real', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'free/model', '--input', '0', '--output', '0');
    expect(json(await run(cfg, 'list', '--json')).overrides['free/model'])
      .toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it('still refuses a non-number and a negative', async () => {
    const cfg = writeFixtureConfig();
    await expect(run(cfg, 'set', 'a/b', '--input', 'abc', '--output', '1')).rejects.toThrow(/non-negative number/);
    await expect(run(cfg, 'set', 'a/b', '--input', '-1', '--output', '1')).rejects.toThrow(/non-negative number/);
  });
});

// A short override is a PREFIX rule, and the listing has to show it as one of yours.
//
// `priceFor` matches by longest prefix, so `set claude` prices every claude-* model at once. That is a
// real feature — DEFAULT_PRICING itself is keyed that way — and the risk is only that a rule with this
// much reach is invisible in the listing. Measured rather than assumed: the effective table is
// `{...DEFAULT_PRICING, ...doc.models}`, so an override key is in it whatever its shape.
describe('gnl pricing list — a prefix override', () => {
  it('appears in the listing and is marked as the operator\'s own', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'claude', '--input', '99', '--output', '99');

    const out = json(await run(cfg, 'list', '--json'));
    expect(out.overrides.claude, 'the override was not recorded').toEqual({ inputPer1M: 99, outputPer1M: 99 });
    expect(out.effective.claude, 'a prefix override is missing from the effective table').toEqual({ inputPer1M: 99, outputPer1M: 99 });

    const human = (await run(cfg, 'list')).join('\n');
    expect(human, 'a rule that reprices a whole family was not marked as yours').toMatch(/claude.*← yours/);
  });

  it('answers for a family member the shipped table has never heard of', async () => {
    // The consequence, not just the display. Note WHICH member: `claude-opus-4` is an exact key in
    // DEFAULT_PRICING and exact beats prefix, so a prefix rule does not touch it — the first version of
    // this test asserted otherwise and was wrong about the code, not the other way round. A model with
    // no exact entry is where the rule actually applies, and is the reason someone writes one.
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'claude', '--input', '99', '--output', '99');

    const t = json(await run(cfg, 'test', 'claude-experimental-9', '--in', '1000000', '--out', '0', '--json'));
    expect(t.matched, 'the prefix rule did not answer for an unknown family member').toBe('claude');
    expect(t.costUsd).toBe(99);

    // ...and it leaves an exactly-keyed sibling alone.
    const exact = json(await run(cfg, 'test', 'claude-opus-4', '--in', '1000000', '--out', '0', '--json'));
    expect(exact.matched, 'the prefix rule swallowed a model that has its own entry').toBe('claude-opus-4');
  });
});

// The --json contract has to hold for every subcommand and every branch.
//
// `test --json` carried `priced: false` on the unpriced branch and NO `priced` field at all on the
// priced one, so the obvious script — `if (!out.priced) alarm()` — fired on every model that is
// correctly priced. A flag present in one shape of a response is worse than no flag: it invites the
// check that misreads it. And `rm` ignored --json entirely and printed prose, so
// `gnl pricing rm x --json | jq` failed on a command that had succeeded.
describe('gnl pricing --json', () => {
  it('reports `priced` on the PRICED branch too, not only the unpriced one', async () => {
    const cfg = writeFixtureConfig();
    const priced = json(await run(cfg, 'test', 'gpt-4o', '--in', '1000', '--out', '0', '--json'));
    const unpriced = json(await run(cfg, 'test', 'nobody/prices-this', '--in', '1000', '--out', '0', '--json'));

    expect(priced.priced, 'a priced model answered with no `priced` field').toBe(true);
    expect(unpriced.priced).toBe(false);
    // The check a script actually writes now works in both directions.
    expect([priced, unpriced].filter((o) => !o.priced)).toHaveLength(1);
  });

  it('rm honours --json when it removes something', async () => {
    const cfg = writeFixtureConfig();
    await run(cfg, 'set', 'a/b', '--input', '1', '--output', '2');
    const out = json(await run(cfg, 'rm', 'a/b', '--json'));
    expect(out.removed).toBe('a/b');
    expect(typeof out.version, 'the new version is what a script needs to keep an optimistic lock').toBe('number');
  });

  it('rm honours --json when there is nothing to remove', async () => {
    // The no-op branch printed prose too. A script piping this into jq broke on the ordinary case of
    // removing something twice.
    const cfg = writeFixtureConfig();
    const out = json(await run(cfg, 'rm', 'never/existed', '--json'));
    expect(out.removed).toBeNull();
    expect(out.reason).toMatch(/no override/);
  });
});
