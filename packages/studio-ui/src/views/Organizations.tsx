import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { Pencil, Save, X, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrganizations, useCapabilities, api, errMessage, type BudgetLimit, type SweepResult } from '../api';
import { Spinner, Empty, ErrorBox, Badge, Btn, StatStrip, PageHeader, cn } from '../components';
import { toast, ConfirmDialog } from '../ui';
import { Reveal } from '../motion';
// Note: unlike other views, there is deliberately NO '../i18n' side-effect import here —
// this file's pure functions (validateOrgId/orgDisplayName/fmtUsd/fmtTok) are imported directly
// in a node environment (without jsdom, see test/org-id.test.ts); getStoredLang() in i18n/index.ts
// accesses localStorage unconditionally and blows up in a node environment. In the real app,
// main.tsx already imports './i18n' before App; in the test environment, this view is only
// rendered via test/views.test.tsx, in the same module graph as Approvals — Approvals already
// initializes global i18next through its own '../i18n' import.
import enOrganizations from '../i18n/locales/en/organizations.json';

/** USD/token formatting (pure, tested). */
export function fmtUsd(n: number): string { return '$' + n.toFixed(2); }
export function fmtTok(n: number): string { return n.toLocaleString('tr-TR'); }

// validateOrgId, like the pure functions in Scheduler, is also tested from outside the component;
// `t` is optional, and if not given, a fallback that reads from en/organizations.json (ENGLISH
// default) is used. The real view passes its own `useTranslation('organizations')` t (tr/en
// depending on the active language).
type Tx = (key: string, opts?: Record<string, unknown>) => string;
function interpolate(s: string, vars?: Record<string, unknown>): string {
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
}
const defaultT: Tx = (key, opts) => interpolate((enOrganizations as Record<string, string>)[key] ?? key, opts);

/**
 * Budget meter: FULL information for one limit type (USD or token) — used / raw limit · percentage ·
 * remaining amount + fill bar. Lets the user read "$10 budget, 0% used, $10 left" without entering
 * edit mode (the old `BudgetBar` only showed % — it hid the actual limit).
 * On overage: destructive tone + "X exceeded". The fill animates from 0 to the real ratio (no jump under reduced-motion).
 */
function BudgetMeter({ label, used, limit, unit, exceeded }: { label: string; used: number; limit: number; unit: 'usd' | 'token'; exceeded: boolean }) {
  const { t } = useTranslation('organizations');
  const reduce = useReducedMotion();
  const fmt = unit === 'usd' ? fmtUsd : fmtTok;
  const ratio = Math.min(1, limit > 0 ? used / limit : 1);
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, limit - used);
  const over = Math.max(0, used - limit);
  return (
    <div className="min-w-[190px]">
      <div className="mb-0.5 flex items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">{fmt(used)} / {fmt(limit)}</span>
        <span className={exceeded ? 'text-destructive' : 'text-brand'}>%{pct}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-sm bg-background">
        <motion.div
          className={cn('h-full rounded-sm', exceeded ? 'bg-destructive' : 'bg-brand')}
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${ratio * 100}%` }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <div className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {exceeded ? <span className="text-destructive">{t('exceededLabel', { amount: fmt(over) })}</span> : <>{t('remainingLabel', { amount: fmt(remaining) })}</>}
      </div>
    </div>
  );
}

/**
 * Budget editor: writes the __budget__ document in the journal (the @gnldev/server write path reads it
 * LIVE → save = takes effect without a deploy). A field left empty means unlimited; if both are
 * empty, the budget is deleted.
 */
function BudgetEditor({ id, initial, onDone }: { id: string; initial?: BudgetLimit | null; onDone: () => void }) {
  const { t } = useTranslation('organizations');
  const qc = useQueryClient();
  const [usd, setUsd] = useState(initial?.usdLimit != null ? String(initial.usdLimit) : '');
  const [tok, setTok] = useState(initial?.tokenLimit != null ? String(initial.tokenLimit) : '');
  const [busy, setBusy] = useState(false);
  // Field-level errors (FORM-09): a negative limit is flagged on the exact input that caused it
  // (aria-invalid + inline message right below), instead of a toast in the screen's opposite corner
  // that leaves no trace once it fades — see validateOrgId/CreateOrganization for the same pattern.
  const [errs, setErrs] = useState<{ usd?: string; tok?: string }>({});
  const inputCls = 'w-28 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors';

  const save = async () => {
    const usdLimit = usd.trim() === '' ? null : Number(usd);
    const tokenLimit = tok.trim() === '' ? null : Number(tok);
    const usdInvalid = usdLimit != null && !(usdLimit >= 0);
    const tokInvalid = tokenLimit != null && !(tokenLimit >= 0);
    if (usdInvalid || tokInvalid) {
      setErrs({ usd: usdInvalid ? t('limitsMustBeNonNegative') : undefined, tok: tokInvalid ? t('limitsMustBeNonNegative') : undefined });
      return;
    }
    setErrs({});
    setBusy(true);
    try {
      await api.setOrgBudget(id, { usdLimit, tokenLimit });
      toast.success(usdLimit == null && tokenLimit == null
        ? t('budgetRemoved', { id })
        : t('budgetSaved', { id }));
      qc.invalidateQueries({ queryKey: ['organizations'] });
      onDone();
    } catch (e) {
      // Server/network error — genuinely off-screen (no single input to blame), toast stays.
      toast.error(t('saveError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          USD
          <input
            className={cn(inputCls, errs.usd && 'border-destructive')}
            aria-invalid={!!errs.usd}
            type="number" min="0" step="0.01" placeholder={t('unlimited')} value={usd}
            onChange={(e) => { setUsd(e.target.value); setErrs((s) => ({ ...s, usd: undefined })); }}
          />
        </label>
        {errs.usd && <span className="text-[11px] text-destructive">{errs.usd}</span>}
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          token
          <input
            className={cn(inputCls, errs.tok && 'border-destructive')}
            aria-invalid={!!errs.tok}
            type="number" min="0" step="1" placeholder={t('unlimited')} value={tok}
            onChange={(e) => { setTok(e.target.value); setErrs((s) => ({ ...s, tok: undefined })); }}
          />
        </label>
        {errs.tok && <span className="text-[11px] text-destructive">{errs.tok}</span>}
      </div>
      <Btn size="xs" onClick={save} disabled={busy}><Save size={12} /> {t('save')}</Btn>
      <Btn size="xs" variant="outline" onClick={onDone}><X size={12} /></Btn>
    </div>
  );
}

/**
 * Organization id validation (pure logic, tested): used in the journal as `org:<id>:` (storage
 * prefix) → only [a-z0-9_-] is allowed (':' is specifically FORBIDDEN, otherwise the prefix can be
 * escaped / collide with another organization's namespace). Returns null if valid, otherwise the
 * error text to show the user (depending on the active language — see the Tx fallback explanation above).
 */
export function validateOrgId(id: string, t: Tx = defaultT): string | null {
  const v = id.trim();
  if (!v) return t('orgIdEmpty');
  if (!/^[a-z0-9_-]+$/.test(v)) return t('orgIdInvalidChars');
  return null;
}

/**
 * Primary/secondary text for the table identity cell (pure logic, tested): if a label EXISTS it's
 * primary (fixes the bug where the label was collected but never shown in the UI) + id is secondary
 * (the `org:<id>:` storage identifier). If there's no label, the id alone is promoted to primary
 * (old behavior — backwards compatible).
 */
export function orgDisplayName(t: { id: string; label?: string }): { primary: string; secondary?: string } {
  return t.label ? { primary: t.label, secondary: `org:${t.id}:` } : { primary: t.id };
}

/** New organization creation form (only for an operator identity not scoped to an org; the server returns 403 otherwise). */
function CreateOrganization() {
  const { t } = useTranslation('organizations');
  const qc = useQueryClient();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  // Inline field error (FORM-09): validateOrgId's result is shown right below the id input
  // (aria-invalid + border-destructive) instead of a toast in the opposite screen corner — client-side
  // validation no longer uses toast at all; toast stays reserved for actual server/network errors below.
  const [idErr, setIdErr] = useState<string | null>(null);
  const inputCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors';

  const create = async () => {
    const tid = id.trim();
    const err = validateOrgId(tid, t);
    if (err) { setIdErr(err); return; }
    setIdErr(null);
    setBusy(true);
    try {
      await api.createOrganization(tid, label.trim() || undefined);
      toast.success(t('createSuccess', { id: tid }));
      setId(''); setLabel('');
      qc.invalidateQueries({ queryKey: ['organizations'] });
    } catch (e) {
      toast.error(t('createError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <span className="text-xs font-medium">{t('newOrgLabel')}</span>
      <div className="flex flex-col gap-0.5">
        <input
          className={cn(inputCls, idErr && 'border-destructive')}
          aria-invalid={!!idErr}
          placeholder={t('idPlaceholder')} value={id}
          onChange={(e) => { setId(e.target.value); setIdErr(null); }}
        />
        {idErr && <span className="text-[11px] text-destructive">{idErr}</span>}
      </div>
      <input className={inputCls} placeholder={t('labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
      <Btn size="xs" onClick={create} disabled={busy || !id.trim()}><Plus size={12} /> {t('addButton')}</Btn>
    </div>
  );
}

/** Organizations: usage/cost breakdown from `org:<id>:` journal prefixes + budget status and MANAGEMENT. */
export function Organizations() {
  const { t } = useTranslation('organizations');
  const organizations = useOrganizations();
  const caps = useCapabilities();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null); // prevent a double-click from firing a duplicate DELETE
  if (organizations.isLoading) return <Spinner />;
  if (organizations.error) return <ErrorBox error={organizations.error} />;
  const rows = organizations.data?.organizations ?? [];
  const defaultBudget = organizations.data?.defaultBudget ?? null;
  const canManage = !!caps.data?.budgetManage;
  const canManageOrgs = !!caps.data?.orgManage;
  const plan = caps.data?.plan;
  const licenseExp = caps.data?.licenseExp;

  const doDelete = async (id: string) => {
    setBusyDeleteId(id);
    try {
      const r = await api.deleteOrganization(id);
      toast.success(t('deleteSuccess', { id, count: r.deleted }));
      qc.invalidateQueries({ queryKey: ['organizations'] });
    } catch (e) {
      toast.error(t('deleteError', { error: errMessage(e) }));
    } finally {
      setBusyDeleteId(null);
    }
  };

  const totals = rows.reduce((a, r) => ({ runs: a.runs + r.runs, tokens: a.tokens + r.tokens, cost: a.cost + r.costUsd }), { runs: 0, tokens: 0, cost: 0 });
  const fmtNum = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  return (
    <div className="flex h-full flex-col">
    <PageHeader
      title={t('title')}
      description={t('description')}
      meta={
        <>
          <Badge tone="muted">{rows.length}</Badge>
          {/* EE license badge: plan + expiry (flows from auth-ee capabilities). */}
          {plan && <Badge tone="info">{t('planBadge', { plan })}</Badge>}
          {licenseExp != null && (
            <Badge tone={licenseExp < Date.now() + 14 * 86_400_000 ? 'warning' : 'muted'}>
              {t('licenseExpiry')} {new Date(licenseExp).toLocaleDateString('tr-TR')}
            </Badge>
          )}
        </>
      }
    />
    <StatStrip items={[
      { label: t('statOrgs'), value: rows.length.toLocaleString() },
      { label: t('statRuns'), value: totals.runs.toLocaleString() },
      { label: t('statTokens'), value: fmtNum(totals.tokens) },
      { label: t('statSpend'), value: '$' + totals.cost.toFixed(4) },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto space-y-3 p-5">
      {canManageOrgs && <CreateOrganization />}

      {/* Default budget: fallback applied to EVERYONE without an org-specific document. */}
      {canManage && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-xs font-medium">{t('defaultBudgetLabel')}</span>
          {editing === '__default__' ? (
            <BudgetEditor id="default" initial={defaultBudget} onDone={() => setEditing(null)} />
          ) : (
            <>
              <span className="font-mono text-xs text-muted-foreground">
                {defaultBudget?.usdLimit != null && <>USD ≤ {defaultBudget.usdLimit} </>}
                {defaultBudget?.tokenLimit != null && <>token ≤ {defaultBudget.tokenLimit.toLocaleString('tr-TR')}</>}
                {defaultBudget?.usdLimit == null && defaultBudget?.tokenLimit == null && '—'}
              </span>
              <Btn size="xs" variant="outline" onClick={() => setEditing('__default__')}><Pencil size={12} /> {t('editButton')}</Btn>
            </>
          )}
        </div>
      )}

      {rows.length === 0 && (
        <Empty>
          {t('emptyPart1')}<code className="rounded-sm bg-muted px-1">x-gnl-org</code>{t('emptyPart2')}
        </Empty>
      )}

      {rows.length > 0 && (
        <Reveal className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colOrg')}</th>
                <th className="px-3 py-2 text-right font-medium">run</th>
                <th className="px-3 py-2 text-right font-medium">token</th>
                <th className="px-3 py-2 text-right font-medium">{t('colCost')}</th>
                <th className="px-3 py-2 font-medium">{t('colBudget')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    {/* If a label EXISTS it's primary (collected in CreateOrganization); id always appears as
                        the secondary (small mono) technical identifier — if there's no label at all, id is
                        promoted to primary. */}
                    {(() => {
                      const dn = orgDisplayName(row);
                      return dn.secondary ? (
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium">{dn.primary}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{dn.secondary}</span>
                        </div>
                      ) : (
                        <span className="font-mono font-medium">{dn.primary}</span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.runs}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.tokens.toLocaleString('tr-TR')}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">${row.costUsd.toFixed(4)}</td>
                  <td className="px-3 py-2">
                    {editing === row.id ? (
                      <div className="flex flex-col gap-1">
                        <BudgetEditor id={row.id} initial={row.budget} onDone={() => setEditing(null)} />
                        {/* Pre-filling and editing an inherited (default-derived) budget — saving it creates
                            a __budget__ document SPECIFIC to this organization (see bug report #3). */}
                        {row.budget?.inherited && (
                          <span className="text-[10px] text-muted-foreground">
                            {t('inheritedNote')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {row.budget ? (
                          <>
                            {/* FULL meter for each limit type: used / raw limit · % · remaining (see bug
                                report #2 — it used to only show a % bar, hiding the actual budget number).
                                Overage is computed per-limit (the server returns a single combined `exceeded`). */}
                            <div className="flex flex-col gap-2">
                              {row.budget.usdLimit != null && (
                                <BudgetMeter label="USD" unit="usd" used={row.costUsd} limit={row.budget.usdLimit}
                                  exceeded={row.costUsd > row.budget.usdLimit} />
                              )}
                              {row.budget.tokenLimit != null && (
                                <BudgetMeter label="token" unit="token" used={row.tokens} limit={row.budget.tokenLimit}
                                  exceeded={row.tokens > row.budget.tokenLimit} />
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              {/* inherited: the organization has no document of its own, inherited from the default (see #3). */}
                              {row.budget.inherited && <Badge tone="muted">{t('defaultBadge')}</Badge>}
                              {row.budget.exceeded && <Badge tone="destructive">{t('budgetExceededBadge')}</Badge>}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground" title={t('noBudgetTitle')}>{t('noBudgetLabel')}</span>
                        )}
                        {canManage && (
                          <Btn size="xs" variant="ghost" title={t('editBudgetTitle')} onClick={() => setEditing(row.id)}>
                            <Pencil size={12} />
                          </Btn>
                        )}
                        {canManageOrgs && (
                          <Btn size="xs" variant="ghost" title={t('deleteOrgTitle')}
                            disabled={busyDeleteId === row.id} onClick={() => setDelId(row.id)}>
                            <Trash2 size={12} className="text-destructive" />
                          </Btn>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      )}

      {!!caps.data?.retention && <RetentionPanel />}

      <ConfirmDialog
        open={!!delId}
        onOpenChange={(o) => { if (!o) setDelId(null); }}
        title={t('confirmDeleteTitle', { id: delId })}
        description={t('confirmDeleteDesc')}
        confirmLabel={t('confirmDeletePermanent')}
        destructive
        onConfirm={() => { if (delId) doDelete(delId); setDelId(null); }}
      />
    </div>
    </div>
  );
}

/**
 * TTL retention sweep (operator): purges runs older than olderThan days — pending items
 * (awaiting approval) are kept by default. The result summary also lands in the audit log as 'retention.sweep'.
 */
function RetentionPanel() {
  const { t } = useTranslation('organizations');
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [keepSuspended, setKeepSuspended] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);

  const doSweep = async () => {
    setBusy(true);
    try {
      const r = await api.retentionSweep({ olderThanMs: days * 86_400_000, keepSuspended });
      setResult(r);
      toast.success(t('sweepSuccess', { count: r.purged.length, entries: r.deletedEntries }));
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['organizations'] });
    } catch (e) {
      toast.error(t('sweepError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2" data-retention-panel>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium">{t('retentionTitle')}</span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-xs outline-none"
            aria-label={t('daysAriaLabel')}
          />
          {t('olderThanSuffix')}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={keepSuspended} onChange={(e) => setKeepSuspended(e.target.checked)} />
          {t('keepSuspendedLabel')}
        </label>
        <Btn size="xs" variant="outline" disabled={busy} onClick={() => setConfirmOpen(true)}>
          <Trash2 size={12} className="text-destructive" /> {busy ? t('sweeping') : t('sweepButton')}
        </Btn>
        {result && (
          <span className="flex gap-1.5">
            <Badge tone="muted">{t('scannedBadge', { count: result.scanned })}</Badge>
            <Badge tone="destructive">{t('deletedBadge', { count: result.purged.length })}</Badge>
            {result.keptSuspended > 0 && <Badge tone="warning">{t('keptSuspendedBadge', { count: result.keptSuspended })}</Badge>}
            {result.keptNoTs > 0 && <Badge tone="muted">{t('keptNoTsBadge', { count: result.keptNoTs })}</Badge>}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirmSweepTitle', { days })}
        description={t('confirmSweepDesc', { days, suffix: keepSuspended ? t('confirmSweepDescKeep') : t('confirmSweepDescAll') })}
        confirmLabel={t('sweepButton')}
        destructive
        onConfirm={() => void doSweep()}
      />
    </div>
  );
}
