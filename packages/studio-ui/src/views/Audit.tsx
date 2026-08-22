import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText } from 'lucide-react';
import { useAudit, type AuditItem } from '../api';
import { Spinner, EmptyState, ErrorBox, Badge, StatStrip, JsonBlock, PageHeader } from '../components';
// Note: unlike the other views, this one deliberately has NO '../i18n' side-effect import —
// This file's pure functions (auditToCsv/ACTIONS) are imported directly in a node environment
// (without jsdom, see test/observability-audit.test.ts); i18n/index.ts's getStoredLang()
// Accesses localStorage unconditionally and blows up in a node environment. In the real app,
// Main.tsx already imports './i18n' before App, so the `Audit` component works fine in real usage.

// Shared class for form/filter inputs. The focus recipe (ring + halo) lives in index.css and applies
// To every input/textarea/select — do not re-declare it here.
const inputCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors';

// The server's /audit does NOT take cursor/offset, only `limit` (newest first, trimmed to
// Limit — see packages/studio/src/server.ts). There's no real pagination (cursor); "load more"
// Increases the limit and refetches. Server-side upper bound is 1000 (server.ts: Math.min(1000, …)).
const AUDIT_PAGE = 200;
const AUDIT_MAX = 1000;

// RFC4180-like CSV field escaping: fields containing comma/quote/newline are wrapped in double
// Quotes (inner quotes are doubled) — pure function, edge cases covered in test/observability-audit.test.ts.
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Audit records → CSV text (pure function, doesn't touch the DOM — the download side effect is kept separate). */
export function auditToCsv(items: AuditItem[]): string {
  const header = ['id', 'at', 'actor', 'org', 'action', 'target', 'detail'];
  const lines = [header.join(',')];
  for (const it of items) {
    lines.push([
      it.id, it.at ?? '', it.actor, it.org ?? '', it.action, it.target,
      it.detail !== undefined ? JSON.stringify(it.detail) : '',
    ].map(csvField).join(','));
  }
  return lines.join('\n');
}

/** Downloads text as a file (browser side effect — kept separate from CSV generation, not tested). */
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

// Must match the server's full `AuditAction` union exactly (see packages/studio/src/server.ts,
// `type AuditAction`) — otherwise the user can't filter by some actions. The match is
// Verified in test/observability-audit.test.ts via a plain constant comparison.
export const ACTIONS = [
  // Kept in step with server.ts's AuditAction union — observability-audit.test.ts reads that union
  // from source and fails on any difference. It used to compare against a list hand-copied INTO the
  // test, so both could drift together: measured, 15 of the server's 36 actions were missing here,
  // including run.cancel, run.compensate, org.delete and pricing.update — the destructive ones an
  // operator most wants to filter by.
  'agent.approve', 'agent.block', 'agent.delete', 'agent.gate',
  'agent.promote', 'agent.run', 'agent.version', 'agent.version-delete',
  'approve', 'cache.invalidate', 'deny', 'fork',
  'job.retry', 'org.budget', 'org.create', 'org.delete',
  'policy.update', 'pricing.update', 'retention.sweep', 'run.cancel',
  'run.compensate', 'run.otel-export', 'run.purge', 'run.regression',
  'thread.delete', 'thread.rename', 'thread.truncate', 'tool.exec',
  'user.create', 'user.delete', 'user.revoke', 'user.update',
  'workflow.cancel', 'workflow.create', 'workflow.delete', 'workflow.update',
] as const;

function actionTone(action: string): 'success' | 'destructive' | 'warning' | 'muted' | 'info' {
  if (action === 'approve') return 'success';
  if (action === 'deny') return 'destructive';
  if (action.includes('delete')) return 'warning';
  if (action === 'fork' || action === 'agent.run') return 'info';
  return 'muted';
}

/** Audit log: every write action in Studio (who-what-when) — from the __audit__ log in the journal. */
export function Audit() {
  const { t } = useTranslation('audit');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const audit = useAudit({ limit, action: action || undefined, q: q || undefined });

  if (audit.isLoading) return <Spinner />;
  if (audit.error) return <ErrorBox error={audit.error} />;
  const items = audit.data?.items ?? [];
  // The server trims to limit and returns; if items.length === limit (and we haven't hit the cap)
  // There are likely older records not shown — the exact count is unknown (no cursor/total), hence "≥".
  const mayHaveMore = items.length >= limit && limit < AUDIT_MAX;
  // Upper bound reached: limit was clamped to AUDIT_MAX and the server still returned exactly
  // Limit items — the "load more" button can no longer grow (don't stop silently, inform the user).
  const atCap = limit >= AUDIT_MAX && items.length >= AUDIT_MAX;

  const nAppr = items.filter((i) => i.action === 'approve').length;
  const nRej = items.filter((i) => i.action === 'deny').length;
  const nPolicy = items.filter((i) => i.action.includes('policy')).length;
  return (
    <div className="flex h-full flex-col">
    {/* PageHeader stays a shrink-0 sibling above StatStrip — the scroll cab below it is what shrinks. */}
    <div className="shrink-0">
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={<Badge tone="muted">{items.length}{mayHaveMore ? '+' : ''}</Badge>}
        actions={(
          <button
            type="button"
            onClick={() => downloadText(`gnl-audit-${Date.now()}.csv`, auditToCsv(items), 'text/csv;charset=utf-8;')}
            disabled={items.length === 0}
            className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('downloadCsv')}
          </button>
        )}
      />
    </div>
    <StatStrip items={[
      { label: t('statEvents'), value: `${items.length}${mayHaveMore ? '+' : ''}` },
      { label: t('statApprovals'), value: String(nAppr) },
      { label: t('statRejections'), value: String(nRej) },
      { label: t('statPolicyChanges'), value: String(nPolicy) },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto space-y-3 p-5">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchAriaLabel')}
          className={`ml-auto w-48 ${inputCls}`}
        />
        <select aria-label={t('actionFilterAriaLabel')} value={action} onChange={(e) => setAction(e.target.value)} className={inputCls}>
          <option value="">{t('allActions')}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {items.length === 0 && <EmptyState icon={ScrollText} title={t('emptyTitle')} description={t('emptyDescription')} />}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colTime')}</th>
                <th className="px-3 py-2 font-medium">{t('colActor')}</th>
                <th className="px-3 py-2 font-medium">{t('colOrg')}</th>
                <th className="px-3 py-2 font-medium">{t('colAction')}</th>
                <th className="px-3 py-2 font-medium">{t('colTarget')}</th>
                <th className="px-3 py-2 font-medium">{t('colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-muted-foreground">
                    {it.at != null ? new Date(it.at).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono">{it.actor}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{it.org ?? '—'}</td>
                  <td className="px-3 py-1.5"><Badge tone={actionTone(it.action)}>{it.action}</Badge></td>
                  <td className="max-w-64 truncate px-3 py-1.5 font-mono" title={it.target}>{it.target}</td>
                  <td className="px-3 py-1.5">
                    {it.detail !== undefined ? (
                      <details>
                        <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">{t('showDetail')}</summary>
                        <JsonBlock value={it.detail} max={400} />
                      </details>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {mayHaveMore && (
            <button
              type="button"
              onClick={() => setLimit((l) => Math.min(AUDIT_MAX, l + AUDIT_PAGE))}
              disabled={audit.isFetching}
              className="w-full border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {audit.isFetching ? t('loadingMore') : t('loadMore', { count: items.length, limit })}
            </button>
          )}
          {atCap && (
            <div className="w-full border-t border-border px-3 py-1.5 text-center font-mono text-[11px] text-muted-foreground">
              {t('capReached', { max: AUDIT_MAX })}
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
