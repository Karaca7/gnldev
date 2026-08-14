import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench, ChevronLeft } from 'lucide-react';
import { useTools, useCapabilities, api, errMessage, type ToolListItem, type ToolExecResult } from '../api';
import { Btn, Spinner, Empty, EmptyState, ErrorBox, Badge, StatStrip, JsonBlock, cn } from '../components';

// Shared class for form/JSON inputs: ink background + border. The focus recipe (ring + halo) lives in
// Index.css and applies to every input/textarea/select — do not re-declare it here.
const inputCls = 'rounded-md border border-input bg-background px-2 py-1 text-sm outline-none transition-colors';

export function Tools() {
  const { t } = useTranslation('tools');
  const caps = useCapabilities();
  const tools = useTools();
  const [sel, setSel] = useState<string | null>(null);
  const selTool = tools.data?.find((t) => t.name === sel) ?? tools.data?.[0];

  if (tools.isLoading) return <Spinner />;
  // Query error (SEPARATE from the "no tools" empty state): if the fetch fails, tools.data stays
  // Undefined and the length check below would wrongly show "No tools" — handle the real error first.
  if (tools.error) return <ErrorBox error={tools.error} />;
  if (!tools.data?.length) return <EmptyState icon={Wrench} title={t('emptyTitle')} description={t('emptyDescription')} />;

  return (
    <div className="flex h-full flex-col">
    <StatStrip items={[
      { label: t('statRegistered'), value: String(tools.data.length) },
      { label: t('statGuarded'), value: String(tools.data.filter((x) => x.guarded).length) },
    ]} />
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Master-detail on mobile (<768px), same pattern as Inspector: the tool LIST and the tool
          DETAIL/schema never fit side by side on a phone. Below md, show ONE panel at a time based
          on `sel` (list until a tool is tapped, then the detail full-width with a back arrow); at
          md+, both panels stay side by side exactly as before (first tool auto-selected via the
          selTool fallback above). */}
      <div className={cn('w-full flex-col overflow-auto border-r border-border p-1.5 md:flex md:w-60', sel ? 'hidden md:flex' : 'flex')}>
        {tools.data.map((tool) => (
          <button
            key={tool.name}
            onClick={() => setSel(tool.name)}
            className={cn(
              'mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md border-l-2 px-2.5 py-2 text-left transition-colors',
              (sel ?? tools.data![0].name) === tool.name ? 'border-l-brand bg-muted' : 'border-l-transparent hover:bg-muted/60',
            )}
          >
            <div className="flex w-full items-center gap-1.5"><span className="truncate font-mono text-xs">{tool.name}</span>{tool.guarded && <Badge tone="warning">{t('guardedBadge')}</Badge>}</div>
            {tool.description && <span className="line-clamp-1 text-[11px] text-muted-foreground">{tool.description}</span>}
          </button>
        ))}
      </div>
      <div className={cn('flex-1 overflow-hidden', !sel && 'hidden md:block')}>
        {selTool && <ToolRunner key={selTool.name} tool={selTool} canExec={!!caps.data?.toolExec} durableAvail={!!caps.data?.toolExecDurable} onBack={() => setSel(null)} />}
      </div>
    </div>
    </div>
  );
}

function fieldsOf(schema: any): { key: string; type: string; enum?: any[]; required: boolean; description?: string }[] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const req: string[] = schema.required ?? [];
  return Object.entries(props).map(([key, v]: [string, any]) => ({
    key, type: v?.enum ? 'enum' : v?.type ?? 'string', enum: v?.enum, required: req.includes(key), description: v?.description,
  }));
}

// PURE function: coerces a form field's raw string value according to the schema. An empty/
// Untouched field (v undefined/'') → undefined (so it isn't converted to a number and become
// NaN — the old code produced Number(undefined) and sent NaN to the server).
export function coerceToolField(f: { type: string }, v: string | undefined): unknown {
  if (v === undefined || v === '') return undefined;
  if (f.type === 'number' || f.type === 'integer') return Number(v);
  if (f.type === 'boolean') return v === 'true';
  return v;
}

// PURE function (testable, DOM-free): coerces and validates all fields — blocks submit if a
// Number field has NaN or a required field is empty (invalid: which fields to highlight).
export function validateToolInput(
  fields: { key: string; type: string; required: boolean }[],
  vals: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    const v = coerceToolField(f, vals[f.key] as string | undefined);
    const isNaNNumber = typeof v === 'number' && Number.isNaN(v);
    if (isNaNNumber || (f.required && v === undefined)) { invalid.push(f.key); continue; }
    if (v !== undefined) input[f.key] = v;
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, input };
}

function ToolRunner({ tool, canExec, durableAvail, onBack }: { tool: ToolListItem; canExec: boolean; durableAvail: boolean; onBack?: () => void }) {
  const { t } = useTranslation('tools');
  const fields = fieldsOf(tool.inputSchema);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [raw, setRaw] = useState(false);
  const [rawJson, setRawJson] = useState('{}');
  const [durable, setDurable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ToolExecResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);

  // Clear a field's invalid highlight once it changes (cleared right away if the user has started fixing it).
  const setField = (key: string, v: string) => {
    setVals((s) => ({ ...s, [key]: v }));
    setInvalidFields((iv) => iv.filter((k) => k !== key));
  };

  const run = async () => {
    setBusy(true); setErr(null); setRes(null); setInvalidFields([]);
    let input: unknown;
    if (raw || fields.length === 0) {
      try { input = rawJson.trim() ? JSON.parse(rawJson) : {}; } catch { setErr(t('invalidJson')); setBusy(false); return; }
    } else {
      const v = validateToolInput(fields, vals);
      if (!v.ok) {
        setInvalidFields(v.invalid);
        setErr(t('invalidFields', { fields: v.invalid.join(', ') }));
        setBusy(false);
        return;
      }
      input = v.input;
    }
    try { setRes(await api.executeTool(tool.name, { input, durable })); } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="flex-1 overflow-auto p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {/* Mobile-only back arrow: below md the list/detail panels are master-detail (see Tools's
            top-level layout, same pattern as Inspector's RunDetail) — this is the only way back to
            the tool list on a phone. */}
        {onBack && (
          <button type="button" onClick={onBack} title={t('backToToolsTitle')} className="shrink-0 text-muted-foreground hover:text-foreground md:hidden">
            <ChevronLeft size={16} />
          </button>
        )}
        {/* break-all (not truncate): a long mono tool name with no spaces would otherwise force
            horizontal overflow on a narrow viewport — this lets it wrap instead. */}
        <h2 className="break-all font-mono text-sm font-semibold">{tool.name}</h2>
        {tool.guarded && <Badge tone="warning">{t('guardedBadge')}</Badge>}
        {tool.agents?.length > 0 && <span className="text-[11px] text-muted-foreground">{tool.agents.join(', ')}</span>}
      </div>
      {tool.description && <p className="mb-3 text-sm text-muted-foreground">{tool.description}</p>}

      {!canExec ? (
        <Empty>{t('execDisabled')}</Empty>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3 text-xs">
            <button className="text-muted-foreground underline" onClick={() => setRaw((r) => !r)}>{raw ? t('switchToFormMode') : t('switchToRawJsonMode')}</button>
            {/* D4-10: the checkbox only toggles journal writes — the guard itself already runs on every
                test execution (durable or not, see runner.ts's runTool: the non-durable path applies the
                guard manually). The old "(journal + guard)" label implied guard was gated by this
                checkbox, which isn't true — it only describes what "durable" adds. */}
            {durableAvail && <label className="flex items-center gap-1.5"><input type="checkbox" checked={durable} onChange={(e) => setDurable(e.target.checked)} /> {t('durableCheckboxLabel')}</label>}
          </div>

          {raw || fields.length === 0 ? (
            <textarea aria-label={t('rawJsonInputAriaLabel')} value={rawJson} onChange={(e) => setRawJson(e.target.value)} rows={5}
              className={cn(inputCls, 'w-full p-2 font-mono text-xs')} />
          ) : (
            <div className="space-y-2">
              {fields.map((f) => {
                const invalid = invalidFields.includes(f.key);
                const fieldCls = cn(inputCls, invalid && 'border-destructive');
                return (
                <div key={f.key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium">{f.key}{f.required && <span className="text-destructive"> *</span>}<span className="ml-1 font-normal text-muted-foreground">{f.type}</span></label>
                  {f.type === 'enum' ? (
                    <select aria-label={f.key} aria-invalid={invalid} value={vals[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} className={fieldCls}>
                      <option value="">—</option>
                      {f.enum?.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                    </select>
                  ) : f.type === 'boolean' ? (
                    <select aria-label={f.key} aria-invalid={invalid} value={vals[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} className={fieldCls}>
                      <option value="">—</option><option value="true">true</option><option value="false">false</option>
                    </select>
                  ) : (
                    <input aria-label={f.key} aria-invalid={invalid} value={vals[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.description}
                      className={fieldCls} />
                  )}
                </div>
                );
              })}
            </div>
          )}

          <div className="mt-3"><Btn arrow onClick={run} busy={busy}>{busy ? t('running') : t('runTest')}</Btn></div>

          {err && <div className="mt-3 text-sm text-destructive">{err}</div>}
          {res && (
            <div className="mt-3">
              {res.blocked && <Badge tone={res.blocked === 'deny' ? 'destructive' : 'warning'}>{t('blockedByGuard', { value: res.blocked })}</Badge>}
              {res.error && !res.blocked && <div className="text-sm text-destructive">{res.error}</div>}
              {res.runId && <div className="mt-1 text-[11px] text-muted-foreground">runId: {res.runId}</div>}
              {res.result !== undefined && <JsonBlock value={res.result} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
