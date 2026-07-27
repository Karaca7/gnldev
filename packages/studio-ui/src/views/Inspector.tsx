import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { GitFork, Check, X, Play, Pause, ChevronLeft, ChevronRight, SkipBack, SkipForward, Columns2, FlaskConical, Trash2, Undo2, UploadCloud, Wrench, Ban, Activity } from 'lucide-react';
import {
  useRunsPaged, useRun, useRunState, useDiff, useTrace, useRunNetwork, useCapabilities, useLiveRuns, useRunScores, useThreads,
  useProcessorReports, useRunIncidents, useMetrics, useMetricsRuns, type MetricsRun,
  api, errMessage, ApiError, type Capabilities, type RunSummary, type RegressionReport, type RegressionDiffEntry, type RunCost, type NetworkTrace,
  type ProcessorReport, type JournalEntry, type RunIncident,
} from '../api';
import { Btn, StatusBadge, StatStrip, Spinner, Empty, EmptyState, ErrorBox, JsonBlock, Tabs, Badge, cn } from '../components';
import { toast, ConfirmDialog } from '../ui';
import { TextDiff } from '../text-diff';
import { MediaParts } from '../media';
import { Stagger, StaggerItem, Reveal } from '../motion';
import { ThreadDetail } from './inspector-thread';

type TabId = 'conversation' | 'trace' | 'network' | 'forks' | 'regression' | 'processors' | 'cost' | 'incidents';
const ALL_TAB_IDS: readonly TabId[] = ['conversation', 'trace', 'network', 'forks', 'regression', 'processors', 'cost', 'incidents'];

// ── fork lineage tree: runId convention `<source>:fork:<ts>` (forkRun's default) ────
function forkParent(id: string): string | null {
  const i = id.lastIndexOf(':fork:');
  return i > 0 ? id.slice(0, i) : null;
}
function forkRoot(id: string): string {
  let cur = id;
  for (let p = forkParent(cur); p; p = forkParent(cur)) cur = p;
  return cur;
}

/**
 * Org derivation from a runId (pure, tested). In the ROOT (unscoped) Studio view, org-scoped runs
 * surface with an `org:<orgId>:` prefix in their runId (journal key `org:acme:order-1:model:0` →
 * runId `org:acme:order-1`, see @gnldev/durable parseJournalKey). There is no separate org field on
 * RunSummary — it is DERIVED from this prefix here. `displayId` is the prefix-stripped, readable id
 * shown to the user; the FULL `runId` must still be used for every API call (readRun/fork/purge/…).
 * A runId with no `org:` prefix → `{ org: null, displayId: runId }` (unchanged).
 */
export function parseOrgFromRunId(runId: string): { org: string | null; displayId: string } {
  const m = /^org:([^:]+):(.+)$/.exec(runId);
  return m ? { org: m[1]!, displayId: m[2]! } : { org: null, displayId: runId };
}

export function Inspector() {
  const { t } = useTranslation('inspector');
  const navigate = useNavigate();
  useLiveRuns();
  const caps = useCapabilities();
  const [statusF, setStatusF] = useState<'all' | 'completed' | 'suspended'>('all');
  const [filter, setFilter] = useState('');
  // API-09: debounce the search box — filtering now happens server-side (GET /runs?q=), so keystrokes
  // must not fire a request per character; the debounced value is what actually drives the query.
  const [debouncedFilter, setDebouncedFilter] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedFilter(filter), 300);
    return () => clearTimeout(id);
  }, [filter]);
  // API-09: status/q are pushed down to GET /runs (server-side) — `runs`/`runList`/`total` below already
  // reflect the active filter, no client-side re-filtering happens anymore (see the old `filtered` memo,
  // removed). `total` (shown in the search placeholder) is the server's FILTERED count.
  const filters = useMemo(
    () => ({ ...(statusF !== 'all' ? { status: statusF } : {}), ...(debouncedFilter ? { q: debouncedFilter } : {}) }),
    [statusF, debouncedFilter],
  );
  const runs = useRunsPaged(filters);
  const runList = useMemo(() => (runs.data?.pages ?? []).flatMap((p) => p.items), [runs.data]);
  const total = runs.data?.pages.at(-1)?.total ?? 0;
  // Fork lineage (ForkView/allRuns) and the currently-selected run's status badge intentionally stay
  // UNFILTERED — a fork sibling, or the run the user has selected, may not match the active search/
  // status filter but must still resolve (this was already the pre-API-09 behavior: `allRuns` was never
  // routed through the client-side filter either). When no filter is active this is the exact SAME
  // react-query key as `runs` above (see useRunsPaged) → deduped to a single request, no extra cost.
  const allRunsQ = useRunsPaged();
  const allRuns = useMemo(() => (allRunsQ.data?.pages ?? []).flatMap((p) => p.items), [allRunsQ.data]);
  // API-10: ONE /metrics/runs query (limited, see useMetricsRuns) shared by every RunRow AND RunDetail
  // below — each used to call useMetricsRuns() ITSELF and re-`.find()` the runId on every render (50
  // rows × the full metrics array, on every 10s poll AND every unrelated re-render). Building the
  // runId → MetricsRun lookup ONCE here and handing it down as a Map turns that into a single O(1)
  // lookup per row, computed once per data change instead of once per row per render.
  const mr = useMetricsRuns();
  const metricsById = useMemo(() => new Map((mr.data?.runs ?? []).map((r) => [r.runId, r] as const)), [mr.data]);
  // FLOW-07: the URL (`?run=`/`?tab=`) is the single source of truth for the selected run and active
  // tab — this is what makes "paste a link to this exact run+tab" and the browser Back button work.
  // localStorage is only a FALLBACK for the initial value when the URL carries no `run` (e.g. a bare
  // /inspector visit) — it is never written back into the URL. The OLD one-time-consume effect used
  // to DELETE `?run` right after reading it, which is exactly what broke deep links and Back. The
  // Playground "Inspect" link (`/inspector?run=<id>`) still works unchanged: its `run` value becomes
  // the initial `sel` below, same as before.
  const [params, setParams] = useSearchParams();
  const [sel, setSel] = useState<string | null>(() => params.get('run') || localStorage.getItem('gnl-insp-run'));
  const [tab, setTab] = useState<TabId>(() => (params.get('tab') as TabId | null) || 'conversation');
  // Thread-level selection (ThreadDetail — see inspector-thread.tsx). A RUN selection wins the right
  // pane; selThread stays set underneath it so RunDetail's back returns to the thread ledger.
  const [selThread, setSelThread] = useState<string | null>(() => params.get('thread'));
  // F5-resilient selection; when sel drops to null via purge/onPurged, clear the key too (so a stale runId doesn't come back on F5).
  useEffect(() => { if (sel) localStorage.setItem('gnl-insp-run', sel); else localStorage.removeItem('gnl-insp-run'); }, [sel]);
  // Pull sel/tab FROM the URL when it changes from outside our own writes below — a new `?run=` link
  // clicked while Inspector is already mounted (no remount, so the initial useState above doesn't
  // re-run), or a browser Back/Forward navigation.
  useEffect(() => {
    const urlRun = params.get('run');
    const urlTab = params.get('tab') as TabId | null;
    const urlThread = params.get('thread');
    if (urlRun !== null && urlRun !== sel) setSel(urlRun);
    if (urlTab !== null && urlTab !== tab) setTab(urlTab);
    if (urlThread !== selThread && (urlThread !== null || selThread !== null)) setSelThread(urlThread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  // Push sel/tab TO the URL so it always reflects the current selection (replace: this is in-app
  // navigation within Inspector, not a new page — it should not pile up history entries).
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (sel) next.set('run', sel); else next.delete('run');
    if (tab !== 'conversation') next.set('tab', tab); else next.delete('tab');
    if (selThread) next.set('thread', selThread); else next.delete('thread');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, tab, selThread]);

  // Left list view: flat list (default, industry pattern: trace-first) or grouped by thread —
  // the selection (`sel`) is preserved when the mode changes, only the display shape changes.
  const [view, setView] = useState<'runs' | 'threads'>('runs');
  const threadGroups = useMemo(() => groupRunsByThread(runList), [runList]);
  // Thread TITLES: names given in Playground (memory listThreads → title). The group header shows
  // that name instead of a bare UUID → same language as Playground (this is also the common observability-tool pattern: showing a name, not a bare UUID).
  const threads = useThreads();
  const threadTitles = useMemo(() => new Map((threads.data ?? []).map((t) => [t.id, t.title])), [threads.data]);

  return (
    <div className="flex h-full flex-col">
      <StatCards />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Master-detail on mobile (<768px): the run LIST and the run DETAIL never fit side by side on
          a phone (this used to squeeze the detail panel to near-zero width — the reported "text
          split into single letters" bug). Below md, show ONE panel at a time based on `sel`; at
          md+, both panels are always visible side by side exactly as before. */}
      <div className={cn('w-full flex-col border-r border-border md:flex md:w-72', (sel || selThread) ? 'hidden md:flex' : 'flex')}>
        {/* Runs/Threads: a REAL tab on its own row (industry pattern — several observability tools put
            Runs/Threads/Monitor, or Langfuse/Phoenix/Helicone Sessions, as a separate page/tab). NOT a
            small toggle crammed into the SAME cramped row as the status filter — that minority/exception
            approach (Braintrust/OpenAI) created
            visual clutter. Same visual language as the main Tabs component → reads as a real mode switch. */}
        <div className="border-b border-border px-2 pt-1.5">
          <Tabs<'runs' | 'threads'>
            active={view}
            onChange={setView}
            tabs={[{ id: 'runs', label: 'Runs' }, { id: 'threads', label: 'Threads' }]}
          />
        </div>
        <div className="space-y-1.5 border-b border-border p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('searchPlaceholder', { count: total })}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none"
          />
          <div className="flex items-center gap-1">
            {(['all', 'completed', 'suspended'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={statusF === s}
                onClick={() => setStatusF(s)}
                className={cn(
                  'rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors',
                  // D6-4: this is a filter-toggle selection state, not the "live/primary" identity — brand/lime
                  // was over-applied here (bucket "general accent"); a neutral filled pill (bg-muted + bold
                  // text) marks the active filter without spending the brand accent on it.
                  statusF === s ? 'border-border bg-muted text-foreground font-semibold' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {s === 'all' ? t('all') : s}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {runs.isLoading && <Spinner />}
          {runs.error && <ErrorBox error={runs.error} />}
          {/* API-09: distinguish "no runs at all" from "no runs match the active filter" — a filter
              (status or search) active but zero server-side results is a different situation from an
              empty journal (the old bug: this used to always say "No runs." even with a filter narrowing
              a non-empty list down to nothing, which read as "your run was deleted").
              STATE-11: also excludes `runs.error` — otherwise the red ErrorBox above is immediately
              followed by "No runs yet", which reads as "empty" rather than "the request failed", and
              since the list refetches every 5s the two flicker in and out together. */}
          {/* D1-4: a brand-new/empty install lands here first (`/` and every unknown route redirect to
              /inspector) — a bare "No runs." with no next step is a dead end for that first-run visitor.
              Only the TRUE empty-journal case (no filter active) gets the full EmptyState treatment; a
              filter narrowing a non-empty list to zero stays the plain inline `noMatchesEmpty` note —
              that's a filter result, not a dead end, and doesn't need a CTA. */}
          {runList.length === 0 && !runs.isLoading && !runs.error && (
            statusF !== 'all' || debouncedFilter ? (
              <Empty>{t('noMatchesEmpty')}</Empty>
            ) : (
              <EmptyState
                icon={Activity}
                title={t('noRunsEmptyTitle')}
                description={t('noRunsEmptyDescription')}
                action={caps.data?.playground ? (
                  <Btn variant="primary" arrow onClick={() => navigate('/playground')}>{t('noRunsEmptyAction')}</Btn>
                ) : undefined}
              />
            )
          )}
          {view === 'runs' && runList.map((r) => (
            <RunRow key={r.runId} run={r} metricsById={metricsById} active={sel === r.runId} onClick={() => { setSel(r.runId); setSelThread(null); }} />
          ))}
          {view === 'threads' && threadGroups.map((g) => (
            <ThreadGroupRow
              key={g.threadId ?? '__ungrouped__'}
              group={g}
              title={g.threadId ? threadTitles.get(g.threadId) : undefined}
              sel={sel}
              selThread={selThread}
              onSelect={(id) => { setSel(id); setSelThread(null); }}
              onSelectThread={(id) => { setSelThread(id); setSel(null); }}
              metricsById={metricsById}
            />
          ))}
          {runs.hasNextPage && (
            <button
              type="button"
              onClick={() => runs.fetchNextPage()}
              disabled={runs.isFetchingNextPage}
              className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {runs.isFetchingNextPage ? t('loadingMoreButton') : t('loadMoreButton', { loaded: runList.length, total })}
            </button>
          )}
        </div>
      </div>
      <div className={cn('flex-1 overflow-hidden', !(sel || selThread) && 'hidden md:block')}>
        {sel ? (
          <RunDetail
            key={sel}
            runId={sel}
            status={allRuns.find((r) => r.runId === sel)?.status}
            caps={caps.data}
            allRuns={allRuns}
            allRunsLoading={allRunsQ.isLoading}
            metricsById={metricsById}
            tab={tab}
            onTabChange={setTab}
            onSelectRun={setSel}
            onPurged={() => setSel(null)}
            onBack={() => setSel(null)}
          />
        ) : selThread ? (
          /* Thread ledger (inspector-thread.tsx): selecting a turn opens its RunDetail while keeping
             selThread underneath — RunDetail's back chevron then returns HERE, not to the bare list. */
          <ThreadDetail
            key={selThread}
            threadId={selThread}
            title={threadTitles.get(selThread)}
            runs={threadGroups.find((g) => g.threadId === selThread)?.runs ?? []}
            metricsById={metricsById}
            caps={caps.data}
            onOpenRun={setSel}
            onBack={() => setSelThread(null)}
          />
        ) : (
          <Empty>{t('selectRunHint')}</Empty>
        )}
      </div>
      </div>
    </div>
  );
}

/** Inspector stat strip (new design) — 4 real, at-a-glance metrics from GET /metrics: total runs,
    success rate (completed/total), avg cost per run, total tokens. Desktop only (md+). No fabricated
    trend deltas — there is no historical baseline in /metrics, so a "+12%" here would be fake. */
function StatCards() {
  const { t } = useTranslation('inspector');
  const m = useMetrics();
  const d = m.data;
  const total = d?.total ?? 0;
  const completed = d?.byStatus?.completed ?? 0;
  const successRate = total ? (completed / total) * 100 : 0;
  const avgCost = total ? d!.costUsd / total : 0;
  const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  return (
    <StatStrip
      items={[
        { label: t('statRuns'), value: total.toLocaleString() },
        { label: t('statSuccess'), value: total ? successRate.toFixed(1) + '%' : '—' },
        { label: t('statCost'), value: '$' + avgCost.toFixed(4) },
        { label: t('statTokens'), value: fmt(d?.tokens ?? 0) },
      ]}
    />
  );
}

/** Compact relative time ("2m ago" / "3h ago" / "5d ago") from an epoch-ms timestamp. */
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
/** Duration ms → "1m 48s" / "0.9s" / "340ms". */
function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
/** Token count → "18.4k" / "1.2M" / "312". */
function fmtTok(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function RunRow({ run, metricsById, active, onClick }: { run: RunSummary; metricsById: Map<string, MetricsRun>; active: boolean; onClick: () => void }) {
  // New-design row: the AGENT name is the primary label (falls back to the runId when a run has no
  // agent — e.g. pre-existing runs / direct runDurable). A status PILL + per-run COST/relative-time
  // come from the shared /metrics/runs query (react-query cached — one fetch for the whole list, looked
  // up O(1) via the `metricsById` Map the parent builds once — see API-10 in Inspector()).
  const { t } = useTranslation('inspector');
  const metric = metricsById.get(run.runId);
  const suspended = run.status === 'suspended';
  const { org, displayId } = parseOrgFromRunId(run.runId);
  const label = run.agent ?? displayId; // agent name = primary label (mockup); runId falls to the meta line
  const meta = [run.agent ? displayId : `${run.modelSteps} model${run.toolCalls > 0 ? ` · ${run.toolCalls} tool` : ''}`,
    metric?.startTs ? relTime(metric.startTs) : null].filter(Boolean).join(' · ');
  return (
    <button
      onClick={onClick}
      title={run.runId}
      className={cn('mb-0.5 flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/60')}
    >
      <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', suspended ? 'bg-warning' : 'bg-success/60')} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-foreground">{label}</span>
          {org && <Badge tone="info">{t('orgBadge', { org })}</Badge>}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{meta}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={suspended ? 'suspended' : 'completed'} />
        {metric && metric.costUsd > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">${metric.costUsd.toFixed(4)}</span>
        )}
      </span>
    </button>
  );
}

// ── Runs | Threads toggle: group the left list by thread (optional — flat list stays the default) ──
export interface ThreadGroup { threadId: string | null; runs: RunSummary[]; }

/**
 * Pure grouping (tested): group by threadId; runs without a threadId are collected into a single
 * `threadId: null` ("ungrouped") group. Order WITHIN a group stays IDENTICAL to input order (the
 * caller already provides newest-first). Group order is stable by first-seen order — i.e. the group
 * whose most recent activity is newest (whose first run in input order is the newest) comes first;
 * the "ungrouped" group is always moved to the very end.
 *
 * A run whose `threadId` EQUALS its own `runId` is treated as ungrouped: that's the sentinel the
 * Playground writes when memory is OFF (`threadId: runId`), and any bare `runDurable` that self-threads.
 * It's not a real multi-turn conversation and has no thread record (→ no title), so grouping it on its
 * own would render a pseudo-thread headed by a raw run id. Folding it into "ungrouped" keeps the Threads
 * view to REAL threads + one ungrouped bucket.
 */
export function groupRunsByThread(runs: RunSummary[]): ThreadGroup[] {
  const order: (string | null)[] = [];
  const byKey = new Map<string | null, RunSummary[]>();
  for (const r of runs) {
    const key = r.threadId && r.threadId !== r.runId ? r.threadId : null;
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(r);
  }
  const groups = order.map((threadId) => ({ threadId, runs: byKey.get(threadId)! }));
  const grouped = groups.filter((g) => g.threadId !== null);
  const ungrouped = groups.filter((g) => g.threadId === null);
  return [...grouped, ...ungrouped];
}

/** Thread group row: collapsible header (truncated thread id + run count + suspended hint) + a RunRow list inside. */
/** Group header label: the thread's NAME in Playground (memory title) > truncated id > "ungrouped".
    A bare UUID header isn't readable — other observability tools (e.g. Helicone) show a name/preview too.
    PURE function (testable, hook-free): the i18n-dependent "ungrouped" label is taken as a parameter
    (EN default) — since a hook can't be called at module level, the caller (ThreadGroupRow) passes in
    its own `t('ungrouped')` result; if a test calls it directly with 2 arguments, the English default is returned. */
export function threadGroupLabel(threadId: string | null, title?: string, ungroupedLabel = 'ungrouped'): string {
  if (threadId == null) return ungroupedLabel;
  if (title) return title;
  return threadId.length > 14 ? `${threadId.slice(0, 12)}…` : threadId;
}

function ThreadGroupRow({ group, title, sel, selThread, onSelect, onSelectThread, metricsById }: {
  group: ThreadGroup; title?: string; sel: string | null; selThread: string | null;
  onSelect: (id: string) => void; onSelectThread: (threadId: string) => void; metricsById: Map<string, MetricsRun>;
}) {
  const { t } = useTranslation('inspector');
  const label = threadGroupLabel(group.threadId, title, t('ungrouped'));
  const named = group.threadId != null && !!title;
  const hasSuspended = group.runs.some((r) => r.status === 'suspended');

  // Declutter (Threads-tab critique): a REAL thread is ONE row — the per-run nesting that used to
  // render every run inline moved into ThreadDetail (the right pane), where the turns actually mean
  // something. The list is for finding a conversation, the ledger is for reading it.
  if (group.threadId != null) {
    const totalCost = group.runs.reduce((n, r) => n + (metricsById.get(r.runId)?.costUsd ?? 0), 0);
    return (
      <button
        type="button"
        onClick={() => onSelectThread(group.threadId!)}
        className={cn(
          'mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
          selThread === group.threadId ? 'bg-muted' : 'hover:bg-muted/60',
        )}
      >
        {/* A named thread uses the normal (readable) font, an unnamed id uses mono — same language as the Playground list. */}
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', named ? 'font-medium text-foreground' : 'font-mono text-muted-foreground')} title={group.threadId}>{label}</span>
        {hasSuspended && <span className="shrink-0"><Badge tone="warning">{t('hasSuspended')}</Badge></span>}
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{group.runs.length}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">${totalCost.toFixed(2)}</span>
      </button>
    );
  }
  // Ungrouped bucket: no thread to open — keep the expandable per-run list.
  return (
    <details className="mb-1" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-muted/60">
        <span className="truncate font-mono text-[13px] text-muted-foreground">{label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{group.runs.length} run</span>
        {hasSuspended && <span className="ml-auto shrink-0"><Badge tone="warning">{t('hasSuspended')}</Badge></span>}
      </summary>
      <div className="ml-2 border-l border-border pl-1.5">
        {group.runs.map((r) => (
          <RunRow key={r.runId} run={r} metricsById={metricsById} active={sel === r.runId} onClick={() => onSelect(r.runId)} />
        ))}
      </div>
    </details>
  );
}

function RunDetail({ runId, status, caps, allRuns, allRunsLoading, metricsById, tab, onTabChange, onSelectRun, onPurged, onBack }: {
  runId: string; status?: string; caps?: Capabilities; allRuns: RunSummary[]; allRunsLoading: boolean; metricsById: Map<string, MetricsRun>;
  tab: TabId; onTabChange: (tab: TabId) => void; onSelectRun: (id: string) => void; onPurged?: () => void; onBack?: () => void;
}) {
  const { t } = useTranslation('inspector');
  const qc = useQueryClient();
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [unwindOpen, setUnwindOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Display-only org derivation; the full `runId` prop is what every api.* call below uses.
  const detailOrg = parseOrgFromRunId(runId);
  const doPurge = async () => {
    try {
      const r = await api.purgeRun(runId);
      toast.success(t('runDeletedToast', { count: r.deleted }));
      void qc.invalidateQueries({ queryKey: ['runs'] });
      onPurged?.();
    } catch (e) {
      toast.error(t('deleteFailedToast', { message: (e as Error).message }));
    }
  };
  // Saga unwind (IRREVERSIBLE): compensateRun via the host — summary toast from the report statuses.
  const doUnwind = async () => {
    try {
      const r = await api.compensateRun(runId);
      const counts: Record<string, number> = {};
      for (const e of r.report.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
      const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || t('unwindNothingToDo');
      toast.success(t('unwindDoneToast', { runId, summary }));
      void qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (e) {
      toast.error(t('unwindFailedToast', { message: (e as Error).message }));
    }
  };
  // D3-A: durable-flag-only cancel — studio keeps no in-process abort registry (see server.ts's own
  // JSDoc on POST /runs/:id/cancel), so this is purely "stop at the next step, everywhere" — same
  // terminal/no-uncancel posture as Unwind, hence the same confirm-dialog treatment.
  const doCancel = async () => {
    try {
      await api.cancelRun(runId);
      toast.success(t('cancelRunDoneToast', { runId }));
      void qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (e) {
      toast.error(t('cancelRunFailedToast', { message: (e as Error).message }));
    }
  };
  // API-11: sourced from /trace instead of a separate /cost request — the server's /trace response
  // ALREADY includes `cost` (same getRunCost call the old /cost endpoint made), so this is one fewer
  // full journal read per run selected, and NO extra request when the Trace/Journal tab is opened
  // afterwards (same ['trace', runId] query, deduped by react-query — see TraceView/JournalTimeline,
  // which already fetch this exact query).
  const traceQ = useTrace(runId);
  const cost = traceQ.data?.cost;
  const incidents = useRunIncidents(runId);
  const run = useRun(runId);
  const scores = useRunScores(runId);
  const metric = metricsById.get(runId);
  const runAgent = allRuns.find((r) => r.runId === runId)?.agent;
  const suspended = status === 'suspended';
  // Number of runs in the same lineage tree (for the tab badge text): those sharing a common root.
  const family = useMemo(() => allRuns.filter((r) => forkRoot(r.runId) === forkRoot(runId)), [allRuns, runId]);

  // FLOW-12: a run purged/retention-swept from another tab (or otherwise gone) must not leave this
  // one stuck on a dead ErrorBox forever with no matching row in the left list to give the user any
  // context. Once the (unfiltered) run list has finished loading and no longer contains this runId,
  // AND the direct fetch for it 404s, treat it exactly like a purge: clear the selection → Empty state.
  useEffect(() => {
    if (allRunsLoading) return;
    if (allRuns.some((r) => r.runId === runId)) return;
    if (run.error instanceof ApiError && run.error.status === 404) onPurged?.();
  }, [allRunsLoading, allRuns, runId, run.error, onPurged]);

  // Tab defs (shared by the <Tabs> nav below and the guard effect right after it — `tab` now lives in
  // the parent Inspector/URL, see FLOW-07, so it SURVIVES switching to a different run instead of
  // resetting on remount the way local state used to).
  const tabDefs = useMemo(() => [
    { id: 'conversation' as const, label: t('tabJournal') },
    { id: 'trace' as const, label: 'Trace' },
    ...(cost ? [{ id: 'cost' as const, label: t('tabCost') }] : []),
    { id: 'network' as const, label: t('tabNetwork') },
    { id: 'forks' as const, label: family.length > 1 ? t('tabForksCount', { count: family.length - 1 }) : t('tabForks') },
    ...(caps?.regression ? [{ id: 'regression' as const, label: t('tabRegression') }] : []),
    ...(caps?.processors ? [{ id: 'processors' as const, label: 'Processor' }] : []),
    // Guard incidents (duplicate guard / loop detection): the tab appears ONLY when the run has
    // any — an always-present empty tab would be noise (same conditional pattern as Cost).
    ...(incidents.data?.incidents?.length ? [{ id: 'incidents' as const, label: t('tabIncidents', { count: incidents.data.incidents.length }) }] : []),
  ], [cost, family.length, caps?.regression, caps?.processors, incidents.data, t]);
  // Sanity-check `tab` against the full TabId union — NOT against `tabDefs` above: several entries in
  // tabDefs are conditional on data that's still LOADING on first render for a freshly-selected run
  // (cost, incidents.data), so validating against it would bounce a perfectly valid persisted/
  // shared-URL tab (e.g. "cost") back to Conversation for a frame before its data arrives. This only
  // catches genuinely bogus values (a hand-edited `?tab=` in the URL) — a conditional tab that simply
  // doesn't apply to this particular run (e.g. "incidents" with none) just renders an empty panel below,
  // same as it already did before `tab` moved into RunDetail.
  useEffect(() => {
    if (!ALL_TAB_IDS.includes(tab)) onTabChange('conversation');
  }, [tab, onTabChange]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['runs'] });
    qc.invalidateQueries({ queryKey: ['run', runId] });
    qc.invalidateQueries({ queryKey: ['state', runId] });
  };
  // After a fork, jump straight to the new run so its (paid, already-resumed) result is visible —
  // otherwise a user staring at the old run may click "fork" again, spawning another paid run.
  const onFork = (newRunId?: string) => {
    refresh();
    if (newRunId) onSelectRun(newRunId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {/* Back/clear-selection arrow: below md the list/detail panels are master-detail (see
              Inspector's top-level layout) — this is the ONLY way back to the run list on a phone.
              FLOW-12: also shown at md+ — it's the only way to clear the selection on desktop (a
              purged/otherwise-gone run's id sticks in localStorage otherwise, so F5 keeps loading it
              back into a dead ErrorBox with no escape short of purging it). `onBack` just clears `sel`. */}
          {onBack && (
            <button type="button" onClick={onBack} title={t('backToRunsTitle')} className="shrink-0 text-muted-foreground hover:text-foreground">
              <ChevronLeft size={16} />
            </button>
          )}
          {/* break-all (not truncate): a long mono runId with no spaces would otherwise force
              horizontal overflow on a narrow viewport — this lets it wrap instead.
              Org-scoped runs show the readable displayId + an org badge; every API call below still
              uses the FULL `runId` prop (readRun/fork/purge/trace) — display and identity are separate. */}
          <h2 className="break-all font-mono text-sm font-semibold">{detailOrg.displayId}</h2>
          {detailOrg.org && <Badge tone="info">{t('orgBadge', { org: detailOrg.org })}</Badge>}
          {status && <StatusBadge status={status} />}
          {/* Runtime scorer results (exactly-once, from the journal): name + score badge. */}
          {scores.data && Object.entries(scores.data.scores).map(([name, s]) => (
            <Badge key={name} tone={typeof s?.score === 'number' && s.score >= 0.5 ? 'success' : 'warning'} >
              {name}: {typeof s?.score === 'number' ? (Number.isInteger(s.score) ? s.score : s.score.toFixed(2)) : '?'}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {caps?.otelExport && <OtelExportButton runId={runId} />}
          {/* D3-A: durable cancel (irreversible → confirm dialog, same treatment as Unwind): only when
              the host journal is writable (caps.runCancel — studio has no in-process abort here). */}
          {caps?.runCancel && (
            <Btn variant="outline" size="xs" title={t('cancelRunButtonTitle')} onClick={() => setCancelOpen(true)}>
              <Ban size={13} className="text-warning" /> {t('cancelRunLabel')}
            </Btn>
          )}
          {/* Saga unwind (irreversible → confirm dialog): only when the host wired compensateRun. */}
          {caps?.compensate && (
            <Btn variant="outline" size="xs" title={t('unwindButtonTitle')} onClick={() => setUnwindOpen(true)}>
              <Undo2 size={13} className="text-warning" /> {t('unwindLabel')}
            </Btn>
          )}
          {caps?.purge && (
            <Btn variant="deny" size="xs" title={t('purgeButtonTitle')} onClick={() => setPurgeOpen(true)}>
              <Trash2 size={13} /> {t('purgeLabel')}
            </Btn>
          )}
        </div>
      </div>
      {/* Meta grid (new design): labeled AGENT · MODEL · DURATION · TOKENS · COST — REAL data (run
          summary agent, /metrics/runs duration, cost breakdown). Fields with no data are omitted. */}
      {(() => {
        const model = Object.keys(cost?.byModel ?? {}).find((m) => m && m !== 'unknown');
        const items: { k: string; v: string; accent?: boolean }[] = [
          ...(runAgent ? [{ k: t('metaAgent'), v: runAgent }] : []),
          ...(model ? [{ k: t('metaModel'), v: model }] : []),
          ...(metric?.durationMs != null ? [{ k: t('metaDuration'), v: fmtDur(metric.durationMs) }] : []),
          ...(cost?.totalTokens ? [{ k: t('metaTokens'), v: fmtTok(cost.totalTokens) }] : []),
          ...(cost ? [{ k: t('metaCost'), v: `$${cost.costUsd.toFixed(4)}`, accent: true }] : []),
        ];
        if (!items.length) return null;
        return (
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-border px-4 py-2.5">
            {items.map((it) => (
              <div key={it.k} className="min-w-0">
                <div className="microlabel text-muted-foreground">{it.k}</div>
                {/* D6-4: the cost figure used to be brand/lime — a static data value isn't a "live" state
                    nor a primary action, so the emphasis is now weight-only (no color spent on it). */}
                <div className={cn('mt-0.5 truncate font-mono text-sm', it.accent ? 'font-semibold text-foreground' : 'text-foreground')}>{it.v}</div>
              </div>
            ))}
          </div>
        );
      })()}
      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title={t('purgeDialogTitle', { runId })}
        description={t('purgeDialogDescription')}
        confirmLabel={t('purgeConfirmLabel')}
        destructive
        onConfirm={() => void doPurge()}
      />
      <ConfirmDialog
        open={unwindOpen}
        onOpenChange={setUnwindOpen}
        title={t('unwindDialogTitle', { runId })}
        description={t('unwindDialogDescription')}
        confirmLabel={t('unwindConfirmLabel')}
        destructive
        onConfirm={() => void doUnwind()}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('cancelRunDialogTitle', { runId })}
        description={t('cancelRunDialogDescription')}
        confirmLabel={t('cancelRunConfirmLabel')}
        destructive
        onConfirm={() => void doCancel()}
      />

      {suspended && caps?.resume && <Approvals runId={runId} onDone={refresh} />}

      <div className="px-4 pt-2">
        <Tabs<TabId>
          active={tab}
          onChange={onTabChange}
          tabs={tabDefs}
        />
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'conversation' && (
          <div className="space-y-4">
            {/* Journal step-timeline (mockup's primary Journal view) → then the message/time-travel view below. */}
            <JournalTimeline runId={runId} />
            <div className="border-t border-border pt-4">
              <ConversationView runId={runId} steps={run.data?.length ?? 0} canFork={!!caps?.fork} onFork={onFork} />
            </div>
          </div>
        )}
        {tab === 'trace' && <TraceView runId={runId} />}
        {tab === 'cost' && cost && <CostSummary cost={cost} />}
        {tab === 'network' && <NetworkView runId={runId} />}
        {tab === 'forks' && <ForkView runId={runId} allRuns={allRuns} onSelectRun={onSelectRun} />}
        {/* Kept mounted (not conditionally rendered): a regression run is a REAL paid model call —
            switching to another tab must not lose the report/inputs (FLOW-01). Hidden via CSS instead
            of unmounting; RegressionView makes no request on mount, so this costs nothing until the
            user clicks "Re-run"/"Diff". Only this tab needs this treatment. */}
        {caps?.regression && (
          <div className={cn(tab !== 'regression' && 'hidden')}>
            <RegressionView runId={runId} />
          </div>
        )}
        {tab === 'processors' && <ProcessorsView runId={runId} />}
        {tab === 'incidents' && <IncidentsView incidents={incidents.data?.incidents ?? []} />}
      </div>
    </div>
  );
}

/**
 * OTEL export button (caps.otelExport): sends the run trace to the APM the host has configured
 * (Langfuse/Honeycomb/Datadog/Collector) with ONE CLICK. Security: the target endpoint/API key is NOT
 * on the client — the server only triggers `opts.otelExport(runId)`, the host sends it out with its own configuration.
 */
function OtelExportButton({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const [busy, setBusy] = useState(false);
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await api.otelExport(runId);
      if (!r.ok) throw new Error(r.error ?? t('otelExportFailed'));
      toast.success(t('otelExportSuccessToast', { target: r.target ?? 'APM' }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Btn variant="ghost" size="xs" title={t('otelExportButtonTitle')} disabled={busy} onClick={() => void doExport()}>
      <UploadCloud size={13} /> {busy ? t('otelExporting') : t('otelExportButton')}
    </Btn>
  );
}

/**
 * Journal event inspector: raw entry stream — kind filter + key/content search + ts.
 * Journal = single source of truth; this view shows it as-is, filterable.
 */
function Timeline({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const run = useRun(runId);
  const [kind, setKind] = useState<'all' | 'model' | 'tool'>('all');
  const [q, setQ] = useState('');
  const entries = useMemo(() => {
    const list = run.data ?? [];
    const t0 = list.find((e) => e.ts != null)?.ts;
    return list
      .filter((e) => kind === 'all' || e.kind === kind)
      .filter((e) => !q || e.key.toLowerCase().includes(q.toLowerCase()) || JSON.stringify(e.value).toLowerCase().includes(q.toLowerCase()))
      .map((e) => ({ ...e, relMs: e.ts != null && t0 != null ? e.ts - t0 : null }));
  }, [run.data, kind, q]);

  if (run.isLoading) return <Spinner />;
  if (run.error) return <ErrorBox error={run.error} />;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(['all', 'model', 'tool'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
              // D6-4: filter-toggle selection state — see the status filter above for the same reasoning.
              kind === k ? 'border-border bg-muted text-foreground font-semibold' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {k === 'all' ? t('all') : k}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchKeyOrContent')}
          className="ml-auto w-56 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none"
        />
        <span className="text-[11px] text-muted-foreground">{entries.length} entry</span>
      </div>
      {/* Console/log pattern: ink background + JetBrains Mono; model=info "›" (step/command), tool=green "✓"
          (executed action) — the Badge already gives the kind as text too (color+text double-coding).
          D6-4: model kind used to be lime/brand here — now info, matching the SAME model/tool coloring
          JournalTimeline (this file's primary Journal view) and TraceView already use, so "model" reads
          the same color everywhere in Inspector instead of competing with the sparse brand accent.
          Journal-append feel: entries appear in sequence — as if being written to the journal. */}
      <Stagger as={motion.ol} className="space-y-2 rounded-md border border-border bg-background p-2">
        {entries.map((e) => (
          <StaggerItem as={motion.li} key={e.key} className="rounded-md border border-border/60 bg-card p-2.5 font-mono">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span aria-hidden className={e.kind === 'model' ? 'text-info' : 'text-success'}>
                {e.kind === 'model' ? '›' : '✓'}
              </span>
              <Badge tone={e.kind === 'model' ? 'info' : 'success'}>{e.kind}</Badge>
              <span className="text-muted-foreground">#{e.seq}</span>
              <span className="truncate text-[10px] text-muted-foreground">{e.key}</span>
              {e.relMs != null && (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                  <span aria-hidden>→</span>t+{e.relMs}ms
                </span>
              )}
            </div>
            <JsonBlock value={e.value} max={600} />
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}

// Extract displayable text from a message (string content or text parts; other part types as [type]).
function msgText(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p?.text === 'string' ? p.text : p?.type ? `[${p.type}]` : '')).filter(Boolean).join(' ');
  }
  return c == null ? '' : JSON.stringify(c);
}

/** Returns ONLY the REAL text — SKIPS type placeholders like `[tool-call]`/`[tool-result]`
    (these are shown as separate, readable blocks → the body stays free of noise). */
function bodyText(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return '';
}

/** Converts a tool arg into readable `key: value` pairs or short text (instead of escaped raw JSON). */
function fmtToolArgs(args: unknown): { k: string; v: string }[] | string {
  const short = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 60) + '…' : (s ?? ''); };
  if (args == null) return '';
  if (typeof args === 'object' && !Array.isArray(args)) return Object.entries(args as Record<string, unknown>).map(([k, v]) => ({ k, v: short(v) }));
  return short(args);
}

const ROLE_TONE: Record<string, 'info' | 'success' | 'warning' | 'muted'> = {
  user: 'info', assistant: 'success', tool: 'warning', system: 'muted',
};

/** Shows the assistant's tool-calls as a READABLE card: 🔧 tool name + args (key: value) —
    instead of an escaped raw JSON chip. */
export function ToolCallChips({ content }: { content: any }) {
  if (!Array.isArray(content)) return null;
  const calls = content.filter((p: any) => p?.type === 'tool-call');
  if (calls.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {calls.map((p: any, i: number) => {
        const args = fmtToolArgs(p.input ?? p.args);
        return (
          // D6-4: this chip identifies a TOOL call — recolored from brand/lime to the same success/green
          // used for "tool" everywhere else in Inspector (Timeline, TraceView, JournalTimeline), instead
          // of spending the sparse brand accent on a kind label.
          <div key={i} className="rounded-md border border-success/30 bg-success/5 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-[13px]">
              <Wrench size={12} className="text-success" />
              <span className="font-mono font-semibold text-foreground">{p.toolName}</span>
            </div>
            {Array.isArray(args) && args.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                {args.map((a) => <span key={a.k}><span className="text-foreground/70">{a.k}:</span> {a.v}</span>)}
              </div>
            )}
            {typeof args === 'string' && args && <div className="mt-1 font-mono text-[11px] text-muted-foreground">{args}</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Chat-first bubble (replaces MessageCard): aligned by role — user on the right (bg-muted),
 * assistant/tool on the left (tool slightly indented + status icon), system collapsed in a <details> at the top.
 * `entry` is the raw journal entry correlated with the message (if any) — usage/latency is shown inline, and
 * both the message JSON and entry.value appear together under the raw journal <details>.
 */
export function ChatBubble({ m, added, entry, latencyMs }: { m: any; added?: boolean; entry?: JournalEntry; latencyMs?: number }) {
  const { t } = useTranslation('inspector');
  const role = m?.role ?? '?';
  const body = bodyText(m); // only the real text — no [tool-call]/[tool-result] noise
  const tokens = (entry?.value as any)?.usage?.totalTokens;
  // Tool output: the message's OWN tool-result part is the primary source — reconstructState
  // (durable time-travel.ts) always carries `output` there. The journal `entry` is an ENRICHMENT
  // (status/usage/raw record); reading output only from it made every bubble whose entry
  // correlation missed say "(no result)" while the result sat unread in m.content[0].output.
  const resultPart = Array.isArray(m?.content) ? m.content.find((p: any) => p?.type === 'tool-result') : undefined;
  const toolOut = (entry?.value as any)?.output ?? resultPart?.output;
  // Failure: primarily the journal record's status (unchanged); when the entry correlation misses
  // (legacy args-mode records without resolvedToolCallIds), fall back to the shape of the message's
  // own output — reconstructState's unmatched branch emits the WHOLE record (with `status`) as
  // `output`, so a failed legacy tool no longer wears a green check over an error payload.
  const entryFailed = ['failed', 'error'].includes(String((entry?.value as any)?.status));
  const partOut = resultPart?.output as any;
  const partFailed = !entry && partOut != null && typeof partOut === 'object'
    && (partOut.error !== undefined || ['failed', 'error'].includes(String(partOut.status)));
  const toolFailed = role === 'tool' && (entryFailed || partFailed);
  const hasToolCalls = Array.isArray(m?.content) && m.content.some((p: any) => p?.type === 'tool-call');

  const rawDetails = (
    <details className="mt-1.5">
      <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">{t('rawJournal')}</summary>
      <JsonBlock value={m} max={800} />
      {entry?.value !== undefined && <div className="mt-1"><JsonBlock value={entry.value} max={800} /></div>}
    </details>
  );

  if (role === 'system') {
    return (
      <details className={cn('rounded-md border p-2.5', added ? 'border-brand/50 bg-brand/5' : 'border-border/60 bg-muted/10')}>
        <summary className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <Badge tone={ROLE_TONE[role] ?? 'muted'}>{role}</Badge>
          <span>{t('systemPromptLabel')}</span>
        </summary>
        <div className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{body || <span className="text-muted-foreground">{t('noText')}</span>}</div>
        {rawDetails}
      </details>
    );
  }

  return (
    <div
      className={cn(
        'max-w-[85%] rounded-md border p-3',
        role === 'user' ? 'ml-auto bg-muted' : role === 'tool' ? 'ml-6 bg-card' : 'bg-card',
        added ? 'border-brand/50 bg-brand/5' : 'border-border',
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone={ROLE_TONE[role] ?? 'muted'}>{role}</Badge>
        {role === 'tool' && <span aria-hidden className={toolFailed ? 'text-destructive' : 'text-success'}>{toolFailed ? '✗' : '✓'}</span>}
        {role === 'tool' && (m?.name || entry?.key) && <span className="truncate font-mono text-[11px] text-muted-foreground">{m?.name ?? entry?.key}</span>}
        {added && (
          <Reveal className="inline-flex">
            <span className="microlabel flex items-center gap-1 text-brand">
              <span aria-hidden>✓</span>{t('committedThisStep')}
            </span>
          </Reveal>
        )}
        {(typeof tokens === 'number' || latencyMs != null) && (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {typeof tokens === 'number' && <>{tokens} tok</>}
            {typeof tokens === 'number' && latencyMs != null && ' · '}
            {latencyMs != null && fmtSpanMs(latencyMs)}
          </span>
        )}
      </div>
      {/* Body: by role — a tool result is shown properly; a pure tool-call assistant message shows chips
          instead of text (no noise); if truly empty, a small "(none)" note. */}
      {role === 'tool' ? (
        body ? <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</div>
          : toolOut !== undefined ? <div className="mt-0.5"><JsonBlock value={toolOut} max={500} /></div>
          : <span className="text-[11px] text-muted-foreground">{t('noResult')}</span>
      ) : body ? (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</div>
      ) : !hasToolCalls ? (
        <span className="text-[11px] text-muted-foreground">{t('noText')}</span>
      ) : null}
      <MediaParts content={m?.content} />
      {role === 'assistant' && <ToolCallChips content={m?.content} />}
      {rawDetails}
    </div>
  );
}

/**
 * Chat-first conversation view: merges the old 'timeline' (Journal — raw entry stream) and 'state'
 * (Time-travel — materialized messages) tabs into a SINGLE tab. The default "Chat" mode, while raw journal
 * mode renders the existing `Timeline` AS-IS (untouched) — the journal remains separately accessible
 * as the single source of truth.
 */
function ConversationView({ runId, steps, canFork, onFork }: { runId: string; steps: number; canFork: boolean; onFork: (newRunId?: string) => void }) {
  const { t } = useTranslation('inspector');
  const [mode, setMode] = useState<'chat' | 'journal'>('chat');
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {(['chat', 'journal'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            className={cn(
              'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
              // D6-4: same filter-toggle reasoning as the status/kind filters above.
              mode === k ? 'border-border bg-muted text-foreground font-semibold' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {k === 'chat' ? t('chatMode') : t('journalMode')}
          </button>
        ))}
      </div>
      {mode === 'journal' ? <Timeline runId={runId} /> : <ChatReplay runId={runId} steps={steps} canFork={canFork} onFork={onFork} />}
    </div>
  );
}

/**
 * Chat mode: time-travel scrubber (moved from the old StateView) + a ChatBubble list. The message ↔ journal
 * entry correlation is display-only and NOT FRAGILE — assistant messages are mapped in order to `modelEntries`,
 * tool messages are mapped to `toolByCall` via `tool_call_id`/`toolCallId`; if the index overflows, the entry
 * silently stays undefined (usage/latency is shown optionally, it doesn't throw).
 */
function ChatReplay({ runId, steps, canFork, onFork }: { runId: string; steps: number; canFork: boolean; onFork: (newRunId?: string) => void }) {
  const { t } = useTranslation('inspector');
  const [step, setStep] = useState(steps);
  const eff = Math.min(step, steps);
  const state = useRunState(runId, eff);
  const diff = useDiff(runId, eff);
  const run = useRun(runId);
  const [forking, setForking] = useState(false);
  const [playing, setPlaying] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Playback: advance one step every 900ms; stop at the end. To start from step 0, use ⏮ + ▶.
  useEffect(() => {
    if (!playing) return;
    if (eff >= steps) { setPlaying(false); return; }
    const timer = setTimeout(() => setStep((s) => Math.min(steps, s + 1)), 900);
    return () => clearTimeout(timer);
  }, [playing, eff, steps]);
  // Scroll to the bottom as new frames are added during playback.
  useEffect(() => {
    if (playing) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [playing, state.data?.messages?.length]);

  const doFork = async () => {
    setForking(true);
    try {
      // The server resumes the new run IMMEDIATELY after forking (real model call = real cost) — so a
      // silently-swallowed error here would leave the user clicking again, spawning another paid fork
      // each time. Surface success/failure and switch to the new run so a repeat click isn't tempting.
      const res = await api.fork(runId, eff);
      toast.success(t('forkSuccessToast', { runId: res?.newRunId ?? '?' }));
      onFork(res?.newRunId);
    } catch (e) {
      toast.error(t('forkFailedToast', { message: errMessage(e) }));
    } finally {
      setForking(false);
    }
  };

  const msgs = state.data?.messages ?? [];
  const addedCount = diff.data?.added?.length ?? 0;

  // ── message ↔ raw journal entry correlation (display purposes only) ──
  const entries = run.data ?? [];
  const modelEntries = useMemo(() => entries.filter((e) => e.kind === 'model'), [entries]);
  // 'call'-mode keys end in the real toolCallId, but 'args'-mode keys end in `args-<tool>-<hash>` —
  // there the record's own `resolvedToolCallIds` (stamped by durable-tool.ts) carries the REAL id(s),
  // so index those too. Before this, args-mode tool bubbles never found their journal entry.
  const toolByCall = useMemo(() => {
    const map = new Map<string, JournalEntry>();
    for (const e of entries) {
      if (e.kind !== 'tool') continue;
      const suffix = e.key.split(':').pop();
      if (suffix) map.set(suffix, e);
      const resolved = (e.value as any)?.resolvedToolCallIds;
      if (Array.isArray(resolved)) for (const id of resolved) map.set(String(id), e);
    }
    return map;
  }, [entries]);
  let assistantIdx = 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="ghost" size="xs" onClick={() => { setPlaying(false); setStep(0); }} title={t('rewindTitle')}><SkipBack size={13} /></Btn>
        <Btn variant="ghost" size="xs" onClick={() => { setPlaying(false); setStep(Math.max(0, eff - 1)); }} title={t('stepBackTitle')}><ChevronLeft size={13} /></Btn>
        <Btn
          variant={playing ? 'default' : 'outline'}
          size="xs"
          onClick={() => { if (!playing && eff >= steps) setStep(0); setPlaying((p) => !p); }}
          title={playing ? t('pause') : t('playTitle')}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? t('pause') : t('play')}
        </Btn>
        <Btn variant="ghost" size="xs" onClick={() => { setPlaying(false); setStep(Math.min(steps, eff + 1)); }} title={t('stepForwardTitle')}><ChevronRight size={13} /></Btn>
        <Btn variant="ghost" size="xs" onClick={() => { setPlaying(false); setStep(steps); }} title={t('fastForwardTitle')}><SkipForward size={13} /></Btn>
        <input aria-label={t('stepSliderAriaLabel')} type="range" min={0} max={steps} value={eff} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} className="min-w-[80px] flex-1 accent-[hsl(var(--brand))]" />
        <span className="w-16 text-right font-mono text-xs tabular-nums text-muted-foreground">{eff}/{steps}</span>
        {canFork && (
          <Btn variant="outline" size="xs" onClick={doFork} disabled={forking} title={t('forkFromStepTitle')}>
            <GitFork size={13} /> {forking ? t('forkingLabel') : t('forkAtStep', { step: eff })}
          </Btn>
        )}
      </div>

      {state.isLoading ? <Spinner /> : state.error ? <ErrorBox error={state.error} /> : (
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn('record-dot', playing && 'record-dot--live')} aria-hidden />
            <span>{t('messageCount', { count: msgs.length })}</span>
            {addedCount > 0 && <span className="text-brand">{t('addedThisStep', { count: addedCount })}</span>}
            {state.data?.pending && state.data.pending.length > 0 && (
              <span className="text-warning">{t('pendingWaiting', { names: state.data.pending.map((p) => p.toolName).join(', ') })}</span>
            )}
          </div>
          <div className="space-y-3">
            {msgs.map((m, i) => {
              let entry: JournalEntry | undefined;
              let latencyMs: number | undefined;
              if (m?.role === 'assistant') {
                const idx = assistantIdx++;
                entry = modelEntries[idx];
                // latency = time elapsed from the previous model step to this one (including any tool execution in between).
                // There's no "previous" on the first step → don't show it (0ms would be misleading).
                if (idx > 0 && entry?.ts != null) {
                  const prevTs = modelEntries[idx - 1]?.ts;
                  if (prevTs != null) latencyMs = entry.ts - prevTs;
                }
              } else if (m?.role === 'tool') {
                // reconstructState puts the toolCallId INSIDE the tool-result content part, not on the
                // message root — reading only the root made `entry` undefined for every tool bubble.
                const part = Array.isArray(m?.content) ? m.content.find((p: any) => p?.type === 'tool-result') : undefined;
                const callId = m?.tool_call_id ?? m?.toolCallId ?? part?.toolCallId;
                entry = callId != null ? toolByCall.get(String(callId)) : undefined;
              }
              return <ChatBubble key={i} m={m} added={i >= msgs.length - addedCount} entry={entry} latencyMs={latencyMs} />;
            })}
            {msgs.length === 0 && <Empty>{t('step0Empty')}</Empty>}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function fmtSpanMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * A real nested waterfall: each span is one row — name in the left column (tools are indented
 * under the model step they belong to), a duration bar on a shared time axis on the right.
 * The server provides `parent`/`step` fields (server.ts /runs/:id/trace).
 */
function TraceView({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const trace = useTrace(runId);
  const [hover, setHover] = useState<number | null>(null);
  if (trace.isLoading) return <Spinner />;
  if (trace.error) return <ErrorBox error={trace.error} />;
  const spans = trace.data?.spans ?? [];
  const total = trace.data?.totalMs || 1;
  if (spans.length === 0) return <Empty>{t('noSpansEmpty')}</Empty>;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{fmtSpanMs(total)}</span>
        <span>·</span>
        <span className="font-mono tabular-nums">${trace.data?.cost.costUsd.toFixed(4)}</span>
        <span>·</span>
        <span>{spans.length} span</span>
      </div>

      {/* VIS-08: the name/duration columns are fixed-width — on a narrow viewport (detail is full-width
          below md) they used to eat almost the entire row, leaving only ~120px of bar strip with no way
          to scroll to see more (overflow-hidden). Now the wrapper scrolls horizontally instead of
          crushing the time axis; min-w-[520px] keeps the bar strip a legible width. Percent-based bar
          positioning (left/width) is untouched. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <div className="min-w-[520px]">
          {/* Axis header */}
          <div className="flex border-b border-border bg-muted/30 text-[10px] text-muted-foreground">
            <div className="microlabel w-32 shrink-0 border-r border-border px-2 py-1.5 md:w-48">span</div>
            <div className="relative h-6 flex-1">
              {ticks.map((tick) => (
                <span key={tick} className="absolute top-1.5 font-mono" style={{ left: `calc(${tick * 100}% + 3px)` }}>
                  {tick === 1 ? '' : fmtSpanMs(tick * total)}
                </span>
              ))}
            </div>
            <div className="w-16 shrink-0 border-l border-border px-2 py-1.5 text-right font-mono">{t('durationHeader')}</div>
          </div>

          {spans.map((s, i) => {
            const left = (s.startMs / total) * 100;
            const width = Math.max(0.5, (s.durationMs / total) * 100);
            const isTool = s.kind === 'tool';
            const failed = isTool && (s.attrs as any)?.status === 'failed';
            return (
              <div
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className={`flex border-b border-border/50 last:border-b-0 ${hover === i ? 'bg-muted/40' : ''}`}
              >
                <div className={`w-32 shrink-0 truncate border-r border-border px-2 py-1 font-mono text-[11px] md:w-48 ${isTool ? 'pl-6 text-muted-foreground' : ''}`}>
                  {isTool ? s.name : `llm.generate #${s.step ?? '?'}`}
                </div>
                <div className="relative flex-1">
                  {ticks.slice(1, 4).map((tick) => (
                    <div key={tick} className="absolute top-0 h-full border-l border-border/30" style={{ left: `${tick * 100}%` }} />
                  ))}
                  <div
                    className={`absolute top-1 h-4 rounded-[3px] ${failed ? 'bg-destructive/70' : isTool ? 'bg-success/60' : 'bg-info/60'}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </div>
                <div className="w-16 shrink-0 border-l border-border px-2 py-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {fmtSpanMs(s.durationMs)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Color key: kind identity via color + text (not color alone). D6-4: model=info (was brand/lime —
          that color is reserved for the live/record indicator and the primary action, see index.css),
          tool=green — same mapping as JournalTimeline/Timeline elsewhere in this file. */}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-info/60" /> model</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-success/60" /> tool</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-destructive/70" /> failed</span>
      </div>

      {hover != null && spans[hover] && (
        <div className="mt-2 rounded-md border border-border p-2 text-xs">
          <div className="mb-1 font-mono font-medium">
            {spans[hover].name} · {fmtSpanMs(spans[hover].durationMs)}
            {spans[hover].kind === 'tool' && spans[hover].parent != null && <> · {t('parentSpanLabel', { step: spans[spans[hover].parent!]?.step })}</>}
          </div>
          <JsonBlock value={spans[hover].attrs} max={300} />
        </div>
      )}
    </div>
  );
}

/** Journal step-timeline (new design): the run's steps as a vertical timeline — a type chip (model
    step / tool name) colored by kind, the step title, and per-step tokens/duration. Built from the
    SAME trace spans as the Trace tab (useTrace), presented as the mockup's Journal view. */
function JournalTimeline({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const trace = useTrace(runId);
  if (trace.isLoading) return <Spinner />;
  if (trace.error) return <ErrorBox error={trace.error} />;
  const spans = trace.data?.spans ?? [];
  if (!spans.length) return <Empty>{t('noSpansEmpty')}</Empty>;
  const spanTokens = (a: any): number | undefined => {
    const v = a?.totalTokens ?? a?.tokens ?? a?.usage?.totalTokens;
    return typeof v === 'number' ? v : undefined;
  };
  return (
    <ol className="space-y-0">
      {spans.map((s, i) => {
        const isTool = s.kind === 'tool';
        const failed = isTool && (s.attrs as any)?.status === 'failed';
        const last = i === spans.length - 1;
        const tok = spanTokens(s.attrs);
        const title = isTool ? `${s.name}()` : t('journalModelStep', { step: s.step ?? i + 1 });
        const chip = isTool ? s.name : 'model';
        return (
          <li key={i} className="relative flex gap-3 pb-5 pl-1 last:pb-0">
            {!last && <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-border" />}
            <span aria-hidden className={cn('mt-1 h-3.5 w-3.5 shrink-0 rounded-full ring-4 ring-background',
              failed ? 'bg-destructive' : isTool ? 'bg-success' : 'bg-info')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn('shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide',
                  failed ? 'bg-destructive/15 text-destructive' : isTool ? 'bg-success/15 text-success' : 'bg-info/15 text-info')}>{chip}</span>
                <span className="truncate font-medium text-foreground">{title}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {tok != null ? `${fmtTok(tok)} tok · ` : ''}{fmtDur(s.durationMs)}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Cost summary (header): total tokens/$ + cachedTokens if present; if `byModel` (model → calls/tokens/$)
 * is present, shows a breakdown under a <details> — the data already existed on the RunCost type, the display was missing.
 */
function CostSummary({ cost }: { cost: RunCost }) {
  const { t } = useTranslation('inspector');
  const byModel = cost.byModel && Object.keys(cost.byModel).length > 0 ? cost.byModel : null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>
        {cost.totalTokens} tok
        {/* D6-4: cache-hit count is a data callout, not a live/primary signal — dropped from brand to plain text. */}
        {!!cost.cachedTokens && <span className="text-foreground"> ({cost.cachedTokens} cache)</span>}
        {' · '}${cost.costUsd.toFixed(4)}
      </span>
      {byModel && (
        <details className="relative">
          <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">{t('modelBreakdown')}</summary>
          <div className="absolute z-10 mt-1 space-y-1 rounded-md border border-border bg-card p-2 shadow-md">
            {Object.entries(byModel).map(([model, v]: [string, any]) => (
              <div key={model} className="flex items-center gap-3 whitespace-nowrap font-mono text-[11px]">
                <span className="text-foreground">{model}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {t('modelCallsBreakdown', {
                    calls: v?.calls ?? '?',
                    tokens: v?.tokens ?? '?',
                    cost: `$${typeof v?.costUsd === 'number' ? v.costUsd.toFixed(4) : '?'}`,
                  })}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </span>
  );
}

// ── Network tab: the dynamic router's in-run routing decisions + sub-agent steps ──
// Server GET /runs/:id/network (getNetworkTrace) → { routes, steps }; matches the runNetwork.ts source
// one-to-one. Was never shown in the UI before (filling a gap).
export interface NetworkGraphNode { id: string; label: string; kind: 'router' | 'agent' | 'final'; task?: string; answer?: string }
export interface NetworkGraphEdge { id: string; source: string; target: string; label?: string }

/**
 * Pure transform (tested): routes/steps → a flat node/edge list. `router` starts at the root; on each
 * `route` decision, an edge labeled "turn i" is added to the target agent and the chain continues from that agent;
 * a `final` decision connects from the last node of the chain (the agent if there is one, otherwise the router)
 * to the final node. The order of i is established by the number within `routes` ('final' is always moved to the very end).
 */
export function buildNetworkGraph(
  trace: NetworkTrace,
  labels?: { router?: string; final?: string; turn?: (i: number) => string },
): { nodes: NetworkGraphNode[]; edges: NetworkGraphEdge[] } {
  const routerLabel = labels?.router ?? 'router';
  const finalLabel = labels?.final ?? 'final answer';
  const turnLabel = labels?.turn ?? ((i: number) => `turn ${i}`);
  const nodes: NetworkGraphNode[] = [{ id: 'router', label: routerLabel, kind: 'router' }];
  const edges: NetworkGraphEdge[] = [];
  const sorted = [...trace.routes].sort((a, b) => {
    const ai = a.i === 'final' ? Number.POSITIVE_INFINITY : a.i;
    const bi = b.i === 'final' ? Number.POSITIVE_INFINITY : b.i;
    return ai - bi;
  });
  let prev = 'router';
  for (const r of sorted) {
    if (r.decision.action === 'route') {
      const id = `agent:${r.i}`;
      nodes.push({ id, label: r.decision.agent, kind: 'agent', task: r.decision.task });
      edges.push({ id: `e${edges.length}`, source: prev, target: id, label: turnLabel(r.i as number) });
      prev = id;
    } else {
      const id = 'final';
      nodes.push({ id, label: finalLabel, kind: 'final', answer: r.decision.answer });
      edges.push({ id: `e${edges.length}`, source: prev, target: id });
      prev = id;
    }
  }
  return { nodes, edges };
}

// D6-4: router used to be 'brand' (lime) here purely as a third distinguishing hue for the graph's node
// kinds — not a live/primary signal — so it's now 'border' (the neutral border token, a structural
// node), leaving agent/final on their existing info/success tones. `tone` feeds directly into
// `hsl(var(--${tone}))` below, so 'border' resolves to the same --border CSS var used everywhere else.
const NETWORK_KIND_STYLE: Record<NetworkGraphNode['kind'], string> = { router: 'border', agent: 'info', final: 'success' };

// LR layout with dagre (same pattern as Workflows.tsx toFlowNodes) — purely visual, BROWSER VERIFICATION.
function toFlowNetwork(nodes: NetworkGraphNode[], edges: NetworkGraphEdge[]): { flowNodes: Node[]; flowEdges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 72 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: 180, height: 46 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  const flowNodes: Node[] = nodes.map((n) => {
    const p = g.node(n.id);
    const tone = NETWORK_KIND_STYLE[n.kind];
    const glyph = n.kind === 'router' ? '🧭' : n.kind === 'final' ? '🏁' : '🤖';
    return {
      id: n.id,
      position: { x: p.x - 90, y: p.y - 23 },
      data: { label: `${glyph} ${n.label}` },
      style: {
        width: 180, fontSize: 11, borderRadius: 8, padding: 8, textAlign: 'center' as const,
        border: `1px solid hsl(var(--${tone}))`,
        background: `hsl(var(--${tone})/0.12)`,
        color: 'hsl(var(--foreground))',
      },
    };
  });
  const flowEdges: Edge[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label, animated: true }));
  return { flowNodes, flowEdges };
}

// BROWSER VERIFICATION: xyflow + dagre graph layout (fitView/MiniMap/pan-zoom) can only be
// visually verified in a real browser; the pure transform (buildNetworkGraph) is tested separately.
function NetworkGraphView({ trace }: { trace: NetworkTrace }) {
  const { t } = useTranslation('inspector');
  const { flowNodes, flowEdges } = useMemo(() => {
    const { nodes, edges } = buildNetworkGraph(trace, {
      router: t('networkRouterNode'),
      final: t('networkFinalNode'),
      turn: (i) => t('networkTurnEdge', { i }),
    });
    return toFlowNetwork(nodes, edges);
  }, [trace, t]);
  return (
    <ReactFlow nodes={flowNodes} edges={flowEdges} fitView proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false}>
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}

/** Below the graph: the detail of the router's decision for each turn (task + generated text / final answer). */
function NetworkRouteList({ trace }: { trace: NetworkTrace }) {
  const { t } = useTranslation('inspector');
  const stepByI = useMemo(() => new Map(trace.steps.map((s) => [s.i, s])), [trace.steps]);
  const sorted = useMemo(() => [...trace.routes].sort((a, b) => {
    const ai = a.i === 'final' ? Number.POSITIVE_INFINITY : a.i;
    const bi = b.i === 'final' ? Number.POSITIVE_INFINITY : b.i;
    return ai - bi;
  }), [trace.routes]);
  return (
    <Stagger className="space-y-2">
      {sorted.map((r, idx) => {
        const decision = r.decision;
        if (decision.action === 'final') {
          // D6-4: matches NETWORK_KIND_STYLE's final=success above (was brand/lime here, an
          // inconsistency with the graph view's own "final" node color).
          return (
            <StaggerItem key={idx} className="rounded-md border border-success/50 bg-success/5 p-2.5">
              <div className="mb-1 flex items-center gap-2 font-mono text-xs">
                <span className="text-muted-foreground">{t('turnLabel', { i: r.i })}</span>
                <Badge tone="success">final</Badge>
              </div>
              <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{decision.answer}</div>
            </StaggerItem>
          );
        }
        const step = stepByI.get(r.i as number);
        return (
          <StaggerItem key={idx} className="rounded-md border border-border p-2.5">
            <div className="mb-1 flex items-center gap-2 font-mono text-xs">
              <span className="text-muted-foreground">{t('turnLabel', { i: r.i })}</span>
              <Badge tone="info">{decision.agent}</Badge>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{t('taskLabel', { task: decision.task })}</div>
              {step?.text && <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{step.text}</div>}
            </div>
          </StaggerItem>
        );
      })}
    </Stagger>
  );
}

function NetworkView({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const net = useRunNetwork(runId);
  if (net.isLoading) return <Spinner />;
  if (net.error) return <ErrorBox error={net.error} />;
  const trace = net.data;
  if (!trace || (trace.routes.length === 0 && trace.steps.length === 0)) {
    return <Empty>{t('networkNotUsedEmpty')}</Empty>;
  }
  return (
    <div className="space-y-3">
      <div className="h-80 overflow-hidden rounded-md border border-border">
        <NetworkGraphView trace={trace} />
      </div>
      <NetworkRouteList trace={trace} />
    </div>
  );
}

/**
 * Fork lineage tree (run genealogy): derived from the `<source>:fork:<ts>` naming convention.
 * Since every fork is an independent run in the journal, both the tree and the diff between any two branches are cheap.
 */
function ForkView({ runId, allRuns, onSelectRun }: { runId: string; allRuns: RunSummary[]; onSelectRun: (id: string) => void }) {
  const { t } = useTranslation('inspector');
  const root = forkRoot(runId);
  const family = useMemo(() => allRuns.filter((r) => forkRoot(r.runId) === root), [allRuns, root]);
  const children = useMemo(() => {
    const map = new Map<string, RunSummary[]>();
    for (const r of family) {
      const p = forkParent(r.runId);
      if (p) map.set(p, [...(map.get(p) ?? []), r]);
    }
    return map;
  }, [family]);
  const [diffWith, setDiffWith] = useState<string | null>(null);

  if (family.length <= 1) {
    return (
      <Empty>
        {t('noForksPart1')} <b>Fork</b> {t('noForksPart2')}
      </Empty>
    );
  }

  const rootSummary = family.find((r) => r.runId === root);

  function Node({ id, depth }: { id: string; depth: number }) {
    const summary = family.find((r) => r.runId === id);
    const kids = (children.get(id) ?? []).slice().sort((a, b) => a.runId.localeCompare(b.runId));
    const isCurrent = id === runId;
    const shortId = depth === 0 ? id : ':fork:' + id.slice(id.lastIndexOf(':fork:') + ':fork:'.length);
    return (
      <div>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5',
            // D6-4: "the currently open run" in the lineage tree is a selected-row state, same species
            // as RunRow's own `active ? 'bg-muted' : ...` in the left list — not the live/primary case.
            // The record-dot right below still pulses (record-dot--live) for this node, so "current" is
            // still double-coded (fill + pulsing dot), just without spending brand on the border/fill too.
            isCurrent ? 'border-border bg-muted font-medium' : 'border-border',
          )}
          style={{ marginLeft: depth * 24 }}
        >
          <span className={cn('record-dot shrink-0', isCurrent && 'record-dot--live')} aria-hidden />
          <button type="button" onClick={() => onSelectRun(id)} className="truncate font-mono text-xs hover:underline" title={id}>
            {shortId}
          </button>
          {summary && <StatusBadge status={summary.status} />}
          {summary && <span className="text-[10px] text-muted-foreground">{summary.modelSteps}m·{summary.toolCalls}t</span>}
          {!isCurrent && (
            <Btn variant="ghost" size="xs" onClick={() => setDiffWith(diffWith === id ? null : id)} title={t('compareTitle', { a: runId, b: id })}>
              <Columns2 size={12} /> diff
            </Btn>
          )}
        </div>
        {kids.length > 0 && (
          <div className="mt-1 space-y-1">
            {kids.map((k) => <Node key={k.runId} id={k.runId} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="microlabel mb-2 text-muted-foreground">{t('forkLineageLabel', { root: rootSummary ? root : `${root}${t('rootDeletedSuffix')}` })}</div>
        <Node id={root} depth={0} />
      </div>
      {diffWith && <DiffPair a={runId} b={diffWith} />}
    </div>
  );
}

/**
 * Replay-diff: the conversations materialized from two runs' journals, side by side.
 * The common prefix is faded; diverging messages are highlighted info-blue on the left (A, current
 * branch) and green on the right (B, compared branch) — coded not just by color but also by the "A"/"B"
 * letter and a "diverged" micro-label (color+text double-coding). D6-4: A used to be brand/lime; that
 * accent is reserved for the live/record indicator and the primary action elsewhere in Inspector, so
 * this two-way branch coding now uses info/success instead.
 * "What-if" analysis — shows after which decision point the branches diverge.
 */
function DiffPair({ a, b }: { a: string; b: string }) {
  const { t } = useTranslation('inspector');
  const sa = useRunState(a);
  const sb = useRunState(b);
  if (sa.isLoading || sb.isLoading) return <Spinner />;
  // A failed fetch on either side must NOT fall through to "0 common · A +0 · B +0" — this is a
  // decision surface (fork vs. base comparison), and a silent-looking "no difference" is worse than an error.
  if (sa.error || sb.error) return <ErrorBox error={sa.error ?? sb.error} />;
  const ma = sa.data?.messages ?? [];
  const mb = sb.data?.messages ?? [];
  let prefix = 0;
  while (prefix < ma.length && prefix < mb.length && JSON.stringify(ma[prefix]) === JSON.stringify(mb[prefix])) prefix++;

  const col = (id: string, msgs: any[], tint: 'info' | 'success') => (
    <div className="min-w-0">
      <div className="mb-2 truncate font-mono text-xs font-medium" title={id}>{id}</div>
      <div className="space-y-1.5">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={cn(
              'rounded-md border p-2',
              i < prefix
                ? 'border-border opacity-55'
                : tint === 'info' ? 'border-info/50 bg-info/5' : 'border-success/50 bg-success/5',
            )}
          >
            <div className="mb-0.5 flex items-center gap-2">
              <Badge tone={ROLE_TONE[m?.role] ?? 'muted'}>{m?.role ?? '?'}</Badge>
              {i >= prefix && <span className={cn('microlabel', tint === 'info' ? 'text-info' : 'text-success')}>{t('divergenceLabel')}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">{msgText(m) || <span className="text-muted-foreground">{t('noText')}</span>}</div>
            <MediaParts content={m?.content} />
          </div>
        ))}
        {msgs.length === 0 && <Empty>{t('noMessagesEmpty')}</Empty>}
      </div>
    </div>
  );

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="microlabel">REPLAY-DIFF</span>
        <span><b className="text-foreground">{prefix}</b> {t('commonMessagesFaded')}</span>
        <span className="text-info">A +{ma.length - prefix}</span>
        <span className="text-success">B +{mb.length - prefix}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {col(a, ma, 'info')}
        {col(b, mb, 'success')}
      </div>
      {prefix < ma.length && prefix < mb.length && (
        <div className="mt-3 min-w-0">
          <div className="microlabel mb-1 text-muted-foreground">{t('firstDivergentLineDiff')}</div>
          <TextDiff a={msgText(ma[prefix]) ?? ''} b={msgText(mb[prefix]) ?? ''} />
        </div>
      )}
    </div>
  );
}

// ── W5: Regression — re-run a recorded run with a new model/system (replayRun) or compare it
// against an existing run (without re-running); both paths return the SAME decision-point diff (durable
// diffRuns) → the result display is consolidated into a single DecisionList component.
// D6-4: 'changed' used to map to 'brand' (lime) — recolored to 'info' (kept distinct from 'warning',
// already used for 'added', and from 'destructive', already used for 'missing', so all four decision
// outcomes stay visually distinguishable without spending the brand accent on a status label).
const DURUM_TONE: Record<RegressionDiffEntry['durum'], 'muted' | 'info' | 'destructive' | 'warning'> = {
  same: 'muted', changed: 'info', missing: 'destructive', added: 'warning',
};

/** Shows the detail of a single decision point (model: text+tool-calls · tool: status/argsHash/output). */
function DecisionDetail({ entry }: { entry: RegressionDiffEntry }) {
  const { t } = useTranslation('inspector');
  const d = entry.detay;
  if (!d) return null;
  if (d.note) return <div className="text-xs text-muted-foreground">{d.note}</div>;
  if (entry.kind === 'model') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <div className="microlabel text-muted-foreground">{t('baseLabel')}</div>
          {d.textA !== undefined && <div className="whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-1.5 font-mono text-[11px]">{d.textA || <span className="text-muted-foreground">{t('noText')}</span>}</div>}
          {d.toolCallsA && d.toolCallsA.length > 0 && (
            <div className="flex flex-wrap gap-1">{d.toolCallsA.map((tc, i) => <Badge key={i} tone="model">{tc.toolName}·{tc.argsHash.slice(0, 8)}</Badge>)}</div>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="microlabel text-muted-foreground">{t('newLabel')}</div>
          {/* D6-4: was bg-brand/5 — recolored to info to match DURUM_TONE.changed below. */}
          {d.textB !== undefined && <div className="whitespace-pre-wrap break-words rounded-sm bg-info/5 p-1.5 font-mono text-[11px]">{d.textB || <span className="text-muted-foreground">{t('noText')}</span>}</div>}
          {d.toolCallsB && d.toolCallsB.length > 0 && (
            <div className="flex flex-wrap gap-1">{d.toolCallsB.map((tc, i) => <Badge key={i} tone="model">{tc.toolName}·{tc.argsHash.slice(0, 8)}</Badge>)}</div>
          )}
        </div>
        {d.textA !== undefined && d.textB !== undefined && d.textA !== d.textB && (
          <div className="col-span-2 min-w-0">
            <div className="microlabel mb-1 text-muted-foreground">{t('lineDiffLabel')}</div>
            <TextDiff a={d.textA} b={d.textB} />
          </div>
        )}
      </div>
    );
  }
  // tool
  return (
    <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
      <div className="min-w-0 space-y-1">
        <div className="microlabel text-muted-foreground">{t('baseLabel')}</div>
        {d.statusA !== undefined && <div>{t('statusWord')} <span className="text-foreground">{d.statusA}</span></div>}
        {d.argsHashA !== undefined && <div>argsHash: {d.argsHashA.slice(0, 12)}</div>}
        {d.outputA !== undefined && <JsonBlock value={d.outputA} max={300} />}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="microlabel text-muted-foreground">{t('newLabel')}</div>
        {d.statusB !== undefined && <div>{t('statusWord')} <span className="text-foreground">{d.statusB}</span></div>}
        {d.argsHashB !== undefined && <div>argsHash: {d.argsHashB.slice(0, 12)}</div>}
        {d.outputB !== undefined && <JsonBlock value={d.outputB} max={300} />}
      </div>
    </div>
  );
}

/** Decision-point list + divergentAt summary — POST (re-run) and GET (existing run diff) share the SAME schema. */
function DecisionList({ report }: { report: RegressionReport }) {
  const { t } = useTranslation('inspector');
  const DURUM_LABEL: Record<RegressionDiffEntry['durum'], string> = {
    same: t('durumSame'), changed: t('durumChanged'), missing: t('durumMissing'), added: t('durumAdded'),
  };
  const { diff } = report;
  return (
    <div className="space-y-3">
      <Reveal>
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2.5 text-xs">
          <span className="microlabel text-muted-foreground">{t('resultLabel')}</span>
          <span className="font-mono">{report.baseRunId} <span className="text-muted-foreground">↔</span> {report.newRunId}</span>
          <span className="ml-auto flex gap-1.5">
            <Badge tone="muted">{t('summarySame', { count: diff.summary.same })}</Badge>
            <Badge tone="info">{t('summaryChanged', { count: diff.summary.changed })}</Badge>
            {diff.summary.missing > 0 && <Badge tone="destructive">{t('summaryMissing', { count: diff.summary.missing })}</Badge>}
            {diff.summary.added > 0 && <Badge tone="warning">{t('summaryAdded', { count: diff.summary.added })}</Badge>}
          </span>
        </div>
      </Reveal>
      <Reveal delay={0.05}>
        {diff.divergentAt === undefined ? (
          <div className="rounded-md border border-success/40 bg-success/5 p-2.5 text-xs text-success">{t('allDecisionsSame')}</div>
        ) : (
          // D6-4: was border/bg/text-brand — recolored to info, matching DURUM_TONE.changed above.
          <div className="rounded-md border border-info/40 bg-info/5 p-2.5 text-xs text-info">{t('firstDivergence', { index: diff.divergentAt, kind: diff.steps[diff.divergentAt]?.kind })}</div>
        )}
      </Reveal>
      {diff.steps.length === 0 ? (
        <Empty>{t('noDecisionPointsEmpty')}</Empty>
      ) : (
        <Stagger className="space-y-2">
          {diff.steps.map((s, i) => (
            <StaggerItem
              key={i}
              className={cn(
                'rounded-md border p-2.5',
                i === diff.divergentAt ? 'border-info/60' : 'border-border',
                s.durum === 'same' && 'opacity-70',
              )}
            >
              <div className="mb-1.5 flex items-center gap-2 font-mono text-xs">
                <span className="text-muted-foreground">#{i}</span>
                <Badge tone={s.kind === 'model' ? 'model' : 'success'}>{s.kind}</Badge>
                <span className="text-muted-foreground">{t('stepLabel', { step: s.step })}</span>
                <Badge tone={DURUM_TONE[s.durum]}>{DURUM_LABEL[s.durum]}</Badge>
              </div>
              <DecisionDetail entry={s} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

// ── Processor (audit/compliance) tab: findings left behind by pii-redactor/prompt-injection/moderation
// processors in this run (@gnldev/durable readProcessorReports — GET /runs/:id/processors).
// BROWSER VERIFICATION: this view's actual visual layout must be manually verified (within this task's
// scope only the code/data-flow was written and auto-tested).
/** Short summary for known built-in processors; unknown ones fall back to raw JSON. `t` is passed in by
    the caller (component) — a pure function can't call a hook. */
function summarizeProcessorFindings(r: ProcessorReport, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  const f = r.findings as any;
  if (r.name === 'pii-redactor' && f && typeof f.redactedCount === 'number') {
    const types = Array.isArray(f.types) && f.types.length ? ` (${f.types.join(', ')})` : '';
    return t('piiRedactedSummary', { count: f.redactedCount, types });
  }
  if (r.name === 'prompt-injection' && f && Array.isArray(f.matched)) {
    return t('promptInjectionSummary', { matched: f.matched.join(', ') });
  }
  if (r.name === 'moderation' && f && typeof f.hit === 'string') {
    return t('moderationSummary', { hit: f.hit });
  }
  return null;
}

function ProcessorReportCard({ r }: { r: ProcessorReport }) {
  const { t } = useTranslation('inspector');
  const PROCESSOR_PHASE_LABEL: Record<ProcessorReport['phase'], string> = {
    input: t('processorPhaseInput'), output: t('processorPhaseOutput'), tool: t('processorPhaseTool'),
  };
  const summary = summarizeProcessorFindings(r, t);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        {/* D6-4: processor name was tone="brand" — just a data label, not live/primary; "info" keeps it
            visually distinct from the neutral phase chip beside it without spending the brand accent. */}
        <Badge tone="info">{r.name}</Badge>
        <Badge tone="muted">{PROCESSOR_PHASE_LABEL[r.phase]}</Badge>
        {r.ts != null && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{new Date(r.ts).toLocaleString()}</span>}
      </div>
      {summary && <p className="mt-2 text-sm">{summary}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">{t('rawFindings')}</summary>
        <div className="mt-1"><JsonBlock value={r.findings} /></div>
      </details>
    </div>
  );
}

function ProcessorsView({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const q = useProcessorReports(runId);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const reports = q.data?.reports ?? [];
  if (reports.length === 0) return <Empty>{t('noProcessorRecordsEmpty')}</Empty>;
  return (
    <Stagger className="space-y-2">
      {reports.map((r, i) => (
        <StaggerItem key={`${r.name}:${r.phase}:${i}`}>
          <ProcessorReportCard r={r} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/** Guard incidents (duplicate guard / loop detection / maxToolCalls): each row = one journaled runtime
    decision — when, which mechanism, what it did, on which tool call, and the VERBATIM message. Tones
    mirror severity: 'block' destructive, 'warn'/'suspend' warning, 'reflect' info. */
const INCIDENT_TONE: Record<RunIncident['action'], 'destructive' | 'warning' | 'info'> = {
  block: 'destructive', warn: 'warning', suspend: 'warning', reflect: 'info',
};

function IncidentsView({ incidents }: { incidents: RunIncident[] }) {
  const { t, i18n } = useTranslation('inspector');
  if (incidents.length === 0) return <Empty>{t('noIncidentsEmpty')}</Empty>;
  return (
    <Stagger className="space-y-2">
      {incidents.map((inc) => (
        <StaggerItem key={`${inc.toolCallId}:${inc.source}:${inc.action}`} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={INCIDENT_TONE[inc.action]}>{inc.action}</Badge>
            <Badge tone="muted">{inc.source}</Badge>
            <span className="font-mono text-xs text-foreground">{inc.toolName}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{inc.toolCallId}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {new Date(inc.at).toLocaleString(i18n.language === 'tr' ? 'tr-TR' : 'en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{inc.message}</p>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

function RegressionView({ runId }: { runId: string }) {
  const { t } = useTranslation('inspector');
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('');
  const [memoryOff, setMemoryOff] = useState(false);
  const [otherRunId, setOtherRunId] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RegressionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAgain = async () => {
    setRunning(true); setError(null);
    try {
      const r = await api.runRegression(runId, { model: model.trim(), ...(system.trim() ? { system: system.trim() } : {}), ...(memoryOff ? { memoryOff: true } : {}) });
      setReport(r);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  const diffExisting = async () => {
    setRunning(true); setError(null);
    try {
      const r = await api.regressionDiff(runId, otherRunId.trim());
      setReport(r);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border p-3">
        {/* D6-4: section-heading icon, not the actual action — the real "Re-run" Btn below stays
            variant="primary" (brand); this icon no longer needs its own brand tint. */}
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FlaskConical size={13} className="text-foreground" /> {t('rerun')}
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('rerunDescription')}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[220px] space-y-1">
            <span className="microlabel text-muted-foreground">{t('modelOverrideLabel')}</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('modelOverridePlaceholder')}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none"
            />
          </label>
          <label className="flex-1 min-w-[220px] space-y-1">
            <span className="microlabel text-muted-foreground">{t('systemOverrideLabel')}</span>
            <input
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder={t('systemOverridePlaceholder')}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none"
            />
          </label>
          <Btn variant="primary" size="sm" disabled={running || !model.trim()} onClick={runAgain} arrow>
            {running ? t('running') : t('rerun')}
          </Btn>
        </div>
        {/* Counterfactual memory-off replay: strips what the ':memctx' provenance PROVES was injected
            (recall/window/observations) and re-asks — turning "it probably read it from memory" into
            an experiment. The frozen system string (working memory, if any) is not edited; say so. */}
        <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={memoryOff} onChange={(e) => setMemoryOff(e.target.checked)} className="mt-0.5 accent-primary" />
          <span>
            <span className="font-medium text-foreground">{t('memoryOffLabel')}</span>
            <span className="block text-[11px]">{t('memoryOffNote')}</span>
          </span>
        </label>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="mb-2 text-xs font-medium text-foreground">{t('orCompareExisting')}</div>
        <div className="flex items-end gap-2">
          <label className="flex-1 space-y-1">
            <span className="microlabel text-muted-foreground">{t('otherRunIdLabel')}</span>
            <input
              value={otherRunId}
              onChange={(e) => setOtherRunId(e.target.value)}
              placeholder={t('otherRunIdPlaceholder')}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none"
            />
          </label>
          <Btn variant="outline" size="sm" disabled={running || !otherRunId.trim()} onClick={diffExisting}>
            <Columns2 size={13} /> {t('diffButton')}
          </Btn>
        </div>
      </div>

      {error && <ErrorBox error={error} />}
      {running && <Spinner label={t('runningOrDiffing')} />}
      {report && <DecisionList report={report} />}
    </div>
  );
}

function Approvals({ runId, onDone }: { runId: string; onDone: () => void }) {
  const { t } = useTranslation('inspector');
  const state = useRunState(runId);
  const [busy, setBusy] = useState(false);
  const pending = state.data?.pending ?? [];
  if (pending.length === 0) return null;

  const decide = async (approvals: Record<string, boolean>) => {
    setBusy(true);
    const approved = Object.values(approvals).some((v) => v === true);
    try {
      await api.resume(runId, approvals);
      toast.success(approved ? t('approveSuccess') : t('denySuccess'));
      onDone();
    } catch (e) {
      // Multi-tab race: another tab/user may have already resolved this approval (409) →
      // show a clear message and still refresh so a stale 'pending' row doesn't linger in the UI.
      const conflict = e instanceof ApiError && e.status === 409;
      toast.error(conflict
        ? t('conflictError', { error: errMessage(e) })
        : t('actionError', { error: errMessage(e) }));
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-3 rounded-md border border-warning/40 bg-warning/10 p-3">
      <div className="mb-2 text-xs font-medium text-warning">{t('pendingApprovalTool', { count: pending.length })}</div>
      <div className="space-y-1.5">
        {pending.map((p) => (
          <div key={p.toolCallId} className="flex items-center justify-between gap-2 rounded-sm bg-background/60 px-2 py-1.5">
            <span className="font-mono text-xs">{p.toolName}</span>
            <div className="flex gap-1.5">
              <Btn variant="ok" size="xs" disabled={busy} onClick={() => decide({ [p.toolCallId]: true })}><Check size={13} /> {t('approve')}</Btn>
              <Btn variant="deny" size="xs" disabled={busy} onClick={() => decide({ [p.toolCallId]: false })}><X size={13} /> {t('reject')}</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
