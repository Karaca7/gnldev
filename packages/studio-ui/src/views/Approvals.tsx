import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, ExternalLink, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApprovals, api, errMessage, ApiError } from '../api';
import { Btn, Spinner, EmptyState, ErrorBox, Badge, JsonBlock, PageHeader } from '../components';
import { toast } from '../ui';
// i18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';

/**
 * Approval inbox: pending tool approvals for ALL suspended runs, in one central place.
 * Approve/Deny → existing resume endpoint; the decision lands in the audit log (server side).
 */
const EXPIRED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function ageOf(ts: number, now: number): string {
  const ms = now - ts;
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d`;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `${h}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

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
      // show a clear message + refresh the list (so a stale 'pending' row doesn't linger in the UI).
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
  // K2: the staleness decision's BOTH ends come from the server side — suspendedAt is a journal
  // timestamp, so the baseline is the server's clock (a skewed client must not mint stale badges).
  const nowBase = approvals.data?.serverNow ?? Date.now();

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
          {items.map((it) => {
            // WHOSE WORK THIS IS, and whether that stops the operator.
            //
            // Two fields, deliberately not one. The engine's ownership lock only fires when BOTH
            // names are filled (`frozen.actor` AND the resumer's actor) — so a run carrying a
            // `resourceId` but no `actor` stamp is owned AND still resumable, and Approve on it
            // returns 200, not 409. Gating the buttons on `owner` would therefore forbid work the
            // engine accepts; the condition is `ownerActor`.
            //
            // Visibility stays with the admin, the decision with the owner: the row is listed and
            // labelled — never hidden — because an operator who cannot see a queue cannot reason
            // about it. Before this, the only way to learn a row was someone else's was to press
            // Approve and read the 409.
            const locked = !!it.ownerActor;
            const lockedWhy = t('ownerLockedTitle', { owner: it.owner ?? it.ownerActor });
            return (
            <div key={`${it.runId}:${it.toolCallId}`} className="rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="mb-2 flex items-center gap-3">
                <span className="font-mono text-sm font-semibold">{it.toolName}</span>
                <Link to={`/inspector?run=${encodeURIComponent(it.runId)}`} className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline" title={t('openInInspector')}>
                  {it.runId} <ExternalLink size={11} />
                </Link>
                {it.suspendedAt !== undefined && (
                  nowBase - it.suspendedAt > EXPIRED_AFTER_MS
                    ? <Badge tone="destructive">{t('expiredBadge', { age: ageOf(it.suspendedAt, nowBase) })}</Badge>
                    : <span className="text-[11px] text-muted-foreground">{t('waitingFor', { age: ageOf(it.suspendedAt, nowBase) })}</span>
                )}
                {/* An owned row says so; org work (batch, scheduler, anything started without a
                    subject) carries NO chip — the same language Agents.tsx speaks, where only
                    org-scoped agents get a chip and global ones stay bare. A badge on every other
                    row would be noise in a queue whose rows are mostly org work. */}
                {it.owner && <Badge tone="info">{t('ownerBadge', { owner: it.owner })}</Badge>}
                {/* WHICH work, next to WHOSE. The two answer different questions and neither stands
                    in for the other: the owner decides whether this panel may answer at all, the
                    workKey is the only thing on the row that says what the answer is ABOUT once the
                    runId is a 32-hex digest. Same rule as the owner chip — declared or nothing, no
                    placeholder on the rows that never named their work. */}
                {it.workKey && <Badge tone="muted">{t('workKeyBadge', { workKey: it.workKey })}</Badge>}
                <div className="ml-auto flex gap-1.5">
                  {/* `title` on a DISABLED button, which works here on purpose: Btn uses
                      `disabled:cursor-not-allowed` rather than `pointer-events-none`, so the native
                      tooltip still reaches a dead control (see components.tsx + the disabled-tooltip
                      contract test). Without it the pair would grey out and explain nothing. */}
                  <Btn variant="ok" size="xs" disabled={locked} title={locked ? lockedWhy : undefined} busy={busy === it.toolCallId} onClick={() => decide(it.runId, it.toolCallId, true)}>
                    <Check size={13} /> {t('approve')}
                  </Btn>
                  <Btn variant="deny" size="xs" disabled={locked} title={locked ? lockedWhy : undefined} busy={busy === it.toolCallId} onClick={() => decide(it.runId, it.toolCallId, false)}>
                    <X size={13} /> {t('deny')}
                  </Btn>
                </div>
              </div>
              {/* The same sentence as the tooltip, in the row itself. A `title` is delivered by
                  hover only — no keyboard, no touch — and this is the reason two buttons are dead;
                  a dead control whose explanation needs a mouse explains nothing to half the users. */}
              {locked && <div className="mb-1.5 text-xs text-muted-foreground">{lockedWhy}</div>}
              {it.reason && <div className="mb-1.5 text-xs text-muted-foreground">{t('reasonLabel', { reason: it.reason })}</div>}
              {it.args !== undefined && (
                <details>
                  <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">{t('toolArgsSummary')}</summary>
                  <JsonBlock value={it.args} max={600} />
                </details>
              )}
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
