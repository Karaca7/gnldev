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
import { flag, flagBool, positionals } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, dim, yellow } from '../ansi.js';

interface Row { inputPer1M: number; outputPer1M: number; cachedInputPer1M?: number }

interface Doc { version: number; models: Record<string, Row>; replace?: boolean; updatedAt?: number }

/**
 * The document as stored, plus the RAW value it came back as.
 *
 * The raw value is the compare-and-set operand. Every adapter compares the SERIALISED form (sqlite
 * `value = ?`, postgres/redis serialize(expected), in-memory stableStringify), so a normalised copy —
 * which is what the object below is, with its defaults filled in — never matches and the CAS always
 * loses. Learned the hard way in run-lock.ts; repeated here so it is not learned twice.
 */
async function readDoc(config: GnlDevConfig, d: typeof Durable): Promise<{ doc: Doc; raw: unknown }> {
  const journal = getJournal(config, d);
  const raw = await (journal as { get?: (k: string) => Promise<unknown> }).get?.(d.PRICING_KEY);
  const asDoc = raw as { version?: number; models?: Record<string, Row>; replace?: boolean; updatedAt?: number } | undefined;
  return {
    // COPIED, not aliased. The callers mutate `doc.models` before writing, and sharing the reference with
    // `raw` mutated the compare-and-set operand too — so `expected` no longer described what is stored
    // and every second write lost its own CAS. The copy keeps `raw` exactly as it came back.
    doc: {
      version: asDoc?.version ?? 1,
      models: { ...(asDoc?.models ?? {}) },
      replace: asDoc?.replace,
      updatedAt: asDoc?.updatedAt,
    },
    raw,
  };
}

async function writeDoc(config: GnlDevConfig, d: typeof Durable, doc: Doc, expected: unknown): Promise<void> {
  const journal = getJournal(config, d) as {
    put?: (k: string, v: unknown) => Promise<void>;
    putIfMatch?: (k: string, expected: unknown, v: unknown) => Promise<boolean>;
    putIfAbsent?: (k: string, v: unknown) => Promise<boolean>;
  };
  if (!journal.put) throw new Error("this journal is read-only — `gnl pricing set` needs a writable journal");
  // The version has to move, or Studio's optimistic lock silently eats this write: Studio loads v3, the
  // CLI saves (still v3), Studio then saves with ifVersion:3, the check passes because nothing moved, and
  // the CLI's change is gone with no conflict reported. A lock that cannot detect the other writer is
  // worse than none, because the UI claims it is protecting you.
  const next = { ...doc, version: doc.version + 1, updatedAt: Date.now() };
  // Compare-and-set for the same reason the version moves at all: this command is read-modify-write, so
  // two `gnl pricing set` runs a second apart silently discarded one of the two edits. A conflict the
  // operator is told about is recoverable; one they are not told about is a price nobody set.
  // Creating the document is a different operation from replacing it: there is no previous value to
  // compare against, and putIfMatch against `undefined` is not a comparison every adapter can make.
  // putIfAbsent is the create-side CAS, and it loses to whoever created it first — which is the same
  // answer, reported the same way.
  if (expected === undefined && typeof journal.putIfAbsent === 'function') {
    const created = await journal.putIfAbsent(d.PRICING_KEY, next);
    if (!created) {
      throw new Error(
        'pricing was created by another writer while this command was running. Nothing was written — ' +
        're-run the command to apply it on top of the current table.',
      );
    }
    return;
  }
  if (expected !== undefined && typeof journal.putIfMatch === 'function') {
    const won = await journal.putIfMatch(d.PRICING_KEY, expected, next);
    if (!won) {
      throw new Error(
        'pricing changed while this command was running (another `gnl pricing` run, or a Studio save). ' +
        'Nothing was written — re-run the command to apply it on top of the current table.',
      );
    }
    return;
  }
  await journal.put.call(journal, d.PRICING_KEY, next);
}

/** A price given on the command line. Rejects anything that would silently price at zero. */
function money(argv: string[], name: string, required: boolean): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) {
    if (!required) return undefined;
    throw new Error(`--${name} is required (USD per 1M tokens, e.g. --${name} 2.5)`);
  }
  // `Number('')`, `Number(' ')` and `Number('\n')` are all 0, so an EMPTY value was accepted and
  // stored as a free model. Zero is a legitimate price — a free tier is real, and rejecting it would
  // report a genuinely free model as unpriced — but it has to be written, not fallen into. An operator
  // whose shell expanded a variable to nothing meant to set a price, and got a model that no ceiling
  // can ever cap.
  if (raw.trim() === '') throw new Error(`--${name} was given an empty value; write a number (0 is allowed, but write it)`);
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
    // Not `argv.filter(a => !a.startsWith('-'))`: that reads a flag's VALUE as a positional, so
    // `pricing set --input 5 --output 10 my-model` priced a model literally named "5" and said it
    // succeeded. See positionals() for why this is shared rather than fixed inline.
    const [sub = 'list', target] = positionals(ctx.argv, ['input', 'output', 'cached', 'in', 'out', 'config']);
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const journal = getJournal(config, d);

    if (sub === 'list') {
      const { doc } = await readDoc(config, d);
      const effective = await d.effectivePricingTable(journal as never);
      const own = new Set(Object.keys(doc.models));
      if (json) {
        console.log(JSON.stringify({
          source: own.size ? (doc.replace ? 'journal (replace)' : 'journal (layered over defaults)') : 'defaults',
          version: doc.version, overrides: doc.models, effective, updatedAt: doc.updatedAt,
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
      const { doc, raw } = await readDoc(config, d);
      const row: Row = {
        inputPer1M: money(ctx.argv, 'input', true)!,
        outputPer1M: money(ctx.argv, 'output', true)!,
      };
      const cached = money(ctx.argv, 'cached', false);
      if (cached !== undefined) row.cachedInputPer1M = cached;
      doc.models[target] = row;
      await writeDoc(config, d, doc, raw);
      if (json) { console.log(JSON.stringify({ set: target, ...row }, null, 2)); return; }
      console.log(`${bold(target)}  in ${row.inputPer1M}  out ${row.outputPer1M}${row.cachedInputPer1M !== undefined ? `  cache ${row.cachedInputPer1M}` : ''}`);
      console.log(dim('check it with: gnl pricing test ' + target + ' --in 1000 --out 1000'));
      return;
    }

    if (sub === 'rm') {
      if (!target) throw new Error('usage: gnl pricing rm <model>');
      const { doc, raw } = await readDoc(config, d);
      if (!(target in doc.models)) {
        if (json) { console.log(JSON.stringify({ removed: null, reason: 'no override for this model' }, null, 2)); return; }
        console.log(dim(`no override for '${target}' — nothing to remove (the shipped table is unaffected either way)`));
        return;
      }
      delete doc.models[target];
      // Under `replace: true` the document IS the whole table, so removing the last row leaves every
      // model unpriced — and an unpriced model costs $0, so this is the one `rm` that silently turns
      // maxCostUsd off for the entire deployment instead of restoring a default. Studio's PUT already
      // refuses `{replace: true, models: {}}` for the same reason; the CLI reached the same state by a
      // different door. Refused rather than auto-cleared, because guessing which the user meant —
      // "price nothing" or "go back to the shipped table" — is not something to guess about money.
      if (doc.replace && Object.keys(doc.models).length === 0) {
        throw new Error(
          `removing '${target}' would leave a replace:true pricing document with no models, which prices ` +
          'EVERY model at $0 and stops maxCostUsd capping anything. Either add another model first, or ' +
          'delete the __pricing__ document to fall back to the table shipped with @gnldev/durable.',
        );
      }
      await writeDoc(config, d, doc, raw);
      // `rm` ignored --json entirely and printed prose, so `gnl pricing rm x --json | jq` failed on a
      // command that had actually succeeded. Every other subcommand honours the flag; a contract that
      // holds for three of four is one a script cannot rely on.
      if (json) { console.log(JSON.stringify({ removed: target, version: doc.version + 1 }, null, 2)); return; }
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
      const { doc } = await readDoc(config, d);
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
      // `priced` on BOTH branches. It appeared only on the unpriced one, so a script writing the
      // obvious `if (!out.priced) alarm()` fired on every model that IS priced — the field was
      // absent, not false. A flag that exists in one shape of a response is worse than no flag.
      if (json) { console.log(JSON.stringify({ model: target, priced: true, matched, source, tokens: { in: inTok, out: outTok, cached: cachedTok }, price, costUsd }, null, 2)); return; }
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
