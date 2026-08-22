import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Rocket, Plus, Trash2, Pencil, ShieldCheck, ShieldAlert, ShieldX, Clock } from 'lucide-react';
import { useAgents, useManagedAgents, useCapabilities, useAgentRegistry, useMe, api, errMessage, ApiError, type ManagedAgentRecord, type AgentRegistryRecord } from '../api';
import { Spinner, Empty, ErrorBox, Badge, Btn, Tabs, StatStrip, PageHeader, cn } from '../components';
import { ConfirmDialog, toast } from '../ui';
import { Stagger, StaggerItem } from '../motion';
import { PromptEditor } from './PromptEditor';

/** A single scorer's gate-table row: score + threshold + pass/fail. */
export interface GateScoreRow { scorer: string; score: number; threshold: number; passed: boolean; }

/**
 * The server (server.ts ~L1724-1738) evaluates ALL scorers against a SINGLE global `minAvg` and
 * Only embeds the FAILING ones in the message, formatted as `scorer=score<threshold` (passing ones
 * Aren't in the message, only in `aggregate`). We extract the threshold from the message and apply
 * It to ALL scorers in `aggregate` — so passing scorers show up in the table too. Pure function:
 * Tested as long as the server's text format doesn't change.
 */
export function parseGateScores(message: string, aggregate: Record<string, number>): GateScoreRow[] {
  const failing = new Map<string, number>();
  const re = /([^\s,=]+)=([\d.]+)<([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) failing.set(m[1], Number(m[3]));
  const fallbackThreshold = failing.size ? [...failing.values()][0] : 0.5;
  return Object.entries(aggregate)
    .map(([scorer, score]) => ({
      scorer,
      score,
      threshold: failing.get(scorer) ?? fallbackThreshold,
      passed: !failing.has(scorer),
    }))
    .sort((a, b) => a.scorer.localeCompare(b.scorer));
}

// Agent card: appears one by one in a stagger-entrance list, lifts slightly on hover (translateY+shadow) —
// Only transform/box-shadow, GPU-friendly; the global prefers-reduced-motion CSS rule already zeroes out the transition.
const CARD_HOVER = 'transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-lg';

/** Agent card avatar: lime "›G" — filled for agents with a managed+active (live in prod)
    version, outline "idle" state for others (registry-only/draft). Without touching BrandMark,
    reuses the same visual language at card scale. */
function AgentAvatar({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center gap-0.5 rounded-md text-sm font-extrabold leading-none',
        live ? 'bg-brand text-brand-foreground' : 'border border-brand/60 bg-transparent text-brand',
      )}
    >
      <span>›</span>
      <span className="tracking-tighter">G</span>
    </span>
  );
}

/** GNL Progress recipe: Ink track + lime fill + MONO % (lime). The percentage is always also
    presented as text (color+fill alone doesn't convey meaning — WCAG 1.4.1). */
function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-brand">%{pct}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-background">
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** "How many versions behind" indicator, shown when prod is BEHIND the newest draft. Shows
    NOTHING when active === newest or there's only one version (in that case the bar was just 100%
    noise — it blurred "is it active / is it the latest"). Only visible when prod < newest draft,
    and says "waiting to promote". */
function FreshnessBar({ active, latest }: { active: number | null; latest: number }) {
  const { t } = useTranslation('agents');
  if (active == null || latest <= active) return null;
  return <ProgressBar value={active / latest} label={t('freshnessLabel', { active, latest })} />;
}

/** Version panel: immutable version list + promote/rollback. Active version highlighted with brand
    color. When evalGate is on, a promote rejection (412) is shown as a score table (instead of a
    truncated single line). */
type AgentVersion = ManagedAgentRecord['versions'][number];
function VersionPanel({ rec, canManage, evalGate, onChanged, onEdit, onDelete }: {
  rec: ManagedAgentRecord; canManage: boolean; evalGate: boolean; onChanged: () => void;
  onEdit: (v: AgentVersion) => void; onDelete: (v: AgentVersion) => void;
}) {
  const { t, i18n } = useTranslation('agents');
  const [busy, setBusy] = useState<number | null>(null);
  const [gateFail, setGateFail] = useState<{ message: string; rows: GateScoreRow[] } | null>(null);
  // FLOW-11: promote/rollback used to fire the API call on click, with no confirmation — a single
  // Misclick in a dense version list would immediately re-point prod at an untested draft (every new
  // Run picks up the new model/system prompt until someone notices and rolls back). Gated behind a
  // Confirm dialog, same primitive/pattern as the delete flows in Agents() below.
  const [confirmPromote, setConfirmPromote] = useState<number | null>(null);
  const promote = async (version: number) => {
    if (busy != null) return; // panel-wide lock: prevent a second click from racing while a promote is in flight
    setBusy(version);
    setGateFail(null);
    // D4-1: direction matters for the toast text — a rollback (version < current active) must NOT
    // Read "promoted" (that told the user the opposite of what they just confirmed). Derived the same
    // Way as confirmIsOld above, from rec.active BEFORE the request lands (react-query hasn't refetched yet).
    const isRollback = rec.active != null && version < rec.active;
    try {
      const r = await api.promoteAgentVersion(rec.name, version);
      toast.success(isRollback
        ? t('rolledBackToast', { name: rec.name, version: r.active, previous: r.previous ?? '—' })
        : t('promotedToast', { name: rec.name, previous: r.previous ?? '—', active: r.active }));
      onChanged();
    } catch (e) {
      // API-05: 412 (eval gate BLOCKED) carries `aggregate` (scorer→score) in the JSON body —
      // ApiError now keeps the whole parsed body, not just `.error`, so this reads straight off it.
      if (e instanceof ApiError && e.status === 412 && e.body?.aggregate && typeof e.body.aggregate === 'object') {
        setGateFail({ message: e.message, rows: parseGateScores(e.message, e.body.aggregate as Record<string, number>) });
      }
      toast.error(t('promoteFailedToast', { message: errMessage(e) }));
    } finally {
      setBusy(null);
    }
  };
  // Recomputed from rec.active (not captured at click time) so the dialog always reflects the
  // CURRENT prod version, never a stale snapshot from when the button was clicked.
  const confirmIsOld = confirmPromote != null && rec.active != null && confirmPromote < rec.active;
  return (
    <div className="space-y-1.5">
      <ConfirmDialog
        open={confirmPromote !== null}
        onOpenChange={(o) => { if (!o) setConfirmPromote(null); }}
        title={confirmIsOld ? t('rollbackConfirmDialogTitle') : t('promoteConfirmDialogTitle')}
        description={confirmPromote != null
          ? (confirmIsOld
              ? t('rollbackConfirmDescription', { name: rec.name, version: confirmPromote, active: rec.active ?? '—' })
              : t('promoteConfirmDescription', { name: rec.name, version: confirmPromote, active: rec.active ?? '—' }))
          : ''}
        confirmLabel={confirmIsOld ? t('rollbackConfirmLabel') : t('promoteConfirmLabel')}
        onConfirm={() => { if (confirmPromote != null) void promote(confirmPromote); }}
      />
      {canManage && evalGate && (
        <span title={t('evalGateTitle')}>
          <Badge tone="info">{t('evalGateBadge')}</Badge>
        </span>
      )}
      {(() => { const latest = Math.max(...rec.versions.map((v) => v.version)); return [...rec.versions].reverse().map((v) => {
        const isActive = rec.active === v.version;
        const isOld = rec.active != null && v.version < rec.active;
        const isNewest = v.version === latest;
        return (
          <div key={v.version} className={cn('rounded-md border p-2', isActive ? 'border-brand/50 bg-brand/5' : 'border-border')}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-semibold">v{v.version}</span>
              {isActive ? <Badge tone="success" live>{t('activeProdBadge')}</Badge> : isOld ? <Badge tone="muted">{t('oldBadge')}</Badge> : <Badge tone="muted">{t('draftBadge')}</Badge>}
              {/* Marked when the newest draft is NOT prod → makes "which one is the latest version" clear (if active is already the newest, the badge is enough). */}
              {isNewest && !isActive && <span className="text-[10px] font-medium text-brand">{t('newestLabel')}</span>}
              <span className="truncate font-mono text-[10px] text-muted-foreground">{v.model}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                {new Date(v.createdAt).toLocaleString(i18n.language === 'tr' ? 'tr-TR' : 'en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              {canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  {!isActive && (
                    <Btn size="xs" variant="outline" disabled={busy !== null} onClick={() => setConfirmPromote(v.version)}
                      title={isOld ? t('rollbackTitle') : t('promoteVersionTitle')}>
                      <Rocket size={11} /> {isOld ? t('rollbackButtonLabel') : t('promoteButtonLabel')}
                    </Btn>
                  )}
                  <button type="button" title={t('editBasedOnTitle')}
                    onClick={() => onEdit(v)} className="rounded-sm p-1 text-muted-foreground hover:text-brand">
                    <Pencil size={11} />
                  </button>
                  {!isActive && (
                    <button type="button" title={t('deleteVersionTitle')}
                      disabled={busy !== null} onClick={() => onDelete(v)}
                      className="rounded-sm p-1 text-muted-foreground enabled:hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed">
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>
            {v.note && <div className="mt-1 text-[11px] text-muted-foreground">{v.note}</div>}
            {v.system && <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">system: {v.system}</div>}
          </div>
        );
      }); })()}
      {gateFail && <GateFailureTable message={gateFail.message} rows={gateFail.rows} />}
    </div>
  );
}

/** Promote 412 (eval gate BLOCKED) — rich score table: scorer + score + threshold + pass/fail.
    Rows that fail the threshold are highlighted with a destructive badge (makes "why the promote was
    blocked" clear). */
function GateFailureTable({ message, rows }: { message: string; rows: GateScoreRow[] }) {
  const { t } = useTranslation('agents');
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
      <div className="mb-1.5 text-[11px] font-medium text-destructive">{message}</div>
      <table className="w-full text-left text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-0.5 pr-2 font-normal">scorer</th>
            <th className="py-0.5 pr-2 font-normal">{t('scoreHeader')}</th>
            <th className="py-0.5 pr-2 font-normal">{t('thresholdHeader')}</th>
            <th className="py-0.5 font-normal">{t('statusHeader')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.scorer} className="border-t border-border/50">
              <td className="py-1 pr-2 font-mono">{r.scorer}</td>
              <td className="py-1 pr-2 font-mono">{r.score.toFixed(2)}</td>
              <td className="py-1 pr-2 font-mono text-muted-foreground">≥ {r.threshold.toFixed(2)}</td>
              <td className="py-1"><Badge tone={r.passed ? 'success' : 'destructive'}>{r.passed ? t('gatePassed') : t('gateFailed')}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** New draft version form — versions a CODE-DEFINED agent (managed = governance over code agents,
    NOT a no-code agent factory). The name is chosen from the code-agent list, never free text, so a
    version can't be created for a name that has no code (which could never run). When arriving via
    "edit" from a card, the name is fixed to that agent and its CURRENT version (model+system) is
    pre-filled; `note` is deliberately left empty (the change note for THIS version).
    Controlled by the parent (`draft`/`setDraft`, see Agents()) rather than owning its own field
    state — FORM-02: local state used to vanish whenever this component unmounted (switching to the
    'list' tab), silently discarding whatever the user had typed. */
function NewVersionForm({ onCreated, agentNames, draft, setDraft, nameFixed }: {
  onCreated: () => void; agentNames: string[]; nameFixed: boolean;
  draft: { name: string; model: string; system: string; note: string };
  setDraft: (updater: (d: { name: string; model: string; system: string; note: string }) => { name: string; model: string; system: string; note: string }) => void;
}) {
  const { t } = useTranslation('agents');
  const { name, model, system, note } = draft;
  const setName = (v: string) => setDraft((d) => ({ ...d, name: v }));
  const setModel = (v: string) => setDraft((d) => ({ ...d, model: v }));
  const setSystem = (v: string) => setDraft((d) => ({ ...d, system: v }));
  const setNote = (v: string) => setDraft((d) => ({ ...d, note: v }));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || !model.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.createAgentVersion({
        name: name.trim(), model: model.trim(),
        ...(system.trim() ? { system: system.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      // Active === version → the first version was automatically taken to prod (backend); otherwise a draft was added, prod untouched.
      toast.success(r.active === r.version
        ? t('createdAndPromotedToast', { name: r.name, version: r.version })
        : t('createdDraftToast', { name: r.name, version: r.version }));
      setDraft((d) => ({ ...d, system: '', note: '' }));
      onCreated();
    } catch (e) {
      toast.error(t('versionAddFailedToast', { message: errMessage(e) }));
    } finally {
      setBusy(false);
    }
  };
  const cls = 'rounded-md border border-input bg-background px-2 py-1 text-xs outline-none';
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/10 p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        {nameFixed ? (
          // Editing a specific code agent → the name is FIXED (you're adding a version to IT).
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">{t('agentNameLabel')}
            <span className={cn(cls, 'inline-block w-40 truncate bg-muted/40 font-mono text-foreground')}>{name}</span>
          </label>
        ) : (
          // Fresh version → pick a CODE-defined agent (no free text → no un-runnable orphan records).
          <label title={t('agentNameHint')}
            className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">{t('agentNameLabel')}
            <select value={name} onChange={(e) => setName(e.target.value)} className={cn(cls, 'w-40 font-mono')}>
              <option value="">{t('selectAgentPlaceholder')}</option>
              {agentNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <label title={t('modelFieldHint')}
          className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">{t('modelFieldLabel')}
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-4o-mini" className={cn(cls, 'w-52 font-mono')} />
        </label>
        <label title={t('noteFieldHint')}
          className="flex min-w-32 flex-1 flex-col gap-0.5 text-[10px] text-muted-foreground">{t('noteFieldLabel')}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('noteFieldPlaceholder')} className={cn(cls, 'w-full')} />
        </label>
        <Btn size="xs" onClick={submit} disabled={busy || !name.trim() || !model.trim()}
          title={t('draftVersionTitle')}>
          <Plus size={12} /> {t('draftVersionButton')}
        </Btn>
      </div>
      <div>
        {/* D4-8: label labels, help explains — was one line doing both. `htmlFor`/`id` ties the label
            to the textarea (PromptEditor forwards `id`). NOTE: full aria-describedby wiring (so the
            help paragraph below is also announced as the textarea's description) would need
            PromptEditor.tsx to accept+forward an `aria-describedby` prop — out of scope here (file not
            in this wave's edit list), left for the next pass; the `id` below is ready for it to attach to. */}
        <label htmlFor="agent-system-prompt" className="mb-1 block text-[10px] text-muted-foreground">{t('systemPromptFieldLabel')}</label>
        <PromptEditor value={system} onChange={setSystem} id="agent-system-prompt" />
        <p id="agent-system-prompt-help" className="mt-1 text-xs text-muted-foreground">{t('systemPromptFieldHelp')}</p>
      </div>
      {!nameFixed && agentNames.length === 0 && (
        <p className="text-[10px] text-warning">{t('noCodeAgentsForVersion')}</p>
      )}
      <p className="text-[10px] text-muted-foreground">
        {t('reqNotePrefix')} <b>{t('agentNameLabel')}</b> + <b>{t('modelFieldLabel')}</b>{t('reqNoteMiddle')} <b>Promote</b>{t('reqNoteSuffix')}
      </p>
    </div>
  );
}

/** Agent approval registry status badge (see @gnldev/durable's agent-registry.ts): `pending` awaits an
    admin decision, `approved` is servable, `changed` was approved but its config DRIFTED since (needs
    re-approval — deliberately worded/colored the SAME as `blocked`, both mean "not servable right now",
    but the icon+label distinguish "drifted, review the diff" from "explicitly blocked"), `blocked` is
    explicitly denied. Renders nothing when there's no record yet (agent not seen by @gnldev/server's boot,
    or the caller can't see the registry — see canSeeRegistry in Agents() below). */
function AgentApprovalBadge({ record }: { record?: AgentRegistryRecord }) {
  const { t } = useTranslation('agents');
  if (!record) return null;
  if (record.status === 'approved') {
    return <Badge tone="success" live><ShieldCheck size={11} /> {t('registryApproved')}</Badge>;
  }
  if (record.status === 'changed') {
    return (
      <span title={t('registryChangedTitle')}>
        <Badge tone="destructive"><ShieldAlert size={11} /> {t('registryChanged')}</Badge>
      </span>
    );
  }
  if (record.status === 'blocked') {
    return <Badge tone="destructive"><ShieldX size={11} /> {t('registryBlocked')}</Badge>;
  }
  return <Badge tone="warning"><Clock size={11} /> {t('registryPending')}</Badge>;
}

/** Approve/Block buttons for one agent's registry record — only rendered when `canSeeRegistry` (see
    Agents()) and a record actually exists (nothing to act on before @gnldev/server's boot has recorded
    it). `busy` locks BOTH buttons for this agent while a request is in flight (prevents a double-click
    race, same pattern as VersionPanel's promote lock). */
function AgentApprovalControls({ name, record, busy, onApprove, onBlock }: {
  name: string; record?: AgentRegistryRecord; busy: boolean;
  onApprove: (name: string) => void; onBlock: (name: string) => void;
}) {
  const { t } = useTranslation('agents');
  if (!record) return null;
  return (
    <div className="flex items-center gap-1">
      {record.status !== 'approved' && (
        <Btn size="xs" variant="outline" disabled={busy} onClick={() => onApprove(name)} title={t('registryApproveTitle')}>
          <ShieldCheck size={11} /> {t('registryApproveButton')}
        </Btn>
      )}
      {record.status !== 'blocked' && (
        <Btn size="xs" variant="outline" disabled={busy} onClick={() => onBlock(name)} title={t('registryBlockTitle')}>
          <ShieldX size={11} /> {t('registryBlockButton')}
        </Btn>
      )}
    </div>
  );
}

/** Section heading: establishes the type distinction at the STRUCTURE level (not a badge). A short
    inline context is enough for orientation — no need for a separate "how it works" paragraph. */
function SectionHead({ title, hint, count }: { title: string; hint: string; count?: number }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {count != null && <span className="font-mono text-xs text-muted-foreground">({count})</span>}
      <span className="text-[11px] text-muted-foreground">— {hint}</span>
    </div>
  );
}

export function Agents() {
  const { t } = useTranslation('agents');
  const agents = useAgents();
  const caps = useCapabilities();
  const managed = useManagedAgents();
  const me = useMe();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['managed-agents'] });
  const managedByName = new Map((managed.data?.agents ?? []).map((m) => [m.name, m]));
  // Also show agents that aren't in the registry (only living as a managed record).
  const managedOnly = (managed.data?.agents ?? []).filter((m) => !agents.data?.some((a) => a.name === m.name));
  // If there's no agentVersions cap, promote/rollback/delete buttons are NOT SHOWN (nav is hidden but reachable via URL).
  const canManage = !!caps.data?.agentVersions;
  const totalCount = (agents.data?.length ?? 0) + managedOnly.length;

  // Agent APPROVAL registry (governance — see @gnldev/durable's agent-registry.ts): GET/approve/block are
  // Platform-admin gated server-side (approval is "may this code-agent serve AT ALL", never per-org —
  // Same reasoning as org create/delete). `canSeeRegistry` mirrors the server's own `requirePlatformAdmin`
  // Check (org-bound → never; strict multi-org → needs the explicit platform-admin grant; otherwise the
  // Legacy operator) so a caller who WOULD get 403 never even issues the request — this hook is
  // Background-polled (10s), and App.tsx force-logs-out on any 401/403, so an always-on query here would
  // Boot a legitimate-but-unprivileged user out on every tick. Held false until caps+me both resolve
  // (their `undefined` fields would otherwise evaluate "true" and fire one premature request).
  const identityKnown = !!caps.data && !!me.data;
  // The `!me.data?.orgId` clause that used to sit here is gone: `caps.agentRegistry` is now false for
  // an org-bound caller at the source, so repeating it here would be the same fact in two places.
  const canSeeRegistry = identityKnown && !!caps.data?.agentRegistry && (!caps.data?.multiOrganization || !!me.data?.platformAdmin);
  const registry = useAgentRegistry(canSeeRegistry);
  const registryByName = new Map((registry.data ?? []).map((r) => [r.name, r]));
  const [registryBusy, setRegistryBusy] = useState<string | null>(null);
  const refreshRegistry = () => qc.invalidateQueries({ queryKey: ['agent-registry'] });
  const handleApproveAgent = async (name: string) => {
    if (registryBusy) return;
    setRegistryBusy(name);
    try {
      await api.approveAgent(name);
      refreshRegistry();
      toast.success(t('registryApprovedToast', { name }));
    } catch (e) {
      toast.error(t('registryActionFailedToast', { message: errMessage(e) }));
    } finally {
      setRegistryBusy(null);
    }
  };
  const handleBlockAgent = async (name: string) => {
    if (registryBusy) return;
    setRegistryBusy(name);
    try {
      await api.blockAgent(name);
      refreshRegistry();
      toast.success(t('registryBlockedToast', { name }));
    } catch (e) {
      toast.error(t('registryActionFailedToast', { message: errMessage(e) }));
    } finally {
      setRegistryBusy(null);
    }
  };

  // Tabs: 'list' (cards) · 'create' (create/edit). The draft (name/model/system/note) lives HERE —
  // NewVersionForm is a controlled child — so switching tabs no longer discards in-progress typing
  // (FORM-02): 'list' just unmounts the form, it doesn't touch `draft`.
  const [tab, setTab] = useState<'list' | 'create'>('list');
  const BLANK = { name: '', model: '', system: '', note: '' };
  const [draft, setDraft] = useState<{ name: string; model: string; system: string; note: string }>(BLANK);
  // Whether the name field is pinned to a specific code agent (came from "edit") vs a free select
  // (fresh draft — pick which code agent to version). Can't be derived from `draft.name` alone since
  // Picking an agent from the select also makes it non-empty.
  const [nameFixed, setNameFixed] = useState(false);
  const isDraftFilled = (d: typeof BLANK) => !!(d.name || d.model || d.system || d.note);
  // "edit" from a card would silently overwrite an in-progress draft for a DIFFERENT agent — gated
  // Behind a confirm dialog (below) instead of the old unwarned overwrite.
  const [pendingEdit, setPendingEdit] = useState<{ name: string; model: string; system: string; note: string; versionLabel?: string } | null>(null);
  // Edit from card: load the current version's content (including the note) into the form + inform the user (versions are immutable → this becomes a new version).
  const applyEdit = (name: string, model: string, system: string, note = '', versionLabel?: string) => {
    setDraft({ name, model, system, note });
    setNameFixed(true);
    setTab('create');
    toast.info(versionLabel
      ? t('editToastVersioned', { name, version: versionLabel })
      : t('editToastUnversioned', { name }));
  };
  const startEdit = (name: string, model: string, system: string, note = '', versionLabel?: string) => {
    if (isDraftFilled(draft) && draft.name !== name) {
      setPendingEdit({ name, model, system, note, versionLabel });
      return;
    }
    applyEdit(name, model, system, note, versionLabel);
  };
  const onTab = (tabId: 'list' | 'create') => setTab(tabId);

  // Delete the managed agent record (with ALL its versions) — only removes the managed record; a
  // Code-defined agent (if defined in createGnl agents) is unaffected and keeps showing up as-is.
  // `hasCode` determines the confirmation text.
  const [deleting, setDeleting] = useState<{ name: string; hasCode: boolean } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const handleDelete = async (name: string) => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.deleteManagedAgent(name);
      refresh();
      toast.success(t('managedAgentDeletedToast', { name }));
    } catch (e) {
      toast.error(t('deleteFailedToast', { message: errMessage(e) }));
    } finally {
      setDeleteBusy(false);
    }
  };

  // Single version delete (trash icon in VersionPanel → confirm → DELETE .../versions/:v). The active
  // Version can't be deleted (button is already hidden + backend 409); when the last version goes, the
  // Agent disappears entirely.
  const [deletingVer, setDeletingVer] = useState<{ name: string; version: number; remaining: number } | null>(null);
  const [verBusy, setVerBusy] = useState(false);
  const handleDeleteVersion = async () => {
    if (!deletingVer || verBusy) return;
    setVerBusy(true);
    try {
      const r = await api.deleteAgentVersion(deletingVer.name, deletingVer.version);
      refresh();
      toast.success(r.remaining === 0
        ? t('lastVersionDeletedToast', { name: deletingVer.name })
        : t('versionDeletedToast', { name: deletingVer.name, version: deletingVer.version }));
    } catch (e) {
      toast.error(t('deleteFailedToast', { message: errMessage(e) }));
    } finally {
      setVerBusy(false);
      setDeletingVer(null);
    }
  };

  if (agents.isLoading) return <Spinner />;
  if (agents.error) return <ErrorBox error={agents.error} />;
  return (
    // D3-6: same StatStrip-stays-pinned layout as Jobs/Tools/Mcp/Scheduler/Inspector — `flex h-full
    // Flex-col` outer + PageHeader/StatStrip (both shrink-0, see components.tsx) + a SINGLE `min-h-0
    // Flex-1 overflow-auto` scroll container below them. Agents.tsx has no other overflow-auto/overflow-y
    // Container inside (verified by grep), so this doesn't nest scrollboxes — it's the page's only one.
    <div className="flex h-full flex-col">
    {/* D3-8/PageHeader migration: the page's identity used to be an in-scroll <h1> gated by
        `canManage` (it vanished whenever the caller could manage agents, replaced by the Tabs) — first
        made unconditional, now migrated to the shared PageHeader (shrink-0, above StatStrip) so it
        never depends on an unrelated permission level and never scrolls out of view alongside it. */}
    <PageHeader title={t('agentsHeading')} description={t('description')} />
    <StatStrip items={[
      // `managed.error` degrades these to "—" instead of a fabricated "0" — totalCount also depends
      // On managed.data (via managedOnly), so it's unreliable whenever managed errored, same as statManaged.
      { label: t('statAgents'), value: managed.error ? '—' : totalCount.toLocaleString() },
      { label: t('statManaged'), value: managed.error ? '—' : String(managed.data?.agents?.length ?? 0) },
      { label: t('statCodeDefined'), value: String(agents.data?.length ?? 0) },
    ]} />
    <div className="min-h-0 flex-1 overflow-auto space-y-5 p-5">
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={t('deleteManagedAgentDialogTitle')}
        description={
          deleting?.hasCode
            ? t('deleteManagedAgentDescHasCode', { name: deleting.name })
            : t('deleteManagedAgentDescNoCode', { name: deleting?.name })
        }
        confirmLabel={t('deleteConfirmLabel')}
        destructive
        onConfirm={() => { if (deleting) void handleDelete(deleting.name); }}
      />
      <ConfirmDialog
        open={deletingVer !== null}
        onOpenChange={(o) => { if (!o) setDeletingVer(null); }}
        title={t('deleteVersionDialogTitle')}
        description={deletingVer
          ? t('deleteVersionDescription', {
              name: deletingVer.name,
              version: deletingVer.version,
              lastSuffix: deletingVer.remaining === 0 ? t('deleteVersionLastSuffix') : '',
            })
          : ''}
        confirmLabel={t('deleteConfirmLabel')}
        destructive
        onConfirm={() => void handleDeleteVersion()}
      />
      <ConfirmDialog
        open={pendingEdit !== null}
        onOpenChange={(o) => { if (!o) setPendingEdit(null); }}
        title={t('discardDraftDialogTitle')}
        description={pendingEdit ? t('discardDraftDescription', { draftName: draft.name, name: pendingEdit.name }) : ''}
        confirmLabel={t('discardDraftConfirmLabel')}
        destructive
        onConfirm={() => { if (pendingEdit) applyEdit(pendingEdit.name, pendingEdit.model, pendingEdit.system, pendingEdit.note, pendingEdit.versionLabel); }}
      />
      {canManage && (
        <Tabs<'list' | 'create'>
          active={tab}
          onChange={onTab}
          tabs={[
            { id: 'list', label: totalCount ? t('agentsTabCount', { count: totalCount }) : t('agentsTab') },
            { id: 'create', label: draft.name ? t('editTab', { name: draft.name }) : t('createEditTab') },
          ]}
        />
      )}

      {tab === 'list' && (
        <>
      {/* Clarity note: prevents the wrong expectation that an agent belongs to an org — isolation is
          at the run/journal level (see the org badge in Inspector), not per-agent. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('orgIsolationNote')}</p>
      {!agents.data?.length && managedOnly.length === 0 && (
        <Empty>{canManage ? t('noAgentsManageable') : t('noAgentsUnmanageable')}</Empty>
      )}

      {!!agents.data?.length && (
        <section>
          <SectionHead title={t('codeDefinedAgentsTitle')} hint={t('codeDefinedAgentsHint')} count={agents.data.length} />
          <Stagger className="grid gap-3 sm:grid-cols-2">
        {agents.data.map((a) => {
          const m = managedByName.get(a.name);
          const activeV = m?.versions.find((v) => v.version === m.active);
          const latestVersion = m?.versions.length ? Math.max(...m.versions.map((v) => v.version)) : 0;
          return (
            <StaggerItem key={a.name} className={cn('rounded-md border border-border p-4', CARD_HOVER)}>
              <div className="flex items-start gap-2.5">
                <AgentAvatar live={!!activeV} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-foreground">{a.name}</span>
                    <Badge tone="model">{activeV?.model ?? a.model}</Badge>
                  </div>
                  {/* Status: managed+active version = live in prod (green + .live-dot pulse); relies on text too, not just color. */}
                  {activeV && <div className="mt-1"><Badge tone="success" live>{t('managedActiveBadge', { version: activeV.version })}</Badge></div>}
                  {/* Org-scoped agent: small `org · <id>` chip(s) — consistent with the Inspector org badge.
                      Operators (who see every org's agents) can tell org-scoped agents apart from global ones. */}
                  {!!a.orgs?.length && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {a.orgs.map((o) => <Badge key={o} tone="info">{t('orgBadge', { org: o })}</Badge>)}
                    </div>
                  )}
                  {/* Agent approval registry (governance) — see AgentApprovalBadge's JSDoc. Absent
                      entirely when the caller can't see the registry or @gnldev/server hasn't recorded
                      this agent yet (canSeeRegistry / registryByName). */}
                  {registryByName.get(a.name) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <AgentApprovalBadge record={registryByName.get(a.name)} />
                      <AgentApprovalControls name={a.name} record={registryByName.get(a.name)}
                        busy={registryBusy === a.name} onApprove={handleApproveAgent} onBlock={handleBlockAgent} />
                    </div>
                  )}
                </div>
              </div>
              {a.system && <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{a.system}</p>}
              {a.tools && a.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {a.tools.map((tool) => <Badge key={tool.name} tone={tool.guarded ? 'warning' : 'muted'}>{tool.name}{tool.guarded ? ' 🔒' : ''}</Badge>)}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>maxSteps: {a.maxSteps ?? '—'}</span>
                <div className="flex items-center gap-3">
                  {canManage && (
                    <button type="button" title={t('editCardTitle')}
                      onClick={() => { const v = activeV ?? m?.versions[m.versions.length - 1]; startEdit(a.name, v?.model ?? a.model ?? '', v?.system ?? a.system ?? '', v?.note ?? '', v ? `v${v.version}` : undefined); }}
                      className="inline-flex items-center gap-1 hover:text-brand"><Pencil size={11} /> {t('editLabel')}</button>
                  )}
                  <Link to="/playground" className="text-info underline">▶ Playground</Link>
                </div>
              </div>
              {m && (
                <>
                  <FreshnessBar active={m.active} latest={latestVersion} />
                  <div className="mt-3 border-t border-border pt-2">
                    <div className="flex items-center justify-between">
                      <div className="microlabel mb-1.5 text-muted-foreground">{t('versionsLabel')}</div>
                      {canManage && (
                        <button type="button" title={t('managedOnlyDeleteTitle')}
                          disabled={deleteBusy} onClick={() => setDeleting({ name: a.name, hasCode: true })}
                          className="rounded-sm p-0.5 text-muted-foreground enabled:hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed">
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                    <VersionPanel rec={m} canManage={canManage} evalGate={!!caps.data?.evalGate} onChanged={refresh}
                      onEdit={(v) => startEdit(a.name, v.model, v.system ?? '', v.note ?? '', `v${v.version}`)}
                      onDelete={(v) => setDeletingVer({ name: a.name, version: v.version, remaining: m.versions.length - 1 })} />
                  </div>
                </>
              )}
            </StaggerItem>
          );
        })}
          </Stagger>
        </section>
      )}

      {managedOnly.length > 0 && (
        <section>
          <SectionHead title={t('managedAgentsTitle')} hint={t('managedAgentsHint')} count={managedOnly.length} />
          <Stagger className="grid gap-3 sm:grid-cols-2">
        {managedOnly.map((m) => {
          const latestVersion = m.versions.length ? Math.max(...m.versions.map((v) => v.version)) : 0;
          const activeV = m.versions.find((v) => v.version === m.active);
          return (
            <StaggerItem key={m.name} className={cn('rounded-md border border-border p-4', CARD_HOVER)}>
              <div className="flex items-start gap-2.5">
                <AgentAvatar live={m.active != null} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold text-foreground">{m.name}</span>
                    {/* No edit here on purpose: a managed-only record has NO code agent, so it can't run and
                        can't take new versions (backend returns 422). Only deletion is offered. */}
                    {canManage && (
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        <button type="button" title={t('managedOnlyDeleteTitleNoCode')}
                          disabled={deleteBusy} onClick={() => setDeleting({ name: m.name, hasCode: false })}
                          className="rounded-sm p-0.5 text-muted-foreground enabled:hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Prod status in a single line: each agent's OWN prod version is clear → resolves the "what does 'both active' mean" confusion structurally. */}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {activeV
                      ? <>{t('prodVersionLabel')} <span className="font-mono font-semibold text-brand">v{activeV.version}</span> · <span className="font-mono">{activeV.model}</span></>
                      : t('prodNoneYet')}
                  </div>
                  {/* Honest dead-end marker: no code agent backs this record → it can't run. */}
                  <div className="mt-1 text-[11px] font-medium text-warning">⚠ {t('managedOnlyNoCodeWarning')}</div>
                </div>
              </div>
              <FreshnessBar active={m.active} latest={latestVersion} />
              <div className="mt-3">
                <VersionPanel rec={m} canManage={canManage} evalGate={!!caps.data?.evalGate} onChanged={refresh}
                  onEdit={(v) => startEdit(m.name, v.model, v.system ?? '', v.note ?? '', `v${v.version}`)}
                  onDelete={(v) => setDeletingVer({ name: m.name, version: v.version, remaining: m.versions.length - 1 })} />
              </div>
            </StaggerItem>
          );
        })}
          </Stagger>
        </section>
      )}
        </>
      )}

      {tab === 'create' && canManage && (
        <div>
          {/* The draft now SURVIVES tab switches (FORM-02), so the old "clicking Create resets the form"
              shortcut is gone — this gives it back explicitly, and is the only way to unpin `nameFixed`. */}
          <div className="microlabel mb-1.5 flex items-center gap-2 text-muted-foreground">
            <span>{draft.name ? t('editingDraftLabel', { name: draft.name }) : t('newAgentDraftLabel')}</span>
            {(isDraftFilled(draft) || nameFixed) && (
              <button type="button" onClick={() => { setDraft(BLANK); setNameFixed(false); }}
                className="rounded-sm px-1.5 py-0.5 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline">
                {t('startFreshDraftButton')}
              </button>
            )}
          </div>
          <NewVersionForm agentNames={agents.data?.map((a) => a.name) ?? []}
            draft={draft} setDraft={setDraft} nameFixed={nameFixed}
            onCreated={() => { refresh(); setTab('list'); }} />
        </div>
      )}
    </div>
    </div>
  );
}
