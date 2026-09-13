import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePolicy, useCapabilities, usePermissionsCatalog, api, errMessage, ApiError, type PolicyRule } from '../api';
import { Spinner, Empty, Badge, Btn, ErrorBox, PageHeader, cn } from '../components';
import { toast, ConfirmDialog } from '../ui';
// i18n init side effect: so that useTranslation also works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-ensures it here.
import '../i18n';

const ACTION_TONE: Record<PolicyRule['action'], 'success' | 'destructive' | 'warning'> = {
  allow: 'success', deny: 'destructive', 'require-approval': 'warning',
};

/**
 * Guard/policy editor: rules live in the journal (__policy__), policyGuard reads them live —
 * save → in effect on the next tool call, no deploy needed. An exact match takes precedence over
 * '*'; every save bumps the version, and the full rule set is written to the audit log.
 */
/** RBAC role → permission matrix (new design): rows = permissions from the code-defined catalog,
    columns = roles, cell = whether the role's default preset grants it. Read-only (permission TYPES
    are defined by the GNL team in code — see the catalog). Hidden on the free tier (catalog disabled). */
function RoleMatrix() {
  const { t } = useTranslation('policy');
  const cat = usePermissionsCatalog();
  if (!cat.data?.enabled) return null;
  const perms = cat.data.permissions ?? [];
  const roles = Object.keys(cat.data.rolePresets ?? {});
  if (!perms.length || !roles.length) return null;
  // A role grants a permission if its preset lists the exact id, the '*' wildcard (admin), or an
  // action-wildcard like '*:read' matching '<resource>:read' — same precedence the backend uses.
  const grants = (role: string, permId: string): boolean => {
    const preset = cat.data!.rolePresets[role] ?? [];
    if (preset.includes(permId) || preset.includes('*')) return true;
    const action = permId.split(':')[1];
    return !!action && preset.includes(`*:${action}`);
  };
  return (
    <div className="space-y-1.5">
      <span className="microlabel text-muted-foreground">{t('rolesMatrixTitle')}</span>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">{t('permissionCol')}</th>
              {roles.map((r) => <th key={r} className="px-3 py-2 text-center font-medium uppercase tracking-wide">{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.id} className="border-b border-border/60 last:border-b-0">
                <td className="px-3 py-2 font-mono text-xs text-foreground" title={p.description}>{p.id}</td>
                {roles.map((r) => (
                  <td key={r} className="px-3 py-2 text-center">
                    {/* A11Y-12: '–' at /40 opacity was ~1.8:1 (fails WCAG 1.4.3) and relied on color
                        alone to distinguish granted vs not (fails 1.4.1). Fix: full-opacity foreground
                        color (AA-passing) PLUS a distinct glyph (✓ vs ✕) so the pair reads without
                        color, and glyphs are decorative — the accessible name comes from sr-only text. */}
                    {grants(r, p.id) ? (
                      <>
                        <span aria-hidden="true" className="font-semibold text-brand">✓</span>
                        <span className="sr-only">{t('granted')}</span>
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground">✕</span>
                        <span className="sr-only">{t('notGranted')}</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Policy() {
  const { t } = useTranslation('policy');
  const policy = usePolicy();
  const caps = useCapabilities();
  const qc = useQueryClient();
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeIdx, setRemoveIdx] = useState<number | null>(null);
  // FORM-05: indices of rows whose tool name is blank — save() refuses to submit while any are
  // set, instead of silently dropping those rows (the old behavior: filter().filter((r) => r.tool)
  // dropped them without telling the admin, then still showed "saved").
  const [emptyToolIdx, setEmptyToolIdx] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (policy.data && !dirty) setRules(policy.data.policy?.rules ?? []);
  }, [policy.data, dirty]);

  // Hidden from Nav via the 'policy' capability, but this view is still reachable via URL (the route
  // is always registered); without the permission the editor is read-only — the server already
  // enforces allow(c,'write'), this is UX-only.
  const canManage = !!caps.data?.policy;

  const update = (i: number, patch: Partial<PolicyRule>) => {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
    // Clear the empty-tool highlight the moment the user edits the tool field (same pattern as
    // Tools.tsx's setField: don't wait for save() to re-validate, clear as they start fixing it).
    if ('tool' in patch) setEmptyToolIdx((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : s));
  };
  const remove = (i: number) => {
    setRules((rs) => rs.filter((_, j) => j !== i));
    setEmptyToolIdx((s) => new Set([...s].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x))));
    setDirty(true);
  };
  const add = () => { setRules((rs) => [...rs, { tool: '', action: 'require-approval' }]); setDirty(true); };
  const discard = () => { setRules(policy.data?.policy?.rules ?? []); setDirty(false); setEmptyToolIdx(new Set()); };

  const save = async () => {
    const trimmed = rules.map((r) => ({ ...r, tool: r.tool.trim() }));
    // FORM-05: block the save entirely if any row has a blank tool name — refuse silently dropping
    // it. Highlight the offending rows instead of sending the request.
    const empties = new Set(trimmed.reduce<number[]>((acc, r, i) => (r.tool ? acc : (acc.push(i), acc)), []));
    if (empties.size) {
      setEmptyToolIdx(empties);
      toast.error(t('emptyToolError'));
      return;
    }
    const clean = trimmed;
    const seen = new Set<string>();
    const dup = clean.find((r) => (seen.has(r.tool) ? true : (seen.add(r.tool), false)));
    if (dup) {
      toast.error(t('duplicateToolError', { tool: dup.tool }));
      return;
    }
    setBusy(true);
    try {
      // API-08: send the version we loaded → the server rejects a lost update if another admin
      // saved in the meantime (409) instead of silently overwriting their rules.
      const r = await api.savePolicy(clean, policy.data?.policy?.version ?? 0);
      toast.success(t('saveSuccess', { version: r.version }));
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['policy'] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Don't silently drop the user's edits, but don't keep them staged against stale rules
        // either: surface the conflict and refetch so they can re-apply their change on top of
        // the current version.
        toast.error(t('saveConflictError', { error: errMessage(e) }));
        qc.invalidateQueries({ queryKey: ['policy'] });
      } else {
        toast.error(t('saveError', { error: errMessage(e) }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (policy.isLoading) return <Spinner />;
  if (policy.error) return <ErrorBox error={policy.error} />;
  const inputCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="space-y-5 p-5">
      {/* Page-level identity for BOTH sections below (the read-only role matrix and the guard rules
          editor) — not scoped to the max-w-3xl editor column, so it stays full-width and consistent
          with RoleMatrix's own (unconstrained) width. */}
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={
          <>
            {policy.data?.policy && <Badge tone="info">v{policy.data.policy.version}</Badge>}
            {dirty && <Badge tone="warning">{t('unsavedBadge')}</Badge>}
            {!canManage && <Badge tone="muted">{t('readOnlyBadge')}</Badge>}
          </>
        }
        actions={canManage && (
          <>
            {dirty && <Btn size="xs" variant="outline" onClick={discard}><RotateCcw size={12} /> {t('discardButton')}</Btn>}
            <Btn size="xs" variant="outline" onClick={add}><Plus size={12} /> {t('addRuleButton')}</Btn>
            <Btn size="xs" onClick={save} busy={busy} disabled={!dirty}><Save size={12} /> {t('saveButton')}</Btn>
          </>
        )}
      />
      {/* RBAC role→permission matrix (mockup's Policy view) — the guard rules editor follows below. */}
      <RoleMatrix />
      <div className="max-w-3xl space-y-3">
      <p className="text-xs text-muted-foreground">
        {t('descPart1')}<code className="rounded-sm bg-muted px-1">*</code>{t('descPart2')}<b>allow</b>{t('descPart3')}
      </p>

      {rules.length === 0 && <Empty>{t('emptyPart1')}<code>chargeCard</code>{t('emptyPart2')}</Empty>}

      <div className="space-y-1.5">
        {rules.map((r, i) => {
          const toolInvalid = emptyToolIdx.has(i);
          return (
          <div key={i} className={cn('flex flex-wrap items-center gap-2 rounded-md border p-2', r.tool === '*' ? 'border-info/40' : 'border-border')}>
            <div className="flex flex-col gap-0.5">
              <input
                value={r.tool}
                onChange={(e) => update(i, { tool: e.target.value })}
                placeholder={t('toolPlaceholder')}
                aria-label={t('toolAriaLabel')}
                aria-invalid={toolInvalid}
                required
                disabled={!canManage}
                className={cn(inputCls, 'w-40 font-mono', toolInvalid && 'border-destructive')}
              />
              {toolInvalid && <span className="text-[11px] text-destructive">{t('emptyToolInlineError')}</span>}
            </div>
            <select
              value={r.action}
              onChange={(e) => update(i, { action: e.target.value as PolicyRule['action'] })}
              aria-label={t('actionAriaLabel')}
              disabled={!canManage}
              className={inputCls}
            >
              <option value="allow">{t('allowOption')}</option>
              <option value="require-approval">{t('requireApprovalOption')}</option>
              <option value="deny">{t('denyOption')}</option>
            </select>
            <Badge tone={ACTION_TONE[r.action]}>{r.action}</Badge>
            <input
              value={r.reason ?? ''}
              onChange={(e) => update(i, { reason: e.target.value || undefined })}
              placeholder={t('reasonPlaceholder')}
              aria-label={t('reasonAriaLabel')}
              disabled={!canManage}
              className={cn(inputCls, 'min-w-40 flex-1')}
            />
            {canManage && (
              <button type="button" title={t('deleteRuleTitle')} onClick={() => setRemoveIdx(i)} className="rounded-sm p-1 text-muted-foreground hover:text-destructive">
                <Trash2 size={13} />
              </button>
            )}
          </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={removeIdx != null}
        onOpenChange={(o) => { if (!o) setRemoveIdx(null); }}
        title={t('confirmDeleteTitle')}
        description={removeIdx != null ? t('confirmDeleteDesc', { tool: rules[removeIdx]?.tool || t('emptyToolPlaceholder') }) : undefined}
        confirmLabel={t('removeButton')}
        destructive
        onConfirm={() => { if (removeIdx != null) remove(removeIdx); setRemoveIdx(null); }}
      />
      </div>
    </div>
  );
}
