import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Cell, CartesianGrid,
} from 'recharts';
import { useMetrics, useMetricsRuns, type MetricsRun, type MetricsDayEntry } from '../api';
import { Spinner, StatusBadge, Empty, ErrorBox } from '../components';
import { Stagger, StaggerItem, Reveal } from '../motion';

// RFC4180-like CSV field escaping: fields containing a comma/quote/newline are wrapped in double
// quotes (inner quotes are doubled) — pure function, edge cases are covered in test/observability-audit.test.ts.
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Run table → CSV text (pure function, doesn't touch the DOM — the download side effect is kept separate). */
export function runsToCsv(rows: MetricsRun[]): string {
  const header = ['runId', 'status', 'startTs', 'durationMs', 'modelSteps', 'toolCalls', 'totalTokens', 'costUsd'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.runId, r.status, r.startTs ?? '', r.durationMs ?? '', r.modelSteps, r.toolCalls, r.totalTokens, r.costUsd,
    ].map(csvField).join(','));
  }
  return lines.join('\n');
}

/** Downloads text as a file (browser side effect — separate from CSV generation, not tested). */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Status colors from theme tokens (semantic, same exact mapping as StatusBadge).
const STATUS_COLOR: Record<string, string> = {
  completed: 'hsl(var(--success))',
  suspended: 'hsl(var(--warning))',
};
// Single-series time series: lime primary (run count — volume), green secondary (cost).
const PRIMARY = 'hsl(var(--brand))';
const SECONDARY = 'hsl(var(--success))';
// P2-skor: fixed-order categorical palette for the score-trend chart's per-scorer lines — the app's
// own semantic tokens (already contrast-checked for this product, light+dark), assigned by POSITION
// (never by name/rank — a filtered-out scorer never repaints the survivors). A 6th+ scorer wraps
// (rare in practice; scorer counts are small and operator-defined) rather than inventing new hues.
const SCORE_SERIES_COLORS = [
  'hsl(var(--brand))', 'hsl(var(--info))', 'hsl(var(--success))', 'hsl(var(--warning))', 'hsl(var(--destructive))',
];
const TICK = { fontSize: 10, fill: 'hsl(var(--muted-foreground))', fontFamily: "'Geist Mono Variable', monospace" };
const TOOLTIP_STYLE = {
  fontSize: 12, borderRadius: 8, border: '1px solid hsl(var(--border))',
  background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))',
};

/** Nearest-rank percentile (sufficient for small N; null if empty). */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="microlabel text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Buckets startTs values into time buckets: range > 3 days → day bucket, otherwise hour bucket. */
function buildSeries(rows: MetricsRun[]) {
  const stamped = rows.filter((r): r is MetricsRun & { startTs: number } => r.startTs != null);
  if (stamped.length === 0) return { points: [] as { label: string; runs: number; costUsd: number }[], skipped: rows.length };
  const min = Math.min(...stamped.map((r) => r.startTs));
  const max = Math.max(...stamped.map((r) => r.startTs));
  const daily = max - min > 3 * 86_400_000;
  const bucketMs = daily ? 86_400_000 : 3_600_000;
  const buckets = new Map<number, { runs: number; costUsd: number }>();
  for (const r of stamped) {
    const b = Math.floor(r.startTs / bucketMs) * bucketMs;
    const cur = buckets.get(b) ?? { runs: 0, costUsd: 0 };
    cur.runs++;
    cur.costUsd += r.costUsd;
    buckets.set(b, cur);
  }
  const points = [...buckets.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({
    label: daily
      ? new Date(t).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })
      : new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    runs: v.runs,
    costUsd: Number(v.costUsd.toFixed(6)),
  }));
  return { points, skipped: rows.length - stamped.length };
}

/** Matches a `score:<name>:avg` counter field key (P2-skor, see @gnl/durable metrics.ts's withDerivedScores) — group 1 is the scorer name. */
const SCORE_AVG_FIELD_RE = /^score:(.+):avg$/;

/**
 * P2-skor trend: per-scorer daily average, derived from `byDay[].fields['score:<name>:avg']`.
 * Scorer NAMES are discovered dynamically (never hardcoded) by scanning every day bucket's field
 * keys — a day with no scored runs simply has no fields for that scorer (a gap in its line, not a
 * zero). `scorers` is returned in first-seen order (stable across renders as long as `byDay` order
 * is stable) so the fixed-order categorical palette above assigns colors by POSITION, not by name.
 * Pure function (no chart/DOM dependency) — exported for a data-shape unit test.
 */
export function buildScoreTrend(byDay: MetricsDayEntry[]): { scorers: string[]; points: Record<string, string | number>[] } {
  const scorers: string[] = [];
  const seen = new Set<string>();
  for (const d of byDay) {
    for (const key of Object.keys(d.fields ?? {})) {
      const m = SCORE_AVG_FIELD_RE.exec(key);
      if (m && !seen.has(m[1]!)) { seen.add(m[1]!); scorers.push(m[1]!); }
    }
  }
  const points = byDay.map((d) => {
    const point: Record<string, string | number> = {
      label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }),
    };
    for (const name of scorers) {
      const v = d.fields?.[`score:${name}:avg`];
      if (v != null) point[name] = Number(v.toFixed(3));
    }
    return point;
  });
  return { scorers, points };
}

export function Observability() {
  const { t } = useTranslation('observability');
  const metrics = useMetrics();
  const runRows = useMetricsRuns();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [nameFilter, setNameFilter] = useState('');

  const rows = runRows.data?.runs ?? [];

  const durations = useMemo(
    () => rows.map((r) => r.durationMs).filter((d): d is number => d != null && d > 0).sort((a, b) => a - b),
    [rows],
  );
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);

  const series = useMemo(() => buildSeries(rows), [rows]);
  const scoreTrend = useMemo(() => buildScoreTrend(metrics.data?.byDay ?? []), [metrics.data]);

  const barData = useMemo(
    () => Object.entries(metrics.data?.byStatus ?? {}).map(([status, count]) => ({ status, count })),
    [metrics.data],
  );

  const filtered = useMemo(
    () =>
      rows
        .filter((r) => statusFilter === 'all' || r.status === statusFilter)
        .filter((r) => !nameFilter || r.runId.toLowerCase().includes(nameFilter.toLowerCase()))
        .sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0)),
    [rows, statusFilter, nameFilter],
  );

  if (metrics.isLoading || runRows.isLoading) return <Spinner />;
  if (metrics.error) return <ErrorBox error={metrics.error} />;
  if (runRows.error) return <ErrorBox error={runRows.error} />;

  return (
    <div className="space-y-4 p-5">
      {/* NOT live (not SSE): useMetrics/useMetricsRuns refresh themselves via periodic polling
          (5s/10s respectively — see api.ts refetchInterval). useLiveRuns()'s SSE invalidation
          only targets the ['runs'] key and does NOT COVER the ['metrics']/['metrics-runs']
          queries here — that's why it isn't used here (it would be misleading). */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="live-dot" aria-hidden />
        {t('autoRefreshNote')}
      </div>
      <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StaggerItem><Card label={t('totalRuns')} value={String(metrics.data?.total ?? 0)} /></StaggerItem>
        <StaggerItem><Card label={t('completed')} value={String(metrics.data?.byStatus.completed ?? 0)} /></StaggerItem>
        <StaggerItem><Card label={t('suspended')} value={String(metrics.data?.byStatus.suspended ?? 0)} /></StaggerItem>
        <StaggerItem><Card label={t('cost')} value={`$${(metrics.data?.costUsd ?? 0).toFixed(4)}`} /></StaggerItem>
        <StaggerItem><Card label={t('tokens')} value={(metrics.data?.tokens ?? 0).toLocaleString('tr-TR')} /></StaggerItem>
        <StaggerItem><Card label={t('durationP95')} value={fmtMs(p95)} hint={t('durationHint', { p50: fmtMs(p50), p99: fmtMs(p99) })} /></StaggerItem>
      </Stagger>

      <div className="grid gap-3 lg:grid-cols-3">
        <Reveal className="rounded-md border border-border bg-card p-3">
          <div className="microlabel mb-2 text-muted-foreground">{t('runsOverTimeChart')}</div>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <BarChart data={series.points}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="label" tick={TICK} stroke="hsl(var(--border))" tickLine={false} />
                <YAxis allowDecimals={false} tick={TICK} stroke="transparent" width={28} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                <Bar dataKey="runs" name="run" fill={PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Reveal>

        <Reveal delay={0.06} className="rounded-md border border-border bg-card p-3">
          <div className="microlabel mb-2 text-muted-foreground">{t('costOverTimeChart')}</div>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={series.points}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="label" tick={TICK} stroke="hsl(var(--border))" tickLine={false} />
                <YAxis tick={TICK} stroke="transparent" width={52} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v}`, t('costLabel')]} />
                <Line type="monotone" dataKey="costUsd" name={t('costLabel')} stroke={SECONDARY} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Reveal>

        <Reveal delay={0.12} className="rounded-md border border-border bg-card p-3">
          <div className="microlabel mb-2 text-muted-foreground">{t('statusDistributionChart')}</div>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <BarChart data={barData}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="status" tick={TICK} stroke="hsl(var(--border))" tickLine={false} />
                <YAxis allowDecimals={false} tick={TICK} stroke="transparent" width={28} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
                <Bar dataKey="count" name="run" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {barData.map((d) => <Cell key={d.status} fill={STATUS_COLOR[d.status] ?? PRIMARY} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Reveal>
      </div>
      {series.skipped > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {t('seriesSkippedNote', { count: series.skipped })}
        </div>
      )}

      {/* P2-skor: per-scorer daily average trend — only rendered once at least one scorer has actually
          produced a materialized `score:<name>:avg` counter (source==='materialized'); on the legacy
          scan path (no getCounters) byDay is always empty, so this card silently doesn't appear
          rather than showing a misleading blank chart. */}
      {scoreTrend.scorers.length > 0 && (
        <Reveal className="rounded-md border border-border bg-card p-3">
          <div className="microlabel mb-2 text-muted-foreground">{t('scoreTrendChart')}</div>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={scoreTrend.points}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="label" tick={TICK} stroke="hsl(var(--border))" tickLine={false} />
                <YAxis domain={[0, (max: number) => Math.max(1, max)]} tick={TICK} stroke="transparent" width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {scoreTrend.scorers.map((name, i) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={name}
                    name={name}
                    stroke={SCORE_SERIES_COLORS[i % SCORE_SERIES_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 4 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Reveal>
      )}

      <div className="rounded-md border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="microlabel text-muted-foreground">{t('runsHeading', { count: filtered.length })}</span>
          <input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchAriaLabel')}
            className="ml-auto w-40 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"
          />
          <select aria-label={t('statusFilterAriaLabel')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
            <option value="all">{t('statusAll')}</option>
            <option value="completed">completed</option>
            <option value="suspended">suspended</option>
          </select>
          <button
            type="button"
            onClick={() => downloadText(`gnl-runs-${Date.now()}.csv`, runsToCsv(filtered), 'text/csv;charset=utf-8;')}
            disabled={filtered.length === 0}
            className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {t('downloadCsv')}
          </button>
        </div>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">runId</th>
                <th className="px-3 py-2 font-medium">status</th>
                <th className="px-3 py-2 font-medium">{t('colStart')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('colDuration')}</th>
                <th className="px-3 py-2 text-right font-medium">model</th>
                <th className="px-3 py-2 text-right font-medium">tool</th>
                <th className="px-3 py-2 text-right font-medium">token</th>
                <th className="px-3 py-2 text-right font-medium">{t('costLabel')}</th>
              </tr>
            </thead>
            <Stagger as={motion.tbody}>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8}><Empty>{t('noMatchingRuns')}</Empty></td>
                </tr>
              ) : filtered.map((r) => (
                <StaggerItem key={r.runId} as={motion.tr} className="border-t border-border">
                  <td className="px-3 py-1.5 font-mono">
                    <Link
                      to={`/inspector?run=${encodeURIComponent(r.runId)}`}
                      title={t('openInInspector')}
                      className="text-brand underline-offset-2 hover:underline"
                    >
                      {r.runId}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    {r.startTs != null ? new Date(r.startTs).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmtMs(r.durationMs)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.modelSteps}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.toolCalls}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.totalTokens.toLocaleString('tr-TR')}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">${r.costUsd.toFixed(4)}</td>
                </StaggerItem>
              ))}
            </Stagger>
          </table>
        </div>
      </div>
    </div>
  );
}
