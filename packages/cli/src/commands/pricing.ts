// `gnl pricing` — read and edit the price table a spend ceiling actually uses.
//
// DEFAULT_PRICING is compiled into @gnldev/durable. Providers add models and change list prices on
// their own schedule, so that table is stale the day it ships, and a model missing from it prices at
// $0 — which means `maxCostUsd` cannot fire at any threshold. Waiting for us to publish a release is
// the wrong loop for someone whose ceiling is silently not capping anything today.
//
// The journal's `__pricing__` document is the answer, and this is the way to edit it without writing a
// script. `set` layers over the shipped table rather than replacing it (see PricingDoc.replace), so
// adding tomorrow's model cannot un-price gpt-4o as a side effect.
//
// `test` exists because a price nobody has checked is a guess. It prices a hypothetical run against
// the effective table and shows which source answered — the point being to see the number BEFORE a
// real run depends on it.
import type * as Durable from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, dim, yellow } from '../ansi.js';

interface Row { inputPer1M: number; outputPer1M: number; cachedInputPer1M?: number }

/** The document as stored, or an empty one. Never invents `replace`. */
async function readDoc(config: GnlDevConfig, d: typeof Durable): Promise<{ version: number; models: Record<string, Row>; replace?: boolean; updatedAt?: number }> {
  const journal = getJournal(config, d);
  const doc = await (journal as { get?: (k: string) => Promise<unknown> }).get?.(d.PRICING_KEY);
  const asDoc = doc as { version?: number; models?: Record<string, Row>; replace?: boolean; updatedAt?: number } | undefined;
  return { version: asDoc?.version ?? 1, models: asDoc?.models ?? {}, replace: asDoc?.replace, updatedAt: asDoc?.updatedAt };
}

async function writeDoc(config: GnlDevConfig, d: typeof Durable, doc: { version: number; models: Record<string, Row>; replace?: boolean }): Promise<void> {
  const journal = getJournal(config, d);
  const put = (journal as { put?: (k: string, v: unknown) => Promise<void> }).put;
  if (!put) throw new Error("this journal is read-only — `gnl pricing set` needs a writable journal");
  await put.call(journal, d.PRICING_KEY, { ...doc, updatedAt: Date.now() });
}

/** A price given on the command line. Rejects anything that would silently price at zero. */
function money(argv: string[], name: string, required: boolean): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) {
    if (!required) return undefined;
    throw new Error(`--${name} is required (USD per 1M tokens, e.g. --${name} 2.5)`);
  }
  const n = Number(raw);
  // A NaN here would be stored and then quietly produce NaN costs, which compare false against every
  // ceiling — the silent-no-cap failure this whole command exists to prevent.
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number (got: ${raw})`);
  return n;
}

export const pricingCommand: Command = {
  name: 'pricing',
  group: 'operate',
  summary: 'Show or edit the model price table that maxCostUsd uses',
  usage:
    'gnl pricing [list] | set <model> --input <usd> --output <usd> [--cached <usd>] | rm <model> | ' +
    'test <model> --in <tokens> --out <tokens> [--cached <tokens>]  [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const [sub = 'list', target] = ctx.argv.filter((a) => !a.startsWith('-'));
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const journal = getJournal(config, d);

    if (sub === 'list') {
      const doc = await readDoc(config, d);
      const effective = await d.effectivePricingTable(journal as never);
      const own = new Set(Object.keys(doc.models));
      if (json) {
        console.log(JSON.stringify({
          source: own.size ? (doc.replace ? 'journal (replace)' : 'journal (layered over defaults)') : 'defaults',
          overrides: doc.models, effective, updatedAt: doc.updatedAt,
        }, null, 2));
        return;
      }
      const rows = Object.entries(effective).sort(([a], [b]) => a.localeCompare(b));
      console.log(`${bold(String(rows.length))} model(s) priced  ${dim('(USD per 1M tokens)')}`);
      for (const [id, p] of rows) {
        const mark = own.has(id) ? yellow(' ← yours') : '';
        const cached = p.cachedInputPer1M !== undefined ? dim(`  cache ${p.cachedInputPer1M}`) : '';
        console.log(`  ${id.padEnd(34)} in ${String(p.inputPer1M).padStart(8)}   out ${String(p.outputPer1M).padStart(8)}${cached}${mark}`);
      }
      if (!own.size) console.log(dim('\nno overrides — the table shipped with @gnldev/durable is in force'));
      else if (doc.replace) console.log(yellow('\nreplace: true — ONLY your models are priced; everything else counts as $0'));
      return;
    }

    if (sub === 'set') {
      if (!target) throw new Error('usage: gnl pricing set <model> --input <usd> --output <usd> [--cached <usd>]');
      const doc = await readDoc(config, d);
      const row: Row = {
        inputPer1M: money(ctx.argv, 'input', true)!,
        outputPer1M: money(ctx.argv, 'output', true)!,
      };
      const cached = money(ctx.argv, 'cached', false);
      if (cached !== undefined) row.cachedInputPer1M = cached;
      doc.models[target] = row;
      await writeDoc(config, d, doc);
      if (json) { console.log(JSON.stringify({ set: target, ...row }, null, 2)); return; }
      console.log(`${bold(target)}  in ${row.inputPer1M}  out ${row.outputPer1M}${row.cachedInputPer1M !== undefined ? `  cache ${row.cachedInputPer1M}` : ''}`);
      console.log(dim('check it with: gnl pricing test ' + target + ' --in 1000 --out 1000'));
      return;
    }

    if (sub === 'rm') {
      if (!target) throw new Error('usage: gnl pricing rm <model>');
      const doc = await readDoc(config, d);
      if (!(target in doc.models)) {
        console.log(dim(`no override for '${target}' — nothing to remove (the shipped table is unaffected either way)`));
        return;
      }
      delete doc.models[target];
      await writeDoc(config, d, doc);
      console.log(`removed override for ${bold(target)}`);
      return;
    }

    if (sub === 'test') {
      if (!target) throw new Error('usage: gnl pricing test <model> --in <tokens> --out <tokens> [--cached <tokens>]');
      const inTok = Number(flag(ctx.argv, 'in') ?? 1_000_000);
      const outTok = Number(flag(ctx.argv, 'out') ?? 1_000_000);
      const cachedTok = Number(flag(ctx.argv, 'cached') ?? 0);
      if (![inTok, outTok, cachedTok].every((n) => Number.isFinite(n) && n >= 0)) {
        throw new Error('--in/--out/--cached must be non-negative token counts');
      }
      const table = await d.effectivePricingTable(journal as never);
      const price = d.priceFor(target, table);
      const doc = await readDoc(config, d);
      // Which entry answered. `priceFor` matches by LONGEST PREFIX, so a dated id resolves through a
      // shorter key — and a wrong-but-plausible answer (a whole family sharing one price) looks
      // identical to a right one unless the matched key is shown.
      const matched = price
        ? Object.keys(table).filter((k) => target === k || target.startsWith(k)).sort((a, b) => b.length - a.length)[0]
        : undefined;

      if (!price) {
        const out = { model: target, priced: false, costUsd: 0 };
        if (json) { console.log(JSON.stringify(out, null, 2)); return; }
        console.log(yellow(`${target} has NO price.`));
        console.log('A step on this model counts as $0, so maxCostUsd cannot cap it at any threshold.');
        console.log(dim(`fix: gnl pricing set ${target} --input <usd> --output <usd>`));
        return;
      }
      const costUsd = d.costOf({ inputTokens: inTok, outputTokens: outTok, cachedTokens: cachedTok }, price);
      const source = matched && matched in doc.models ? 'journal override' : 'shipped default';
      if (json) { console.log(JSON.stringify({ model: target, matched, source, tokens: { in: inTok, out: outTok, cached: cachedTok }, price, costUsd }, null, 2)); return; }
      console.log(`${bold(target)}`);
      console.log(`  matched entry : ${matched}${matched !== target ? dim('  (prefix match)') : ''}`);
      console.log(`  price source  : ${source}`);
      console.log(`  rate          : in ${price.inputPer1M} / out ${price.outputPer1M}${price.cachedInputPer1M !== undefined ? ` / cache ${price.cachedInputPer1M}` : ''} per 1M`);
      console.log(`  ${bold('cost')}          : ${bold('$' + costUsd)}   ${dim(`(${inTok} in, ${outTok} out${cachedTok ? `, ${cachedTok} cached` : ''})`)}`);
      return;
    }

    throw new Error(`unknown subcommand '${sub}' — expected list, set, rm or test`);
  },
};
