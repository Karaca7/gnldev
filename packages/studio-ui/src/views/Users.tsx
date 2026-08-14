import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check, Ban, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useUsers, useOrganizations, useMe, useCapabilities, usePermissionsCatalog,
  api, errMessage, type StudioUser, type PermissionCatalog, type PermissionCatalogEntry,
} from '../api';
import { Spinner, Empty, ErrorBox, Badge, Btn, StatStrip, PageHeader } from '../components';
import { toast, ConfirmDialog, Dialog } from '../ui';
import { Reveal } from '../motion';
// I18n init side effect: so that useTranslation also works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-ensures it here.
import '../i18n';

// Free-tier role select (roleAuth: admin/viewer only) — UNCHANGED from before this feature.
const ROLES = ['admin', 'viewer'] as const;
// RBAC (paid) role ladder — mirrors @gnldev/studio's ROLE_PERMISSION_PRESETS keys (viewer/member/admin).
// Only offered once the permission catalog reports enabled:true (a 'member'-only user under the free
// RoleAuth provider would be a dead end — it isn't 'admin' or 'viewer' there).
const RBAC_ROLES = ['viewer', 'member', 'admin'] as const;
// TTL shortcuts: value in ms, '' = unlimited. Labels are resolved via the i18n key (based on the
// Active language at render time) — since this array lives outside the component, it holds no direct translated text.
const TTL_OPTIONS: { key: string; ms: number | '' }[] = [
  { key: 'ttlUnlimited', ms: '' },
  { key: 'ttl1Day', ms: 24 * 60 * 60 * 1000 },
  { key: 'ttl7Days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'ttl30Days', ms: 30 * 24 * 60 * 60 * 1000 },
];

const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleString() : undefined);

/**
 * Presentational-only checkbox grid for the (read-only, GNL-owned) permission catalog — grouped by
 * `group` when present. No "add permission" affordance anywhere: the catalog is code-defined, the
 * Admin only ASSIGNS existing entries. `title` carries the optional description as a native tooltip
 * (same lightweight pattern as the icon buttons' `title` elsewhere in this view).
 */
function PermissionCheckboxGrid({ entries, checked, onToggle }: {
  entries: PermissionCatalogEntry[]; checked: Set<string>; onToggle: (id: string) => void;
}) {
  const groups: { group: string; items: PermissionCatalogEntry[] }[] = [];
  for (const e of entries) {
    const g = e.group ?? '';
    let bucket = groups.find((x) => x.group === g);
    if (!bucket) { bucket = { group: g, items: [] }; groups.push(bucket); }
    bucket.items.push(e);
  }
  return (
    <div className="space-y-2">
      {groups.map(({ group, items }) => (
        <div key={group || '_'}>
          {group && <div className="microlabel mb-1 text-muted-foreground">{group}</div>}
          <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
            {items.map((p) => (
              <label key={p.id} className="flex items-start gap-1.5 text-xs" title={p.description}>
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={checked.has(p.id)}
                  onChange={() => onToggle(p.id)}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** New MEMBER form. Organization = chosen from EXISTING organizations (no phantom organizations).
 * An operator can also create a member without an organization (platform-level); for an
 *  Organization-admin the selector is hidden, and the organization is always pinned to their own.
 * If the permission catalog is enabled (paid RBAC), a checkbox editor is offered too: picking a role
 *  Seeds the checkboxes from `rolePresets[role]`; the admin can then tick/untick individual boxes. As
 *  Long as the admin never touches a checkbox the form stays "pure role" — `permissions` is simply
 *  Omitted from the request and the server's role-based defaults apply. The moment ANY checkbox is
 *  Toggled, the (possibly edited) set is sent explicitly as the user's permission override. */
function CreateUser({ orgs, ownOrg, onToken, catalog }: {
  orgs: string[]; ownOrg: string | null; onToken: (t: { id: string; token: string }) => void;
  catalog?: PermissionCatalog;
}) {
  const { t } = useTranslation('users');
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const roleOptions: readonly string[] = catalog?.enabled ? RBAC_ROLES : ROLES;
  const [role, setRole] = useState<string>('viewer');
  const [orgId, setOrgId] = useState(ownOrg ?? '');
  const [ttlMs, setTtlMs] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set(catalog?.rolePresets[role] ?? []));
  const [customized, setCustomized] = useState(false);
  const inputCls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors';

  // Reseed the checkbox set from the CURRENT role whenever the catalog (re)loads, as long as the admin
  // Hasn't customized anything yet — keeps the default in sync if the catalog data arrives after mount.
  useEffect(() => {
    if (catalog?.enabled && !customized) setChecked(new Set(catalog.rolePresets[role] ?? []));
    // Eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const selectRole = (r: string) => {
    setRole(r);
    setChecked(new Set(catalog?.rolePresets[r] ?? []));
    setCustomized(false);
  };
  const togglePermission = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setCustomized(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createUser({
        email: email.trim() || undefined,
        roles: [role],
        orgId: (ownOrg ?? orgId).trim() || undefined,
        ...(ttlMs !== '' ? { ttlMs } : {}),
        // Pure role unless the admin actually customized a checkbox (see the component doc comment above).
        ...(catalog?.enabled && customized ? { permissions: [...checked] } : {}),
      });
      onToken({ id: r.user.id, token: r.token });
      setEmail(''); if (!ownOrg) setOrgId('');
      selectRole('viewer'); setTtlMs(''); // fully reset the form — so the next member doesn't accidentally inherit the previous role/TTL/permissions
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(t('createError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('newMemberLabel')}</span>
        <input className={inputCls} placeholder={t('emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label={t('roleAriaLabel')} className={inputCls} value={role} onChange={(e) => selectRole(e.target.value)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select aria-label={t('ttlAriaLabel')} className={inputCls} value={ttlMs} onChange={(e) => setTtlMs(e.target.value ? Number(e.target.value) : '')} title={t('ttlAriaLabel')}>
          {TTL_OPTIONS.map((o) => <option key={o.key} value={o.ms}>{t(o.key)}</option>)}
        </select>
        {ownOrg ? (
          // Organization-admin: organization is pinned to their own organization.
          <Badge tone="info">{t('orgBadge', { org: ownOrg })}</Badge>
        ) : (
          // Operator: pick from existing organizations, or leave without an organization (operator-level).
          <select aria-label={t('orgAriaLabel')} className={inputCls} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">{t('noOrgOption')}</option>
            {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <Btn size="xs" onClick={create} busy={busy}><Plus size={12} /> {t('addButton')}</Btn>
      </div>
      {catalog?.enabled && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-2">
          <div className="microlabel mb-1.5 text-muted-foreground">{t('permissionsLabel')}</div>
          <PermissionCheckboxGrid entries={catalog.permissions} checked={checked} onToggle={togglePermission} />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {customized ? t('overrideActiveHint') : t('roleDefaultsHint')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Edit an EXISTING user's role + fine-grained permissions (PATCH /users/:id). Only rendered when the
 * Permission catalog is enabled — pre-fills the role from the user's first role (single-role UI, same
 * Convention as CreateUser) and the checkboxes from the user's EXPLICIT override if one exists,
 * Otherwise from that role's preset (shown as "role defaults", not yet an override). Switching the
 * Role re-seeds the checkboxes from the new role's preset (a template, not a merge). "Reset to role
 * Defaults" clears any override — on save this sends `permissions: []`, which the server treats as
 * Clearing the explicit override (falls back to role-based grants).
 */
function EditUser({ user, catalog, open, onOpenChange }: {
  user: StudioUser; catalog: PermissionCatalog; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('users');
  const qc = useQueryClient();
  const initialRole = user.roles[0] ?? 'viewer';
  const hadOverride = !!user.permissions?.length;
  const [role, setRole] = useState(initialRole);
  const [checked, setChecked] = useState<Set<string>>(new Set(user.permissions ?? catalog.rolePresets[initialRole] ?? []));
  const [customized, setCustomized] = useState(hadOverride);
  const [clearedOverride, setClearedOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  // Tracks in-SESSION edits only (role switch, checkbox toggle, or "reset to defaults") — distinct from
  // `customized`, which can start true just because the user already HAD a saved override. Drives the
  // Dialog's `dismissible` gate: an untouched dialog (even one pre-filled from an existing override) may
  // Still be dismissed by an outside click/Escape; the moment something is edited, that stops (see [FORM-06]).
  const [touched, setTouched] = useState(false);

  // Re-derive local state whenever the dialog (re)opens — possibly for a different user/row.
  useEffect(() => {
    if (!open) return;
    const r = user.roles[0] ?? 'viewer';
    setRole(r);
    setChecked(new Set(user.permissions ?? catalog.rolePresets[r] ?? []));
    setCustomized(!!user.permissions?.length);
    setClearedOverride(false);
    setTouched(false);
    // Eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user.id]);

  const selectRole = (r: string) => {
    setRole(r);
    setChecked(new Set(catalog.rolePresets[r] ?? []));
    setCustomized(false);
    setClearedOverride(false);
    setTouched(true);
  };
  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setCustomized(true);
    setClearedOverride(false);
    setTouched(true);
  };
  const clearOverride = () => {
    setChecked(new Set(catalog.rolePresets[role] ?? []));
    setCustomized(false);
    setClearedOverride(true);
    setTouched(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.updateUser(user.id, {
        roles: [role],
        // Customized → send the (possibly edited) explicit set. clearedOverride (and nothing customized
        // Since) → send [] so the server clears a PRE-EXISTING override. Otherwise omit permissions
        // Entirely — nothing to change (role-derived grants, as before).
        ...(customized ? { permissions: [...checked] } : clearedOverride ? { permissions: [] } : {}),
      });
      toast.success(t('updateSuccess', { id: user.id }));
      qc.invalidateQueries({ queryKey: ['users'] });
      onOpenChange(false);
    } catch (e) {
      toast.error(t('updateError', { error: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('editDialogTitle', { id: user.id })}
      width="w-[32rem]"
      dismissible={!touched}
      footer={
        <>
          <Btn variant="outline" onClick={() => onOpenChange(false)}>{t('cancelButton')}</Btn>
          <Btn onClick={save} busy={busy}>{t('saveButton')}</Btn>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="microlabel text-muted-foreground">{t('roleAriaLabel')}</span>
          <select
            aria-label={t('roleAriaLabel')}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors"
            value={role}
            onChange={(e) => selectRole(e.target.value)}
          >
            {RBAC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="microlabel text-muted-foreground">{t('permissionsLabel')}</span>
            {(hadOverride || customized) && (
              <button type="button" className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={clearOverride}>
                {t('clearOverrideButton')}
              </button>
            )}
          </div>
          <PermissionCheckboxGrid entries={catalog.permissions} checked={checked} onToggle={toggle} />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {customized ? t('overrideActiveHint') : clearedOverride ? t('overrideClearedHint') : t('roleDefaultsHint')}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** Panel that shows the token once (copy). The server does not store the plaintext token → if it's lost, a new user is needed.
 * Closing WITHOUT having copied it first is irreversible, so `onClose` is gated behind a confirmation
 *  (ConfirmDialog) in that case; once `copied` is true (the copy button succeeded), Close is direct. */
function TokenBanner({ id, token, onClose }: { id: string; token: string; onClose: () => void }) {
  const { t } = useTranslation('users');
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(token); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore if clipboard is unavailable */ }
  };
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
      <div className="mb-1 font-medium">{t('tokenBannerText', { id })}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-sm bg-muted px-2 py-1 font-mono">{token}</code>
        <Btn size="xs" variant="outline" onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />} {t('copyButton')}</Btn>
        <Btn size="xs" variant="ghost" onClick={() => (copied ? onClose() : setConfirmClose(true))}>{t('closeButton')}</Btn>
      </div>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t('confirmCloseTokenTitle')}
        description={t('confirmCloseTokenDesc')}
        confirmLabel={t('confirmCloseTokenButton')}
        destructive
        onConfirm={onClose}
      />
    </div>
  );
}

/** Users: paid user management (if the host provided a userStore). Add/delete + show the token once. */
export function Users() {
  const { t } = useTranslation('users');
  const users = useUsers();
  const organizations = useOrganizations();
  const me = useMe();
  const caps = useCapabilities();
  const catalog = usePermissionsCatalog();
  const qc = useQueryClient();
  // One-time access tokens from CreateUser — a LIST (not a single slot): adding a second member must
  // Not silently discard the first one's still-unread token (it can never be retrieved again once gone).
  const [freshTokens, setFreshTokens] = useState<{ id: string; token: string }[]>([]);
  const [delId, setDelId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<StudioUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // id of the user being processed — prevents a double-click from firing a double request
  if (users.isLoading) return <Spinner />;
  if (users.error) return <ErrorBox error={users.error} />;
  const rows: StudioUser[] = users.data?.users ?? [];
  const ownOrg = me.data?.orgId ?? null; // if organization-admin, their own organization; null for an operator
  const orgIds = (organizations.data?.organizations ?? []).map((o) => o.id);
  // Fine-grained permission editor (role + checkbox assignment) — only offered when the catalog reports
  // Enabled:true (paid RBAC / a valid license). Free tier keeps the existing role-only surface untouched:
  // No checkbox editor, no "Edit" button (there was no per-user edit affordance before this feature).
  const permCatalog = catalog.data?.enabled ? catalog.data : undefined;
  // Hidden from Nav via the 'userManage' capability, but this view is still reachable via URL (the route
  // Is always registered); without the permission the management UI (add/delete/revoke) is hidden — the
  // Server already enforces allow(c,'write'), this is UX-only.
  const canManage = !!caps.data?.userManage;

  const doDelete = async (id: string) => {
    setBusyId(id);
    try {
      await api.deleteUser(id);
      toast.success(t('deleteSuccess', { id }));
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(t('deleteError', { error: errMessage(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const doRevoke = async (id: string) => {
    setBusyId(id);
    try {
      await api.revokeUser(id);
      toast.success(t('revokeSuccess', { id }));
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(t('revokeError', { error: errMessage(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = rows.filter((u) => !u.revoked).length;
  const adminCount = rows.filter((u) => u.roles.some((r) => r === 'admin' || r === 'platform-admin')).length;
  return (
    <div className="flex h-full flex-col">
    <PageHeader
      title={t('title')}
      description={t('description')}
      meta={
        <>
          <Badge tone="muted">{rows.length}</Badge>
          {ownOrg
            ? <Badge tone="info">{t('orgBadge', { org: ownOrg })}</Badge>
            : <Badge tone="muted">{t('platformOperatorBadge')}</Badge>}
        </>
      }
    />
    <StatStrip items={[
      { label: t('statUsers'), value: rows.length.toLocaleString() },
      { label: t('statActive'), value: activeCount.toLocaleString() },
      { label: t('statAdmins'), value: adminCount.toLocaleString() },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto space-y-3 p-5">
      {canManage && (
        <CreateUser
          orgs={orgIds}
          ownOrg={ownOrg}
          onToken={(tok) => setFreshTokens((prev) => [...prev, tok])}
          catalog={permCatalog}
        />
      )}
      {freshTokens.map((ft) => (
        <TokenBanner
          key={ft.id}
          id={ft.id}
          token={ft.token}
          onClose={() => setFreshTokens((prev) => prev.filter((x) => x !== ft))}
        />
      ))}

      {rows.length === 0 ? (
        <Empty>{t('empty')}</Empty>
      ) : (
        <Reveal className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colUser')}</th>
                <th className="px-3 py-2 font-medium">{t('colRoles')}</th>
                <th className="px-3 py-2 font-medium">{t('colOrg')}</th>
                <th className="px-3 py-2 font-medium">{t('colLastUsed')}</th>
                <th className="px-3 py-2 font-medium">{t('colExpiry')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const expired = u.expiresAt != null && u.expiresAt < Date.now();
                return (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono font-medium">{u.email ?? u.id}</td>
                    <td className="px-3 py-2">
                      {u.roles.map((r) => <Badge key={r} tone={r === 'admin' ? 'info' : 'muted'}>{r}</Badge>)}
                      {u.revoked && <Badge tone="destructive">{t('revokedBadge')}</Badge>}
                      {!u.revoked && expired && <Badge tone="destructive">{t('expiredBadge')}</Badge>}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{u.orgId ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtDate(u.lastUsedAt) ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtDate(u.expiresAt) ?? t('ttlUnlimited')}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canManage && permCatalog && (
                        <Btn size="xs" variant="ghost" title={t('editUserTitle')} disabled={busyId === u.id} onClick={() => setEditUser(u)}>
                          <Pencil size={12} />
                        </Btn>
                      )}
                      {canManage && !u.revoked && (
                        <Btn size="xs" variant="ghost" title={t('revokeTitle')} disabled={busyId === u.id} onClick={() => setRevokeId(u.id)}>
                          <Ban size={12} className="text-warning" />
                        </Btn>
                      )}
                      {canManage && (
                        <Btn size="xs" variant="ghost" title={t('deleteUserTitle')} disabled={busyId === u.id} onClick={() => setDelId(u.id)}>
                          <Trash2 size={12} className="text-destructive" />
                        </Btn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Reveal>
      )}

      <ConfirmDialog
        open={!!delId}
        onOpenChange={(o) => { if (!o) setDelId(null); }}
        title={t('confirmDeleteTitle', { id: delId })}
        description={t('confirmDeleteDesc')}
        confirmLabel={t('deleteButton')}
        destructive
        onConfirm={() => { if (delId) doDelete(delId); setDelId(null); }}
      />

      <ConfirmDialog
        open={!!revokeId}
        onOpenChange={(o) => { if (!o) setRevokeId(null); }}
        title={t('confirmRevokeTitle', { id: revokeId })}
        description={t('confirmRevokeDesc')}
        confirmLabel={t('revokeButton')}
        destructive
        onConfirm={() => { if (revokeId) doRevoke(revokeId); setRevokeId(null); }}
      />

      {editUser && permCatalog && (
        <EditUser
          user={editUser}
          catalog={permCatalog}
          open={!!editUser}
          onOpenChange={(o) => { if (!o) setEditUser(null); }}
        />
      )}
    </div>
    </div>
  );
}
