// ThreadDetail — the thread-level half of the Inspector (option B of the Threads-tab critique:
// "the folder view solved nothing"). Design intent, in the product's own vocabulary: a CONVERSATION
// LEDGER. Turns are a real sequence, so they get real mono numbers (the one place the design system
// Allows numbering); the ledger stays quiet — the single bold element is the per-turn MEMORY CONTEXT
// Panel, because "what did memory inject into this turn, and why" is the question no competing tool
// Answers (trace-side tools see only the finished prompt).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronDown, ChevronRight, BrainCircuit, Ghost } from 'lucide-react';
import { useMemoryContext, useThreadMessages, type Capabilities, type MetricsRun, type RunSummary } from '../api';
import { StatusBadge, Empty, cn } from '../components';

/** Role tone for provenance refs — the SAME mapping the Inspector's chat bubbles use. */
const REF_ROLE_TONE: Record<string, string> = { user: 'text-info', assistant: 'text-success', tool: 'text-warning', system: 'text-muted-foreground' };

function refPreviewOf(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim();
  if (!Array.isArray(c)) return '';
  const short = (v: unknown) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
  const parts: string[] = [];
  for (const p of c) {
    if (typeof p?.text === 'string' && p.text) parts.push(p.text);
    else if (p?.type === 'tool-call') parts.push(`→ ${p.toolName ?? 'tool'}(${short(p.input ?? p.args)})`);
    else if (p?.type === 'tool-result') parts.push(`${p.toolName ?? 'tool'} → ${short(p.output ?? p.result)}`);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Mirrors RunDetail's duration formatting (short mono forms — the ledger column stays narrow). */
function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Per-turn memory provenance: served lazily (only when the turn's Memory row is expanded).
 * Rows use the journal vocabulary as mono eyebrows (RECALL / RECENT / WM / OM / TRIM) — these are
 * SDK terms, deliberately untranslated (the surrounding sentences are). An honest empty state for
 * Runs without a record — never an error.
 */
export function MemoryContextPanel({ runId, threadId, threadMessages }: {
  runId: string;
  /** For backfilling empty previews: refs whose record predates structural previews (old "—" rows). */
  threadId?: string;
  threadMessages?: any[];
}) {
  const { t } = useTranslation('inspector');
  const q = useMemoryContext(runId);
  // Frozen records can't be rewritten — but their refs carry seq, and the thread messages are already
  // Loaded by the ledger: derive the preview live when the frozen one is empty (same-thread refs only;
  // Cross-thread recall refs can't be resolved from this thread's list).
  const fill = (r: { threadId: string; seq: number; preview: string }): string =>
    r.preview || (threadId && r.threadId === threadId && threadMessages?.[r.seq] ? refPreviewOf(threadMessages[r.seq]) : '');
  if (q.isLoading) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('memLoading')}</div>;
  const ctx = q.data?.context ?? null;
  if (!ctx) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('memNoProvenance')}</div>;
  return (
    <div className="space-y-1.5 px-3 py-2">
      {ctx.recalled.map((r) => (
        <div key={`${r.threadId}:${r.seq}`} className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-info">recall</span>
          <span className="shrink-0 font-mono text-muted-foreground">#{r.seq}</span>
          {r.score !== undefined && (
            <span className="shrink-0 font-mono tabular-nums text-foreground" title={t('memSimilarityTitle')}>
              {r.score.toFixed(2)}
            </span>
          )}
          <span className="truncate text-muted-foreground">“{fill(r)}”</span>
        </div>
      ))}
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="microlabel shrink-0 text-muted-foreground">recent</span>
        <span className="text-muted-foreground">{t('memRecentCount', { count: ctx.recentCount })}</span>
      </div>
      {/* The window ITSELF — "what went to the model", ref by ref. Records written before the
          `recent` field existed fall back to the count line above alone. */}
      {ctx.recent?.map((r) => (
        <div key={`recent:${r.threadId}:${r.seq}`} className="flex items-baseline gap-2 pl-4 text-[11px]">
          <span className="shrink-0 font-mono text-muted-foreground">#{r.seq}</span>
          <span className={cn('microlabel shrink-0', REF_ROLE_TONE[r.role] ?? 'text-muted-foreground')}>{r.role}</span>
          <span className="truncate text-muted-foreground">{fill(r) ? `“${fill(r)}”` : '—'}</span>
        </div>
      ))}
      {ctx.recent && ctx.recentCount > ctx.recent.length && (
        <div className="pl-4 text-[11px] text-muted-foreground">{t('memRecentTruncated', { count: ctx.recentCount - ctx.recent.length })}</div>
      )}
      {ctx.observationCount !== undefined && ctx.observationCount > 0 && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">om</span>
          <span className="text-muted-foreground">{t('memObservations', { count: ctx.observationCount })}</span>
        </div>
      )}
      {ctx.workingMemoryChars !== undefined && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-muted-foreground">wm</span>
          <span className="text-muted-foreground">{t('memWorkingMemory', { chars: ctx.workingMemoryChars })}</span>
        </div>
      )}
      {ctx.echoTrimmed > 0 && (
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="microlabel shrink-0 text-warning">trim</span>
          <span className="text-muted-foreground">{t('memEchoTrimmed', { count: ctx.echoTrimmed })}</span>
        </div>
      )}
    </div>
  );
}

/** One ledger row: mono turn number · status · duration · cost, plus the expandable Memory panel. */
function TurnRow({ index, run, metric, onOpenRun, threadId, threadMessages }: {
  index: number; run: RunSummary; metric?: MetricsRun; onOpenRun: (id: string) => void;
  threadId?: string; threadMessages?: any[];
}) {
  const { t } = useTranslation('inspector');
  const [memOpen, setMemOpen] = useState(false);
  return (
    <div className="border-b border-border/60">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground">#{index + 1}</span>
        <button
          type="button"
          onClick={() => onOpenRun(run.runId)}
          title={t('openRunTitle')}
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-foreground hover:text-primary"
        >
          {run.runId}
        </button>
        <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">{fmtDur(metric?.durationMs)}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {metric ? `$${metric.costUsd.toFixed(4)}` : '—'}
        </span>
        <span className="shrink-0"><StatusBadge status={run.status} /></span>
      </div>
      <button
        type="button"
        onClick={() => setMemOpen((o) => !o)}
        aria-expanded={memOpen}
        className="flex w-full items-center gap-1.5 px-3 pb-1.5 pl-[2.5rem] text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {memOpen ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        <BrainCircuit size={11} className="shrink-0" />
        <span className="microlabel">{t('memoryContextToggle')}</span>
      </button>
      {memOpen && <div className="pl-[1.75rem]"><MemoryContextPanel runId={run.runId} threadId={threadId} threadMessages={threadMessages} /></div>}
    </div>
  );
}

/**
 * The thread-scoped detail pane. `runs` come in the left list's order (newest first) — the ledger
 * Reads oldest→newest, so it reverses. Aggregates are one quiet line, not a card strip (Chanel rule:
 * This pane's single bold element is the provenance panel, nothing else competes).
 */
/** A ghost row: a question whose run died before its first token — no run exists, only the
    write-ahead'ed message. Faded + dashed on purpose: this is an ABSENCE made visible. */
function GhostRow({ preview }: { preview: string }) {
  const { t } = useTranslation('inspector');
  return (
    <div className="flex items-center gap-3 border-b border-dashed border-border/60 px-3 py-2 opacity-70" title={t('ghostTurnTitle')}>
      <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground">—</span>
      <Ghost size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">“{preview}”</span>
      <span className="microlabel shrink-0 text-warning">{t('ghostTurnLabel')}</span>
    </div>
  );
}

type LedgerEntry = { kind: 'turn'; run: RunSummary } | { kind: 'ghost'; preview: string; key: string };

/**
 * Interleave completed turns (runs) with GHOST turns (unanswered questions — runs that died before
 * Their first token are invisible to /runs, but their write-ahead'ed message survives in the
 * Thread). Detection walks the thread messages: a user message immediately followed by another user
 * Message never got its answer. Any structural mismatch (multi-message inputs, seeded transcripts)
 * Falls back to the runs-only ledger — never guess an interleave that might lie.
 */
function buildLedger(messages: any[], orderedRuns: RunSummary[]): LedgerEntry[] {
  const runsOnly: LedgerEntry[] = orderedRuns.map((run) => ({ kind: 'turn', run }));
  if (!messages.length) return runsOnly;
  const queue = [...orderedRuns];
  const out: LedgerEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const next = messages[i + 1];
    if (next?.role === 'user') { out.push({ kind: 'ghost', preview: refPreviewOf(m), key: `g${i}` }); continue; }
    const run = queue.shift();
    if (run) { out.push({ kind: 'turn', run }); continue; }
    if (!next) { out.push({ kind: 'ghost', preview: refPreviewOf(m), key: `g${i}` }); continue; } // trailing, runless
    return runsOnly; // answered cluster with no matching run → structure we don't understand
  }
  if (queue.length) return runsOnly; // leftover runs → same
  return out;
}

export function ThreadDetail({ threadId, title, runs, metricsById, onOpenRun, onBack }: {
  threadId: string;
  title?: string;
  runs: RunSummary[];
  metricsById: Map<string, MetricsRun>;
  caps?: Capabilities;
  onOpenRun: (id: string) => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation('inspector');
  const msgs = useThreadMessages(threadId);
  const ordered = useMemo(() => [...runs].reverse(), [runs]); // ledger order: turn #1 first
  const ledger = useMemo(() => buildLedger(msgs.data ?? [], ordered), [msgs.data, ordered]);
  const ghosts = ledger.filter((e) => e.kind === 'ghost').length;
  const totalCost = ordered.reduce((n, r) => n + (metricsById.get(r.runId)?.costUsd ?? 0), 0);
  const totalMs = ordered.reduce((n, r) => n + (metricsById.get(r.runId)?.durationMs ?? 0), 0);
  let turnNo = 0;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {onBack && (
            <button type="button" onClick={onBack} title={t('backToThreadsTitle')} className="shrink-0 text-muted-foreground hover:text-foreground md:hidden">
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="microlabel shrink-0 text-muted-foreground">{t('threadEyebrow')}</span>
          <h2 className={cn('truncate text-sm', title ? 'font-semibold text-foreground' : 'font-mono text-muted-foreground')} title={threadId}>
            {title ?? threadId}
          </h2>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{t('turnCount', { count: ordered.length })}</span>
          {ghosts > 0 && <span className="text-warning">{t('ghostCount', { count: ghosts })}</span>}
          <span className="font-mono tabular-nums">${totalCost.toFixed(4)}</span>
          <span className="font-mono tabular-nums">{fmtDur(totalMs)}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {ledger.length === 0
          ? <Empty>{t('threadNoTurns')}</Empty>
          : ledger.map((e) =>
              e.kind === 'ghost'
                ? <GhostRow key={e.key} preview={e.preview} />
                : <TurnRow key={e.run.runId} index={turnNo++} run={e.run} metric={metricsById.get(e.run.runId)} onOpenRun={onOpenRun} threadId={threadId} threadMessages={msgs.data} />,
            )}
      </div>
    </div>
  );
}
