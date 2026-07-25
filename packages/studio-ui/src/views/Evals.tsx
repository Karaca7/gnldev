import { useEffect, useState } from 'react';
import { Play, FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useScorers, useDatasets, useRuns, useCapabilities, api, errMessage, type EvalDatasetResult } from '../api';
import { Btn, Spinner, Empty, EmptyState, ErrorBox, Badge, JsonBlock } from '../components';

export function Evals() {
  const { t } = useTranslation('evals');
  const caps = useCapabilities();
  const scorers = useScorers();
  const datasets = useDatasets();
  const hasScorers = !!caps.data?.scorers;
  const hasDatasets = !!caps.data?.datasets;

  if (caps.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (!hasScorers && !hasDatasets) return <EmptyState icon={FlaskConical} title={t('disabledTitle')} description={t('disabledDescription')} />;
  if (scorers.error) return <ErrorBox error={scorers.error} />;
  if (datasets.error) return <ErrorBox error={datasets.error} />;
  // STATE-09: `caps.data` is already warm on app boot (fetched once, cached), so it resolves well
  // before `scorers`/`datasets` (which only start fetching on this view's mount). Rendering the panels
  // while those two are still in flight used to mount ScoreRunPanel with `scorerNames: []` (seeding its
  // checkbox `Set` empty forever, see below) and flash "no datasets" for a beat. Wait for both first.
  if (scorers.isLoading || datasets.isLoading) return <Spinner />;

  return (
    <div className="space-y-6 p-5">
      {hasDatasets && <DatasetsPanel datasets={datasets.data ?? []} scorerNames={scorers.data ?? []} />}
      {hasScorers && <ScoreRunPanel scorerNames={scorers.data ?? []} />}
    </div>
  );
}

function DatasetsPanel({ datasets, scorerNames }: { datasets: { id: string; cases: number; description?: string }[]; scorerNames: string[] }) {
  const { t } = useTranslation('evals');
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<EvalDatasetResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (id: string) => {
    setRunning(id); setErr(null); setResult(null);
    try { setResult(await api.runDataset(id, scorerNames)); } catch (e) { setErr(String(e)); } finally { setRunning(null); }
  };

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><FlaskConical size={15} /> Datasets</h2>
      {datasets.length === 0 ? <Empty>{t('noDatasets')}</Empty> : (
        <div className="space-y-1.5">
          {datasets.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <div>
                <span className="font-mono text-sm">{d.id}</span>
                <span className="ml-2 text-xs text-muted-foreground">{d.cases} case{d.description ? ` · ${d.description}` : ''}</span>
              </div>
              <Btn size="xs" onClick={() => run(d.id)} disabled={!!running}><Play size={13} /> {running === d.id ? t('running') : t('runAction')}</Btn>
            </div>
          ))}
        </div>
      )}
      {err && <div className="mt-2 text-sm text-destructive">{err}</div>}
      {result && <EvalResultTable result={result} />}
    </section>
  );
}

function EvalResultTable({ result }: { result: EvalDatasetResult }) {
  const scorerKeys = Object.keys(result.aggregate);
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr><th className="px-3 py-2">case</th><th className="px-3 py-2">output</th>{scorerKeys.map((k) => <th key={k} className="px-3 py-2">{k}</th>)}</tr>
        </thead>
        <tbody>
          {result.cases.map((c) => (
            <tr key={c.caseId} className="border-t border-border">
              <td className="px-3 py-2 font-mono">{c.caseId}</td>
              <td className="max-w-xs truncate px-3 py-2 text-muted-foreground" title={c.output}>{c.output}</td>
              {scorerKeys.map((k) => <td key={k} className="px-3 py-2"><ScorePill v={c.scores[k]?.score} /></td>)}
            </tr>
          ))}
          <tr className="border-t-2 border-border bg-muted/30 font-medium">
            <td className="px-3 py-2" colSpan={2}>aggregate</td>
            {scorerKeys.map((k) => <td key={k} className="px-3 py-2"><ScorePill v={result.aggregate[k]} /></td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ScorePill({ v }: { v?: number }) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  const tone = v >= 0.8 ? 'success' : v >= 0.5 ? 'warning' : 'destructive';
  return <Badge tone={tone}>{v.toFixed(2)}</Badge>;
}

// Exported (only) for the regression test — Evals is the sole route-level export otherwise; see
// test/evals-score-panel.test.tsx (same pattern as Scheduler.tsx exporting its pure helpers for tests).
export function ScoreRunPanel({ scorerNames }: { scorerNames: string[] }) {
  const { t } = useTranslation('evals');
  const runs = useRuns();
  const [runId, setRunId] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set(scorerNames));
  const [touched, setTouched] = useState(false);
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (n: string) => { setTouched(true); setSel((s) => { const c = new Set(s); c.has(n) ? c.delete(n) : c.add(n); return c; }); };

  // STATE-09: `scorerNames` can arrive AFTER this panel first mounts (see Evals' comment above) — reseed
  // the "all selected" default whenever the list (re)loads, but only as long as the user hasn't manually
  // touched a checkbox yet (same untouched-vs-customized convention as Users.tsx's permission editor).
  useEffect(() => {
    if (!touched) setSel(new Set(scorerNames));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scorerNames.join(',')]);

  const score = async () => {
    if (!runId || sel.size === 0) return;
    setBusy(true); setErr(null);
    try { setRes(await api.score(runId, [...sel], expected || undefined)); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{t('scoreRunHeading')}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">run
          {runs.error ? <ErrorBox error={runs.error} /> : (
            <select aria-label="run" value={runId} onChange={(e) => setRunId(e.target.value)} className="w-56 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none transition-colors focus:border-brand focus:shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]">
              <option value="">{t('selectPlaceholder')}</option>
              {runs.data?.map((r) => <option key={r.runId} value={r.runId}>{r.runId}</option>)}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-xs">{t('expectedOptional')}
          <input value={expected} onChange={(e) => setExpected(e.target.value)} className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none transition-colors focus:border-brand focus:shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]" />
        </label>
        <div className="flex flex-wrap gap-2">
          {scorerNames.map((n) => (
            <label key={n} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={sel.has(n)} onChange={() => toggle(n)} /> {n}</label>
          ))}
        </div>
        <div className="flex flex-col items-start gap-1">
          <Btn size="xs" onClick={score} disabled={busy || !runId || sel.size === 0}>{busy ? t('scoring') : t('scoreAction')}</Btn>
          {sel.size === 0 && <span className="text-[11px] text-muted-foreground">{t('selectAtLeastOneScorer')}</span>}
        </div>
      </div>
      {err && <div className="mt-2 text-sm text-destructive">{err}</div>}
      {res?.scores && (
        <div className="mt-2 flex flex-wrap gap-3">
          {Object.entries(res.scores).map(([k, v]: [string, any]) => (
            <div key={k} className="rounded-md border border-border px-3 py-1.5 text-xs"><span className="font-medium">{k}</span>: <ScorePill v={v?.score} />{v?.reason && <span className="ml-1 text-muted-foreground">{v.reason}</span>}</div>
          ))}
        </div>
      )}
      {res && !res.scores && <JsonBlock value={res} max={300} />}
    </section>
  );
}
