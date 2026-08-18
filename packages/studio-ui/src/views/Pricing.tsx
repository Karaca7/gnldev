import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Calculator } from 'lucide-react';
import { usePricing, api, errMessage, ApiError, type ModelPrice } from '../api';
import { Spinner, Empty, Badge, Btn, ErrorBox, PageHeader, cn } from '../components';
import { toast } from '../ui';
import '../i18n';

/**
 * The price table a spend ceiling reads.
 *
 * DEFAULT_PRICING is compiled into @gnldev/durable, so it is stale the day it ships and knows nothing
 * about a model released last week. An unpriced model counts as $0, and a $0 step cannot exceed any
 * `maxCostUsd` — so the ceiling stops capping without ever failing. Editing the journal's `__pricing__`
 * document is the fix that does not require waiting for a release; this screen is how you do it.
 *
 * Two things this deliberately shows that a plain settings form would not:
 *
 *  - the EFFECTIVE table, not just your overrides. The document layers over the shipped defaults, so a
 *    screen listing only your own rows would hide the prices most runs are actually billed at.
 *  - which entry a model id RESOLVES to. `priceFor` matches by longest prefix, so `claude-opus-4-5-2025…`
 *    is answered by the `claude-opus-4-5` row — and a whole family silently sharing one price looks
 *    exactly like a correct answer. That is not hypothetical: one row covering every `claude-opus-4*`
 *    billed Opus 4 at Opus 4.5's rate, a third of the real one, in the one number a limit reads.
 */

/** The same longest-prefix rule `priceFor` uses, so the preview cannot disagree with the runtime. */
function resolveEntry(modelId: string, table: Record<string, ModelPrice>): string | undefined {
  if (table[modelId]) return modelId;
  return Object.keys(table)
    .filter((k) => modelId.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
}

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n < 0.01 ? 4 : 2));

/** Price a hypothetical run, so a number can be checked before a real run depends on it. */
function CostPreview({ table }: { table: Record<string, ModelPrice> }) {
  const [modelId, setModelId] = useState('');
  const [inTok, setInTok] = useState('1000000');
  const [outTok, setOutTok] = useState('1000000');

  const result = useMemo(() => {
    if (!modelId.trim()) return null;
    const matched = resolveEntry(modelId.trim(), table);
    if (!matched) return { matched: undefined as string | undefined, cost: 0, price: undefined };
    const p = table[matched];
    const i = Number(inTok) || 0;
    const o = Number(outTok) || 0;
    return { matched, price: p, cost: (i / 1e6) * p.inputPer1M + (o / 1e6) * p.outputPer1M };
  }, [modelId, inTok, outTok, table]);

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-2">
        <Calculator className="size-4 text-muted-foreground" aria-hidden />
        <span className="microlabel text-muted-foreground">Check a price</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <input
          className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
          placeholder="model id, e.g. claude-opus-4-5-20251101"
          value={modelId} onChange={(e) => setModelId(e.target.value)}
          aria-label="model id"
        />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={inTok} onChange={(e) => setInTok(e.target.value)} aria-label="input tokens" />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={outTok} onChange={(e) => setOutTok(e.target.value)} aria-label="output tokens" />
      </div>
      {result && (
        result.matched === undefined ? (
          <div className="rounded-md bg-destructive/10 p-3 text-sm">
            <strong className="text-destructive">No price for this model.</strong>{' '}
            A step on it counts as $0, so <code>maxCostUsd</code> cannot cap it at any threshold. Add a row below.
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="text-muted-foreground">
              matched entry: <code className="font-mono text-foreground">{result.matched}</code>
              {result.matched !== modelId.trim() && <span className="ml-1 text-xs">(prefix match)</span>}
            </div>
            <div className="text-lg font-semibold">${money(result.cost)}</div>
          </div>
        )
      )}
    </div>
  );
}

/** A row while it is being TYPED. Strings, not numbers — see `Pricing`'s draft state. */
type RawPrice = { inputPer1M: string; outputPer1M: string; cachedInputPer1M?: string };

const toRaw = (p: ModelPrice): RawPrice => ({
  inputPer1M: String(p.inputPer1M),
  outputPer1M: String(p.outputPer1M),
  ...(p.cachedInputPer1M !== undefined ? { cachedInputPer1M: String(p.cachedInputPer1M) } : {}),
});

/** Parse a typed row. An empty cache field means "not set", not zero. */
function fromRaw(r: RawPrice): ModelPrice {
  const out: ModelPrice = { inputPer1M: Number(r.inputPer1M), outputPer1M: Number(r.outputPer1M) };
  if (r.cachedInputPer1M !== undefined && r.cachedInputPer1M.trim() !== '') {
    out.cachedInputPer1M = Number(r.cachedInputPer1M);
  }
  return out;
}

export function Pricing() {
  const qc = useQueryClient();
  const q = usePricing();
  // The draft holds STRINGS. Storing numbers while typing silently ate the decimal point: each
  // keystroke ran Number(raw), so "99." became 99, rendered back as "99", and the next character
  // produced "995" — a price ten times too large, in the field a spend ceiling reads. It looked fine
  // in jsdom because the test set the whole value in one change event rather than character by
  // character; it showed up the moment the page was typed into in a real browser.
  const [draft, setDraft] = useState<Record<string, RawPrice> | null>(null);
  const [saving, setSaving] = useState(false);
  const [newId, setNewId] = useState('');

  const rawOverrides: Record<string, RawPrice> = draft
    ?? Object.fromEntries(Object.entries(q.data?.overrides ?? {}).map(([k, v]) => [k, toRaw(v)]));
  const overrides: Record<string, ModelPrice> = useMemo(
    () => Object.fromEntries(Object.entries(rawOverrides).map(([k, v]) => [k, fromRaw(v)])),
    [rawOverrides],
  );
  const dirty = draft !== null;
  // The preview must reflect what would be in force AFTER saving, not what is in force now — otherwise
  // an operator checks a price, sees the old number, and saves anyway.
  const effective = useMemo(
    () => ({ ...(q.data?.effective ?? {}), ...overrides }),
    [q.data?.effective, overrides],
  );

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;

  // Stores the keystroke as typed. Validation happens on save, so an in-progress "99." or "" is not
  // rewritten under the cursor.
  const edit = (id: string, field: keyof ModelPrice, raw: string) => {
    setDraft({ ...rawOverrides, [id]: { ...rawOverrides[id], [field]: raw } as RawPrice });
  };

  const save = async () => {
    // Refuse locally rather than letting the server 400: a NaN row is the one input that would store,
    // produce NaN costs, and compare false against every ceiling.
    const bad = Object.entries(overrides).find(([, p]) =>
      !Number.isFinite(p.inputPer1M) || p.inputPer1M < 0 || !Number.isFinite(p.outputPer1M) || p.outputPer1M < 0
      || (p.cachedInputPer1M !== undefined && (!Number.isFinite(p.cachedInputPer1M) || p.cachedInputPer1M < 0)));
    if (bad) { toast.error(`${bad[0]}: prices must be non-negative numbers`); return; }

    setSaving(true);
    try {
      await api.savePricing(overrides, q.data?.version, q.data?.replace);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['pricing'] });
      toast.success('Pricing saved — in effect on the next model step, no deploy needed');
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 409
        ? 'Another admin saved first — reload before editing again'
        : errMessage(e));
    } finally { setSaving(false); }
  };

  const rows = Object.entries(effective).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pricing"
        description="USD per 1M tokens. This is the table maxCostUsd and organization spend limits read."
        actions={q.data?.editable && (
          <Btn onClick={save} disabled={!dirty || saving}>
            <Save className="size-4" aria-hidden /> {saving ? 'Saving…' : 'Save'}
          </Btn>
        )}
      />

      {!q.data?.editable && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This journal is read-only, so prices can be viewed but not edited here.
        </div>
      )}
      {q.data?.replace && (
        <div className="rounded-md bg-warning/10 p-3 text-sm">
          <strong>replace is on.</strong> Only the models listed below are priced; every other model
          counts as $0 and cannot be capped by a spend limit.
        </div>
      )}

      <CostPreview table={effective} />

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Input</th>
              <th className="px-3 py-2 text-right font-medium">Output</th>
              <th className="px-3 py-2 text-right font-medium">Cache read</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, p]) => {
              const mine = id in overrides;
              return (
                <tr key={id} className={cn('border-b border-border/60 last:border-b-0', mine && 'bg-accent/30')}>
                  <td className="px-3 py-2 font-mono text-xs">
                    {id} {mine && <Badge tone="success">yours</Badge>}
                  </td>
                  {(['inputPer1M', 'outputPer1M', 'cachedInputPer1M'] as const).map((field) => (
                    <td key={field} className="px-3 py-2 text-right">
                      {mine && q.data?.editable ? (
                        <input
                          className="w-24 rounded border border-border bg-background px-2 py-1 text-right font-mono text-xs"
                          value={rawOverrides[id]?.[field] ?? ''}
                          onChange={(e) => edit(id, field, e.target.value)}
                          aria-label={`${id} ${field}`}
                        />
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {p[field] === undefined ? '—' : money(p[field] as number)}
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    {mine && q.data?.editable && (
                      <button
                        onClick={() => { const next = { ...rawOverrides }; delete next[id]; setDraft(next); }}
                        aria-label={`remove override for ${id}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <Empty>No models priced</Empty>}

      {q.data?.editable && (
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
            placeholder="add a model id"
            value={newId} onChange={(e) => setNewId(e.target.value)}
            aria-label="new model id"
          />
          <Btn
            variant="outline"
            disabled={!newId.trim() || newId.trim() in overrides}
            onClick={() => {
              setDraft({ ...rawOverrides, [newId.trim()]: { inputPer1M: '0', outputPer1M: '0' } });
              setNewId('');
            }}
          >
            <Plus className="size-4" aria-hidden /> Add
          </Btn>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Overrides layer over the table shipped with @gnldev/durable, so adding one model does not
        un-price the others. Saved prices apply on the next model step — no redeploy.
      </p>
    </div>
  );
}
