import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { useCapabilities, useSchedulerTriggers, type SchedulerTrigger } from '../api';
import { Spinner, Empty, EmptyState, ErrorBox, Badge, StatStrip } from '../components';
import { Stagger, StaggerItem } from '../motion';
// i18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';
import enScheduler from '../i18n/locales/en/scheduler.json';

// ── Pure logic (tested) — the server already returns the raw trigger state (kind/value/nextRunAt
// epoch ms); here only the PRESENTATION (readable duration/date/tone) is derived. See
// packages/scheduler/src/index.ts `listTriggers` for the @gnl/scheduler `TriggerInfo` shape. ──────
//
// These pure functions can also be called directly outside the component (from a test file); so
// they're not hard-dependent on the i18next context — `t` is optional, and if not given, a fallback
// that reads from en/scheduler.json (ENGLISH default) is used. The real view (the Scheduler
// component) passes its own `useTranslation('scheduler')` t, so it produces correct output for the active language (tr/en).
type Tx = (key: string, opts?: Record<string, unknown>) => string;
function interpolate(s: string, vars?: Record<string, unknown>): string {
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
}
const defaultT: Tx = (key, opts) => interpolate((enScheduler as Record<string, string>)[key] ?? key, opts);

/** ms → short readable duration like "5s" / "3m" / "2h" / "4d" (1 decimal digit if not a whole number). */
export function formatDurationMs(ms: number, t: Tx = defaultT): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const units: [number, string][] = [
    [86_400_000, t('unitDay')], [3_600_000, t('unitHour')], [60_000, t('unitMinute')], [1000, t('unitSecond')],
  ];
  for (const [unitMs, suffix] of units) {
    if (ms >= unitMs) {
      const n = ms / unitMs;
      return `${Number.isInteger(n) ? n : n.toFixed(1)}${suffix}`;
    }
  }
  return `${ms}ms`;
}

/** Trigger schedule description: cron expression / interval / one-time — the "Trigger" column in the table. */
export function formatSchedule(trigger: Pick<SchedulerTrigger, 'kind' | 'value'>, t: Tx = defaultT): string {
  if (trigger.kind === 'cron') return `cron ${trigger.value}`;
  if (trigger.kind === 'every') return t('everyPrefix', { duration: formatDurationMs(trigger.value as number, t) });
  return t('oneTime');
}

/** Readable relative position of nextRunAt vs `now`: "in 5m" (future) / "2h ago" (past) / "now" (near-zero) — localized via `t`. */
export function relativeToNow(nextRunAt: number, now: number = Date.now(), t: Tx = defaultT): string {
  const diff = nextRunAt - now;
  if (Math.abs(diff) < 1000) return t('relativeNow');
  return diff > 0 ? t('relativeIn', { duration: formatDurationMs(diff, t) }) : t('relativeAgo', { duration: formatDurationMs(-diff, t) });
}

/** Status badge tone: failed→destructive, done→success, pending+overdue→warning (so the delay is
 *  visible), pending+on-time→muted. */
export function statusTone(
  trigger: Pick<SchedulerTrigger, 'status' | 'nextRunAt'>,
  now: number = Date.now(),
): 'success' | 'warning' | 'destructive' | 'muted' {
  if (trigger.status === 'failed') return 'destructive';
  if (trigger.status === 'done') return 'success';
  return trigger.nextRunAt <= now ? 'warning' : 'muted';
}

// Scheduler: live table of @gnl/scheduler triggers (READ-ONLY from the journal — see server side
// GET /scheduler/triggers). Auto-refreshes every 5s (same live-list spirit as the Cache view).
export function Scheduler() {
  const { t } = useTranslation('scheduler');
  const caps = useCapabilities();
  const triggers = useSchedulerTriggers();

  if (caps.isLoading || triggers.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (!caps.data?.scheduler) return <Empty>{t('disabled')}</Empty>;
  if (triggers.error) return <ErrorBox error={triggers.error} />;
  if (!triggers.data?.length) return <EmptyState icon={Clock} title={t('emptyTitle')} description={t('emptyDescription')} />;

  const now = Date.now();
  const pending = triggers.data.filter((tr) => tr.status === 'pending');
  const soonest = pending.length ? Math.min(...pending.map((tr) => tr.nextRunAt)) : null;

  return (
    <div className="flex h-full flex-col">
    <StatStrip items={[
      { label: t('statSchedules'), value: String(triggers.data.length) },
      { label: t('statActive'), value: String(pending.length) },
      { label: t('statNextRun'), value: soonest != null ? relativeToNow(soonest, now, t) : '—' },
      { label: t('statFailures'), value: String(triggers.data.filter((tr) => tr.status === 'failed').length) },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="live-dot" aria-hidden />
        {t('liveStatus', { count: triggers.data.length })}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 pl-3 pr-3 font-medium">ID</th>
              <th className="py-1.5 pr-3 font-medium">Workflow</th>
              <th className="py-1.5 pr-3 font-medium">{t('colTrigger')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('colNextRun')}</th>
              <th className="py-1.5 pr-3 font-medium">Misfire</th>
              <th className="py-1.5 pr-3 font-medium">{t('colStatusAttempts')}</th>
            </tr>
          </thead>
          {/* Trigger rows appear with a journal-append feel (same pattern as the Jobs view). */}
          <Stagger as={motion.tbody}>
            {triggers.data.map((trg) => (
              <StaggerItem as={motion.tr} key={trg.id} className="border-b border-border/60 last:border-b-0">
                <td className="py-1.5 pl-3 pr-3 text-xs">
                  <span aria-hidden className="mr-1 text-brand">›</span>{trg.id}
                </td>
                <td className="py-1.5 pr-3">{trg.name}</td>
                <td className="py-1.5 pr-3 text-xs">{formatSchedule(trg, t)}</td>
                <td className="py-1.5 pr-3 text-xs">
                  {new Date(trg.nextRunAt).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  <span className="ml-1.5 text-muted-foreground">({relativeToNow(trg.nextRunAt, now, t)})</span>
                </td>
                <td className="py-1.5 pr-3"><Badge tone="muted">{trg.misfire}</Badge></td>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={statusTone(trg, now)}>{trg.status}</Badge>
                    <span className="text-xs text-muted-foreground">{trg.attempts}/{trg.maxAttempts}</span>
                  </span>
                  {trg.status === 'failed' && trg.lastError && (
                    <div className="mt-0.5 max-w-xs truncate text-[11px] text-destructive" title={trg.lastError}>{trg.lastError}</div>
                  )}
                </td>
              </StaggerItem>
            ))}
          </Stagger>
        </table>
      </div>
    </div>
    </div>
  );
}
