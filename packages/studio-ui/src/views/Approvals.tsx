import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, ExternalLink, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApprovals, api, errMessage, ApiError } from '../api';
import { Btn, Spinner, EmptyState, ErrorBox, Badge, JsonBlock, PageHeader } from '../components';
import { toast } from '../ui';
// I18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';

/**
 * Approval inbox: pending tool approvals for ALL suspended runs, in one central place.
 * Approve/Deny → existing resume endpoint; the decision lands in the audit log (server side).
 */
export function Approvals() {
  const { t } = useTranslation('approvals');
  const approvals = useApprovals();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (runId: string, toolCallId: string, approved: boolean) => {
    setBusy(toolCallId);
    try {
      await api.resume(runId, { [toolCallId]: approved });
      toast.success(approved ? t('approveSuccess') : t('denySuccess'));
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (e) {
      // Multi-tab race: another tab/user may have already resolved this approval (409) →
      // Show a clear message + refresh the list (so a stale 'pending' row doesn't linger in the UI).
      const conflict = e instanceof ApiError && e.status === 409;
      toast.error(conflict
        ? t('conflictError', { error: errMessage(e) })
        : t('actionError', { error: errMessage(e) }));
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    } finally {
      setBusy(null);
    }
  };

  if (approvals.isLoading) return <Spinner />;
  if (approvals.error) return <ErrorBox error={approvals.error} />;
  const items = approvals.data?.items ?? [];

  return (
    <div className="flex flex-col">
      {/* PageHeader sits flush at the top, outside the padded content below — avoids double padding
          (this view has no internal scroll cab, the whole page scrolls via the shell). */}
      <PageHeader
        title={t('pendingLabel')}
        description={t('description')}
        meta={<Badge tone="warning">{items.length}</Badge>}
      />
      <div className="space-y-3 p-5">
        {/* Approve/Deny both call the SAME resume endpoint and are equally terminal — there is no
            un-approve/un-deny (see @gnldev/durable's durable-tool.ts, which writes a terminal
            'approved'/'denied' record on first decision). A modal on every row would make this inbox
            unusable (that's the whole point of D3's "don't gate the primary action" lesson), so this
            is a one-line, non-blocking disclosure instead of a per-click confirmation. */}
        {items.length > 0 && <p className="text-xs text-muted-foreground">{t('decisionNotice')}</p>}

        {items.length === 0 && <EmptyState icon={Inbox} title={t('emptyTitle')} description={t('emptyDescription')} />}

        <div className="space-y-2">
          {items.map((it) => (
            <div key={`${it.runId}:${it.toolCallId}`} className="rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="mb-2 flex items-center gap-3">
                <span className="font-mono text-sm font-semibold">{it.toolName}</span>
                <Link to={`/inspector?run=${encodeURIComponent(it.runId)}`} className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline" title={t('openInInspector')}>
                  {it.runId} <ExternalLink size={11} />
                </Link>
                <div className="ml-auto flex gap-1.5">
                  <Btn variant="ok" size="xs" busy={busy === it.toolCallId} onClick={() => decide(it.runId, it.toolCallId, true)}>
                    <Check size={13} /> {t('approve')}
                  </Btn>
                  <Btn variant="deny" size="xs" busy={busy === it.toolCallId} onClick={() => decide(it.runId, it.toolCallId, false)}>
                    <X size={13} /> {t('deny')}
                  </Btn>
                </div>
              </div>
              {it.reason && <div className="mb-1.5 text-xs text-muted-foreground">{t('reasonLabel', { reason: it.reason })}</div>}
              {it.args !== undefined && (
                <details>
                  <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">{t('toolArgsSummary')}</summary>
                  <JsonBlock value={it.args} max={600} />
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
