import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, useCapabilities, useCacheStats, errMessage } from '../api';
import { Spinner, Empty, EmptyState, ErrorBox, Btn, cn } from '../components';
import { toast, ConfirmDialog } from '../ui';
import { Stagger, StaggerItem } from '../motion';
// i18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';

// ── Pure logic (tested) — card display format; the server already computes hitRate, here only the
// PRESENTATION (percent format + color tone) is derived. ──────────────────────────────────────────
/** hitRate (0..1) → readable text like "80.0%". If not finite (no data/division by zero) "—". */
export function formatHitRate(hitRate: number): string {
  if (!Number.isFinite(hitRate)) return '—';
  return `${(hitRate * 100).toFixed(1)}%`;
}
/** Hit rate card tone: neutral if there are no requests at all; good/medium/bad thresholds are in
 *  the same spirit as the Observability p95 cards (success/warning/destructive) — doesn't rely on
 *  color alone, it's double-coded with the percent text. */
export function hitRateTone(hitRate: number, total: number): 'success' | 'warning' | 'destructive' | 'muted' {
  if (total <= 0) return 'muted';
  if (hitRate >= 0.7) return 'success';
  if (hitRate >= 0.4) return 'warning';
  return 'destructive';
}

function Card({ label, value, hint, tone = 'muted' }: {
  label: string; value: string; hint?: string; tone?: 'success' | 'warning' | 'destructive' | 'muted';
}) {
  const toneCls = {
    success: 'text-success', warning: 'text-warning', destructive: 'text-destructive', muted: 'text-foreground',
  }[tone];
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="microlabel text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', toneCls)}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Manual invalidate panel (caps.cacheManage): if a key is given, only that key is cleared; if empty
 *  (best-effort) all keys known to the host are cleared — this same server-side limitation is spelled
 *  out explicitly here (ConfirmDialog). */
function InvalidatePanel() {
  const { t } = useTranslation('cache');
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const doInvalidate = async () => {
    setBusy(true);
    try {
      const trimmed = key.trim();
      const r = await api.invalidateCache(trimmed || undefined);
      toast.success(
        trimmed ? t('invalidateSuccessKey', { key: trimmed, count: r.deleted }) : t('invalidateSuccessAll', { count: r.deleted }),
      );
      qc.invalidateQueries({ queryKey: ['cache-stats'] });
    } catch (e) {
      toast.error(t('invalidateError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium">{t('manualInvalidate')}</span>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyAriaLabel')}
          className="w-56 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <Btn size="xs" variant="outline" disabled={busy} onClick={() => setConfirmOpen(true)}>
          <Trash2 size={12} className="text-destructive" /> {busy ? t('clearing') : t('clearButton')}
        </Btn>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={key.trim() ? t('confirmTitleKey', { key: key.trim() }) : t('confirmTitleAll')}
        description={key.trim() ? t('confirmDescKey') : t('confirmDescAll')}
        confirmLabel={t('clearButton')}
        destructive
        onConfirm={() => void doInvalidate()}
      />
    </div>
  );
}

// Cache: @gnl/cache hit/miss rate + manual invalidate. Auto-refreshes every 5s (see api.ts
// useCacheStats refetchInterval) — same live-list spirit as the Jobs view.
export function Cache() {
  const { t } = useTranslation('cache');
  const caps = useCapabilities();
  const stats = useCacheStats();

  if (caps.isLoading || stats.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (stats.error) return <ErrorBox error={stats.error} />;
  if (!caps.data?.cache) return <EmptyState icon={Database} title={t('disabledTitle')} description={t('disabledDescription')} />;

  const s = stats.data ?? { hits: 0, misses: 0, hitRate: 0, size: 0 };
  const total = s.hits + s.misses;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="live-dot" aria-hidden />
        {t('liveStatus')}
      </div>
      <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StaggerItem><Card label={t('hitLabel')} value={String(s.hits)} tone="success" /></StaggerItem>
        <StaggerItem><Card label={t('missLabel')} value={String(s.misses)} tone="destructive" /></StaggerItem>
        <StaggerItem>
          <Card label={t('hitRateLabel')} value={formatHitRate(s.hitRate)} tone={hitRateTone(s.hitRate, total)} hint={t('requestsHint', { count: total })} />
        </StaggerItem>
        <StaggerItem>
          <Card label={t('knownKeysLabel')} value={String(s.size)} hint={t('knownKeysHint')} />
        </StaggerItem>
      </Stagger>
      {total === 0 && s.size === 0 && (
        <div className="mt-3"><Empty>{t('emptyStats')}</Empty></div>
      )}
      {caps.data?.cacheManage && <InvalidatePanel />}
    </div>
  );
}
