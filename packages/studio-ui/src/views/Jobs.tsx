import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ListChecks, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useJobs, useCapabilities, api, errMessage } from '../api';
import { Spinner, EmptyState, ErrorBox, Badge, Btn, StatStrip, PageHeader } from '../components';
import { toast } from '../ui';
import { Stagger, StaggerItem } from '../motion';
// I18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';

// GNL console/log pattern: lime›/green✓/muted→ glyphs per status (decorative, double-coded
// With the Badge text — doesn't rely on color+icon alone). done=done, failed=error, pending=queued.
function tone(s: string) {
  return s === 'done' ? 'success' : s === 'failed' ? 'destructive' : 'warning';
}
function StatusGlyph({ s }: { s: string }) {
  if (s === 'done') return <span aria-hidden className="text-success">✓</span>;
  if (s === 'failed') return <span aria-hidden className="text-destructive">✗</span>;
  return <span aria-hidden className="text-muted-foreground">→</span>;
}

// Queue/Jobs: live table of background jobs (@gnldev/queue listJobs). Refreshes every 3s.
export function Jobs() {
  const { t } = useTranslation('jobs');
  const jobs = useJobs();
  const caps = useCapabilities();
  const qc = useQueryClient();
  // Panel-wide lock (same busy pattern as Agents/Organizations): while a retry is in flight, a second
  // Click (on the same or another row) shouldn't race — retryJob is already one-shot (the server turns
  // A dead-letter job into a NEW job), but the button is still locked so back-to-back clicks don't open two separate new jobs.
  const [busyId, setBusyId] = useState<string | null>(null);
  const canRetry = !!caps.data?.queueManage;

  const retry = async (id: string) => {
    if (busyId != null) return;
    setBusyId(id);
    try {
      await api.retryJob(id);
      toast.success(t('retrySuccess', { id }));
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      toast.error(t('retryError', { error: errMessage(e) }));
    } finally {
      setBusyId(null);
    }
  };

  if (jobs.isLoading) return <Spinner />;
  if (jobs.error) return <ErrorBox error={jobs.error} />;
  if (!jobs.data?.length) return <EmptyState icon={ListChecks} title={t('emptyTitle')} description={t('emptyDescription')} />;

  const jc = (...sts: string[]) => jobs.data!.filter((j) => sts.includes(j.status)).length;
  return (
    <div className="flex h-full flex-col">
    {/* PageHeader stays a shrink-0 sibling above StatStrip — the scroll cab below it is what shrinks. */}
    <div className="shrink-0">
      <PageHeader title={t('title')} description={t('description')} />
    </div>
    <StatStrip items={[
      { label: t('statQueued'), value: String(jc('queued', 'pending')) },
      { label: t('statRunning'), value: String(jc('running', 'active')) },
      { label: t('statCompleted'), value: String(jc('completed', 'done', 'succeeded')) },
      { label: t('statDeadLetter'), value: String(jc('dead-letter', 'dead_letter', 'failed')) },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {/* record-dot, not live-dot: standalone freshness note (not inside a Badge) — the list
            auto-refreshes every 3s, the pulse is decorative, status is also shown as text.
            .live-dot is reserved for the pulse inside Badge/StatusBadge (see index.css). */}
        <span className="record-dot record-dot--live" aria-hidden />
        {t('liveStatus', { count: jobs.data.length })}
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-background">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 pl-3 pr-3 font-medium">{t('colId')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('colType')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('colStatus')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('colAttempts')}</th>
              {canRetry && <th className="py-1.5 pr-3 font-medium" />}
            </tr>
          </thead>
          {/* Queue rows appear as if being appended to the journal in order (journal-append feel). */}
          <Stagger as={motion.tbody}>
            {jobs.data.map((j) => (
              <StaggerItem as={motion.tr} key={j.id} className="border-b border-border/60 last:border-b-0">
                <td className="py-1.5 pl-3 pr-3 text-xs">
                  <span aria-hidden className="mr-1 text-brand">›</span>{j.id}
                </td>
                <td className="py-1.5 pr-3">{j.type}</td>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusGlyph s={j.status} />
                    <Badge tone={tone(j.status)}>{j.status}</Badge>
                  </span>
                </td>
                <td className="py-1.5 pr-3">{j.attempts}</td>
                {canRetry && (
                  <td className="py-1.5 pr-3">
                    {/* Only failed (dead-letter) jobs can be retried — the server enforces the same
                        rule (double-run protection), the button is only for visibility. */}
                    {j.status === 'failed' && (
                      <Btn size="xs" variant="outline" disabled={busyId !== null} onClick={() => retry(j.id)}
                        title={t('retryTitle')}>
                        <RotateCcw size={11} /> {t('retryButton')}
                      </Btn>
                    )}
                  </td>
                )}
              </StaggerItem>
            ))}
          </Stagger>
        </table>
      </div>
    </div>
    </div>
  );
}
