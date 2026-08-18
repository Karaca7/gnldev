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
});
