import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Play, RotateCw, History, X, Ban, Plus, Pencil, Trash2, GripVertical, Code2, Cpu, Copy, ArrowRight, GitFork, Columns2, Inbox, ChevronLeft } from 'lucide-react';
import {
  useWorkflows, useWorkflowRuns, useWorkflowRunsRegistry, useCapabilities, useAgents, runWorkflowStream, api, errMessage, useWorkflowRunState,
  type WorkflowMeta, type WorkflowRunResult, type WorkflowRunSummary, type WorkflowRunRegistryItem, type WorkflowDef, type WorkflowStepDef,
} from '../api';
import { Btn, Spinner, Badge, StatusBadge, EmptyState, ErrorBox, JsonBlock, cn } from '../components';
import { ConfirmDialog, toast } from '../ui';
import { diffWorkflowSteps } from './workflow-diff';

type Status = 'idle' | 'running' | 'done' | 'suspended' | 'failed' | 'cancelled';
interface StepState { status: Status; output?: unknown; ts?: number; ms?: number; error?: string }
interface GNode { id: string; label: string; kind: string; statusKey: string } // statusKey = stepId in the journal

const KIND_GLYPH: Record<string, string> = { parallel: '⇉', branch: '⌥', loop: '↻', foreach: '∀', step: '•', map: 'ƒ' };

/**
 * FLOW-08: derive a workflow name from a run's runId when the registry item doesn't carry one
 * (`WorkflowRunRegistryItem.workflowName` is optional — see api.ts). The runId convention, confirmed
 * From this file's own run() and runStepwise() (`` `${dry ? 'dry-' : ''}wf-${wf.name}-${Date.now()}` ``)
 * And mirrored server-side in @gnldev/durable's registry.ts (`` `wf-${name}-${Date.now()}` ``), is
 * `wf-<name>-<timestamp>` (optionally `dry-` prefixed). Workflow names may themselves contain hyphens
 * (e.g. 'order-fulfillment'), so a naive `split('-')[1]` would truncate them — instead every known
 * Name is tried as a `wf-<name>-<all-digit-timestamp>` prefix, and the LONGEST matching name wins
 * (so 'order' doesn't shadow 'order-fulfillment' when both exist). Returns null when no known name
 * Matches — callers fall back to letting the user pick.
 */
export function deriveWorkflowName(runId: string, knownNames: string[]): string | null {
  const candidateIds = runId.startsWith('dry-') ? [runId, runId.slice(4)] : [runId];
  let best: string | null = null;
  for (const name of knownNames) {
    for (const id of candidateIds) {
      const prefix = `wf-${name}-`;
      if (!id.startsWith(prefix)) continue;
      if (!/^\d+$/.test(id.slice(prefix.length))) continue; // must be followed by an all-digit timestamp
      if (best === null || name.length > best.length) best = name;
    }
  }
  return best;
}

// API-03: useWorkflowRunsRegistry now always passes a `limit`, so api.workflowRunsRegistry returns the
// Paged `{items,nextCursor}` envelope in practice — but its declared type stays the union it always was
// (the legacy flat array is still what a bare, limit-less call returns), so callers narrow at the edge.
function registryItems(data: WorkflowRunRegistryItem[] | { items: WorkflowRunRegistryItem[] } | undefined): WorkflowRunRegistryItem[] {
  if (!data) return [];
  return Array.isArray(data) ? data : data.items;
}

// Graph from build() steps: parallel(a+b) → sub-node fan-out (status from the parent key); others are single nodes.
function buildGraph(steps: { id: string; kind: string }[]): { nodes: GNode[]; edges: Edge[]; order: string[] } {
  const nodes: GNode[] = [];
  const edges: Edge[] = [];
  const order: string[] = [];
  let prev: string[] = [];
  const link = (to: string) => prev.forEach((p, i) => edges.push({ id: `${p}>${to}#${i}`, source: p, target: to }));
  for (const s of steps) {
    order.push(s.id);
    const par = /^parallel\((.+)\)$/.exec(s.id);
    if (par) {
      const subs = par[1].split('+');
      const ids = subs.map((x) => `${s.id}::${x}`);
      ids.forEach((id, i) => { nodes.push({ id, label: subs[i], kind: 'parallel', statusKey: s.id }); link(id); });
      prev = ids;
    } else {
      nodes.push({ id: s.id, label: s.id, kind: s.kind, statusKey: s.id });
      link(s.id);
      prev = [s.id];
    }
  }
  return { nodes, edges, order };
}

const STATUS_STYLE: Record<Status, { bg: string; bd: string }> = {
  idle: { bg: 'card', bd: 'border' },
  running: { bg: 'info', bd: 'info' },
  done: { bg: 'success', bd: 'success' },
  suspended: { bg: 'warning', bd: 'warning' },
  failed: { bg: 'destructive', bd: 'destructive' },
  cancelled: { bg: 'muted', bd: 'border' },
};

// MiniMap node color: react-flow's MiniMap paints nodes into an SVG, where `hsl(var(--x))` doesn't
// Resolve (no cascade into the generated <rect>) — so this needs a CONCRETE hex per status instead
// Of the token references STATUS_STYLE uses above. These hex values are hand-copied from this file's
// Dark theme (the default theme, index.css `:root`) tokens and MUST be kept in sync by hand if those
// Tokens ever change — there's no build-time or runtime link between them:
//   Running → --info #6bb6f7 · done → --success #3be38b · suspended → --warning #f2c14e ·
//   Failed → --destructive #ff6b6b · idle → --muted-foreground #9a9aa3 · cancelled → --border #35353d
// (idle/cancelled intentionally reuse existing neutral tokens rather than a fifth ad hoc gray.)
const MINIMAP_COLOR: Record<Status, string> = {
  idle: '#9a9aa3', running: '#6bb6f7', done: '#3be38b', suspended: '#f2c14e', failed: '#ff6b6b', cancelled: '#35353d',
};

function toFlowNodes(gnodes: GNode[], edges: Edge[], status: Record<string, StepState>): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  gnodes.forEach((n) => g.setNode(n.id, { width: 168, height: 46 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return gnodes.map((n) => {
    const st = status[n.statusKey]?.status ?? 'idle';
    const s = STATUS_STYLE[st];
    const p = g.node(n.id);
    return {
      id: n.id,
      position: { x: p.x - 84, y: p.y - 23 },
      data: { label: `${KIND_GLYPH[n.kind] ?? '•'} ${n.label}` },
      className: st === 'running' ? 'animate-pulse' : undefined,
      style: {
        width: 168, fontSize: 12, borderRadius: 8, padding: 8,
        border: `1.5px solid hsl(var(--${s.bd}))`,
        background: st === 'idle' ? 'hsl(var(--card))' : `hsl(var(--${s.bg})/0.15)`,
        color: 'hsl(var(--foreground))',
      },
    };
  });
}

export function Workflows() {
  const { t } = useTranslation('workflows');
  const wfs = useWorkflows();
  const caps = useCapabilities();
  const qc = useQueryClient();
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkflowDef | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  // D3-A: badge count on the sidebar toggle — fetched at this level (not just inside the inbox panel)
  // So it's visible while browsing the workflow list, same "needs attention" spirit as Approvals' badge.
  const suspendedRuns = useWorkflowRunsRegistry('suspended');
  // Tracks whether WorkflowDetail has a run in flight — switching the selected workflow (remount via
  // `key={selWf.name}`) or opening the inbox unmounts WorkflowDetail, whose cleanup effect aborts the
  // Stream. Surfaced from the child so navigation can be guarded instead of silently killing the run.
  const [running, setRunning] = useState(false);

  const selWf = wfs.data?.find((w) => w.name === sel) ?? wfs.data?.[0];
  const canManage = !!caps.data?.workflowManage;

  async function startEdit(wf: WorkflowMeta) {
    try {
      const def = await api.workflowDef(wf.name);
      setEditing(def);
    } catch { setEditing({ name: wf.name, description: wf.description ?? '', steps: [] }); }
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteWorkflow(name);
      qc.invalidateQueries({ queryKey: ['workflows'] });
      if (sel === name) setSel(null);
      toast.success(t('deleted', { name }));
    } catch (e) {
      toast.error(t('deleteFailed', { error: String(e) }));
    }
  }

  if (wfs.isLoading) return <Spinner />;
  // Query error (SEPARATE from the "no workflows" empty state): if the fetch fails, wfs.data stays
  // Undefined and the length check below would wrongly show "No workflows" — handle the real error first.
  if (wfs.error) return <ErrorBox error={wfs.error} />;

  if (editing) {
    return (
      <WorkflowEditor
        initial={editing === 'new' ? undefined : editing}
        onSave={async (def: WorkflowDef) => {
          if (editing === 'new') await api.createWorkflow(def);
          else await api.updateWorkflow(def.name, def);
          qc.invalidateQueries({ queryKey: ['workflows'] });
          setSel(def.name);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (showInbox) {
    return (
      <SuspendedRunsInbox
        workflows={wfs.data ?? []}
        canResume={!!caps.data?.workflowExec}
        canCancel={!!caps.data?.workflowRunCancel}
        onClose={() => setShowInbox(false)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={t('deleteWorkflowTitle')}
        description={t('deleteWorkflowDescription', { name: deleting })}
        confirmLabel={t('deleteConfirmLabel')}
        destructive
        onConfirm={() => { if (deleting) void handleDelete(deleting); }}
      />
      {/* Master-detail on mobile (<768px), same pattern as Tools/Inspector: the workflow LIST and
          the workflow DETAIL (graph + run controls) never fit side by side on a phone. Below md,
          show ONE panel at a time based on `sel` (list until a workflow is tapped, then the detail
          full-width with a back arrow); at md+, both panels stay side by side exactly as before. */}
      <div className={cn('w-full flex-col border-r border-border md:flex md:w-56', sel ? 'hidden md:flex' : 'flex')}>
        {canManage && (
          <div className="p-1.5 border-b border-border">
            <button type="button" onClick={() => setEditing('new')}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand px-2 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90">
              <Plus size={13} /> {t('newWorkflow')}
            </button>
          </div>
        )}
        <div className="p-1.5 border-b border-border">
          <button type="button" onClick={() => setShowInbox(true)} disabled={running} title={running ? t('runningGuardTitle') : undefined}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground">
            <Inbox size={13} /> {t('inboxToggleLabel')}
            {registryItems(suspendedRuns.data).length > 0 && <Badge tone="warning">{registryItems(suspendedRuns.data).length}</Badge>}
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {!wfs.data?.length && <p className="px-2 py-3 text-xs text-muted-foreground">{t('noWorkflows')}</p>}
          {wfs.data?.map((w) => {
            const active = (sel ?? wfs.data![0].name) === w.name;
            // Switching selection remounts WorkflowDetail (key={selWf.name}) and aborts an in-flight
            // Run — block navigation to a DIFFERENT workflow while one is running; re-clicking the
            // Active row is a no-op so it stays enabled.
            const navBlocked = running && !active;
            return (
              <div key={w.name} className={cn('group mb-0.5 flex items-center rounded-md border-l-2 transition-colors', active ? 'border-l-brand bg-muted' : 'border-l-transparent hover:bg-muted/60')}>
                <button type="button" onClick={() => setSel(w.name)} disabled={navBlocked} title={navBlocked ? t('runningGuardTitle') : undefined}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40">
                  {w.source === 'managed'
                    ? <Cpu size={11} className="shrink-0 text-primary" />
                    : <Code2 size={11} className="shrink-0 text-muted-foreground" />}
                  <span className="truncate font-mono text-xs">{w.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{w.steps.length}</span>
                </button>
                {canManage && w.source === 'managed' ? (
                  <div className="flex shrink-0 gap-0.5 pr-1">
                    <button type="button" title={t('editTitle')} onClick={() => startEdit(w)} className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"><Pencil size={11} /></button>
                    <button type="button" title={t('deleteTitle')} onClick={() => setDeleting(w.name)} className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive"><Trash2 size={11} /></button>
                  </div>
                ) : (
                  // VIS-06: this label is the ONLY visual signal that a workflow is code-defined
                  // (not editable from the UI) — was a hand-rolled text-[9px]/60 span (~3.1:1
                  // Contrast, the app's one 9px usage). Badge tone="muted" matches the mono
                  // 10px + full muted-foreground contrast already used for data tags elsewhere
                  // (e.g. the "from server"/"guessed" badges in the resume form below).
                  <span className="shrink-0 pr-2" title={t('codeDefinedTitle')}><Badge tone="muted">{t('codeLabel')}</Badge></span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className={cn('flex-1 overflow-hidden', !sel && 'hidden md:block')}>
        {selWf && (
          <WorkflowDetail
            key={selWf.name}
            wf={selWf}
            canRun={!!caps.data?.workflowExec}
            canManage={canManage}
            onEdit={() => startEdit(selWf)}
            onRunningChange={setRunning}
            onBack={() => setSel(null)}
          />
        )}
      </div>
    </div>
  );
}

// Extract expected parameters from a JSON Schema (read-only display; a lightweight counterpart to Tools' fieldsOf).
function paramsOf(schema: any): { key: string; type: string; required: boolean; description?: string }[] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const req: string[] = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(props).map(([key, v]: [string, any]) => ({
    key,
    type: Array.isArray(v?.enum) ? `enum(${v.enum.join('|')})` : (v?.type ?? 'any'),
    required: req.includes(key),
    description: typeof v?.description === 'string' ? v.description : undefined,
  }));
}

/**
 * Schema-driven input form: turns the fields in `workflowInputs.schema` into inputs.
 * The single source of truth is the JSON string — the form is derived from it on every
 * Render, and the JSON is updated whenever a field changes (this doesn't conflict with
 * Manual JSON editing; the form is disabled when the JSON is invalid).
 */
function InputForm({ params, input, onChange }: {
  params: { key: string; type: string; required: boolean; description?: string }[];
  input: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation('workflows');
  let obj: Record<string, any> | null = null;
  try { obj = input.trim() ? JSON.parse(input) : {}; } catch { obj = null; }

  if (obj === null) {
    return (
      <div className="border-b border-border bg-warning/5 px-4 py-1.5 text-xs text-warning">
        {t('invalidJsonForm')}
      </div>
    );
  }
  const base = obj;

  const setField = (key: string, value: unknown) => {
    const next = { ...base };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(JSON.stringify(next));
  };

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-muted/10 px-4 py-2">
      {params.map((p) => (
        <label key={p.key} className="flex flex-col gap-0.5 text-xs" title={p.description}>
          <span className="font-mono text-[10px] text-muted-foreground">
            {p.key}{p.required && <span className="text-warning">*</span>}
          </span>
          {p.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={base[p.key] === true}
              onChange={(e) => setField(p.key, e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--brand))]"
            />
          ) : p.type === 'number' || p.type === 'integer' ? (
            <input
              type="number"
              value={base[p.key] ?? ''}
              onChange={(e) => setField(p.key, e.target.value === '' ? undefined : Number(e.target.value))}
              placeholder={p.description}
              className="w-32 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none transition-colors"
            />
          ) : (
            <input
              value={typeof base[p.key] === 'string' ? base[p.key] : base[p.key] !== undefined ? JSON.stringify(base[p.key]) : ''}
              onChange={(e) => setField(p.key, e.target.value)}
              placeholder={p.description ?? p.type}
              className="w-44 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none transition-colors"
            />
          )}
        </label>
      ))}
    </div>
  );
}

// Input presets: the last 5 successful inputs are kept per workflow in localStorage (for playground iteration).
const PRESET_KEY = (wf: string) => `gnl-wf-presets:${wf}`;
function loadPresets(wf: string): string[] {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY(wf)) ?? '[]'); } catch { return []; }
}
function savePreset(wf: string, input: string): string[] {
  const next = [input, ...loadPresets(wf).filter((p) => p !== input)].slice(0, 5);
  localStorage.setItem(PRESET_KEY(wf), JSON.stringify(next));
  return next;
}

function WorkflowDetail({ wf, canRun, canManage, onEdit, onRunningChange, onBack }: {
  wf: WorkflowMeta; canRun: boolean; canManage: boolean; onEdit: () => void;
  /** Reports run-in-flight status up to the parent so it can guard navigation that would abort it. */
  onRunningChange?: (running: boolean) => void;
  /** Mobile-only: returns to the workflow list (see Workflows' top-level master-detail layout). */
  onBack?: () => void;
}) {
  const { t } = useTranslation('workflows');
  const qc = useQueryClient();
  const runs = useWorkflowRuns(wf.name);
  const [input, setInput] = useState(() => (wf.input?.example !== undefined ? JSON.stringify(wf.input.example) : '{}'));
  const [showForm, setShowForm] = useState(false);
  const [presets, setPresets] = useState<string[]>(() => loadPresets(wf.name));
  const [diffPair, setDiffPair] = useState<{ a: string; b: string } | null>(null);
  // Step-through: step-by-step run — while paused, the runId + maxSteps for the next call are kept.
  const [stepMode, setStepMode] = useState(false);
  const [dryMode, setDryMode] = useState(false);
  const [pausedInfo, setPausedInfo] = useState<{ runId: string; next: number; stepId: string; dry?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, StepState>>({});
  const [result, setResult] = useState<WorkflowRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<GNode | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastTs = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  const { nodes: gnodes, edges, order } = useMemo(() => buildGraph(wf.steps), [wf]);
  const flowNodes = useMemo(() => toFlowNodes(gnodes, edges, status), [gnodes, edges, status]);
  const params = useMemo(() => paramsOf(wf.input?.schema), [wf]);

  // If it's a managed workflow, fetch the step definitions (agent + prompt) → show in the NodePanel detail.
  const [defMap, setDefMap] = useState<Record<string, { agentName: string; prompt?: string }>>({});
  useEffect(() => {
    setDefMap({});
    if (wf.source !== 'managed') return;
    let alive = true;
    api.workflowDef(wf.name)
      .then((d) => { if (alive) setDefMap(Object.fromEntries(d.steps.map((s) => [s.id, { agentName: s.agentName, prompt: s.prompt }]))); })
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [wf.name, wf.source]);

  // Cancel the in-flight stream on unmount — otherwise monitoring keeps running in the background (a race/resource leak).
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Surface run-in-flight status to the parent (see onRunningChange doc) and clear it on unmount.
  useEffect(() => { onRunningChange?.(busy); }, [busy, onRunningChange]);
  useEffect(() => () => onRunningChange?.(false), []);

  const setStep = (id: string, st: Partial<StepState>) => setStatus((s) => ({ ...s, [id]: { ...(s[id] ?? { status: 'idle' }), ...st } }));

  // Step-by-step / dry-run execution: runs with a maxSteps limit and/or with stub agents (dryRun).
  async function runStepwise(next?: { runId: string; count?: number; dry?: boolean }) {
    let parsed: unknown = {};
    try { parsed = input.trim() ? JSON.parse(input) : {}; } catch { setErr(t('invalidJsonInput')); return; }
    if (!next) setPresets(savePreset(wf.name, input.trim() || '{}'));
    const dry = next?.dry ?? dryMode;
    const rid = next?.runId ?? `${dry ? 'dry-' : ''}wf-${wf.name}-${Date.now()}`;
    const count = next?.count ?? (stepMode ? 1 : undefined);
    setLastRunId(rid); setErr(null); setPicked(null); setBusy(true);
    try {
      const r = await api.runWorkflow(wf.name, {
        input: parsed, runId: rid,
        ...(count != null ? { maxSteps: count } : {}),
        ...(dry ? { dryRun: true } : {}),
      });
      setResult(r);
      // Step states: steps whose output landed in the journal are done; when paused, the next step is amber.
      const st: Record<string, StepState> = Object.fromEntries(order.map((id) => [id, { status: 'idle' as Status }]));
      for (const sp of r.steps) if (sp.output !== undefined) st[sp.id] = { status: 'done', output: sp.output };
      if (r.paused && r.stepId) st[r.stepId] = { status: 'suspended' };
      setStatus(st);
      setPausedInfo(r.paused && r.stepId ? { runId: rid, next: (count ?? 0) + 1, stepId: r.stepId, dry } : null);
      if (!r.paused && !dry) qc.invalidateQueries({ queryKey: ['wf-runs', wf.name] }); // dry-run leaves no trace
    } catch (e) {
      setErr(String(e));
      setPausedInfo(null);
    } finally {
      setBusy(false);
    }
  }

  async function run(runId?: string) {
    let parsed: unknown = {};
    try { parsed = input.trim() ? JSON.parse(input) : {}; } catch { setErr(t('invalidJsonInput')); return; }
    setPresets(savePreset(wf.name, input.trim() || '{}')); // successful parse → remember as a preset
    const rid = runId ?? `wf-${wf.name}-${Date.now()}`;
    setLastRunId(rid);
    setAttempt((a) => (runId ? a + 1 : 1)); // resume/retry use the same runId → attempt count increases
    setErr(null); setResult(null); setPicked(null); setBusy(true);
    setStatus(Object.fromEntries(order.map((id) => [id, { status: 'idle' as Status }])));
    if (order[0]) setStep(order[0], { status: 'running' });
    lastTs.current = Date.now();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await runWorkflowStream(wf.name, parsed, rid, (ev) => {
        if (ev.type === 'step') {
          const ms = ev.data.ts - lastTs.current; lastTs.current = ev.data.ts;
          setStep(ev.data.stepId, { status: 'done', output: ev.data.output, ts: ev.data.ts, ms, error: undefined });
          const i = order.indexOf(ev.data.stepId);
          if (i >= 0 && order[i + 1]) setStep(order[i + 1], { status: 'running' });
        } else if (ev.type === 'suspended') {
          setResult(ev.data); if (ev.data.stepId) setStep(ev.data.stepId, { status: 'suspended' });
        } else if (ev.type === 'done') {
          setResult(ev.data); order.forEach((id) => setStep(id, { status: 'done' }));
        } else if (ev.type === 'error') {
          setErr(ev.data.error);
          // Mark the step that errored: whichever step was "running" becomes failed + gets the error message.
          setStatus((s) => { const c = { ...s }; for (const k of order) if (c[k]?.status === 'running') c[k] = { status: 'failed', error: ev.data.error }; return c; });
        }
      }, ac.signal);
    } catch (e) {
      if (ac.signal.aborted) {
        setErr(t('cancelledNote'));
        setStatus((s) => { const c = { ...s }; for (const k of order) if (c[k]?.status === 'running') c[k] = { status: 'cancelled' }; return c; });
      } else { setErr(String(e)); }
    } finally {
      abortRef.current = null;
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['wf-runs', wf.name] }); // refresh persistent history (same key as the hook)
    }
  }

  async function openRun(runId: string) {
    setBusy(true); setErr(null); setResult(null); setPicked(null);
    try {
      const st = await api.workflowRun(runId);
      const next: Record<string, StepState> = {};
      for (const id of order) next[id] = { status: 'idle' };
      for (const s of st.steps) next[s.stepId] = { status: 'done', output: s.output };
      if (st.suspended && (st.suspend as any)?.stepId) next[(st.suspend as any).stepId] = { status: 'suspended' };
      setStatus(next);
      setLastRunId(runId); setAttempt(0);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const failed = !!err && !!lastRunId && !result?.suspended;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {/* Mobile-only back arrow: below md the list/detail panels are master-detail (see Workflows'
            top-level layout, same pattern as Tools/Inspector) — this is the only way back to the
            workflow list on a phone. Disabled while a run is in flight — same navigation guard as
            switching workflows in the list (leaving now would abort the stream). */}
        {onBack && (
          <button type="button" onClick={onBack} disabled={busy} title={busy ? t('runningGuardTitle') : t('backToWorkflowsTitle')}
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 md:hidden">
            <ChevronLeft size={16} />
          </button>
        )}
        <span className="font-mono text-sm font-semibold">{wf.name}</span>
        {wf.source === 'managed' && canManage && (
          <Btn size="xs" variant="ghost" onClick={onEdit} title={t('editTitle')}><Pencil size={12} /></Btn>
        )}
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('inputPlaceholder')}
          className="w-56 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none transition-colors" />
        {wf.input?.example !== undefined && !busy && (
          <Btn size="xs" variant="ghost" onClick={() => setInput(JSON.stringify(wf.input!.example))} title={t('fillExampleTitle')}>{t('exampleLabel')}</Btn>
        )}
        {params.length > 0 && (
          <Btn size="xs" variant={showForm ? 'outline' : 'ghost'} onClick={() => setShowForm((f) => !f)} title={t('schemaFormTitle')}>
            form
          </Btn>
        )}
        {canRun && !busy && (
          <Btn size="xs" onClick={() => (stepMode || dryMode ? runStepwise() : run())}>
            <Play size={13} /> {stepMode ? t('stepwiseStartLabel') : dryMode ? 'Dry-run' : t('runLabel')}
          </Btn>
        )}
        {canRun && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={t('stepModeTitle')}>
            <input type="checkbox" checked={stepMode} onChange={(e) => { setStepMode(e.target.checked); setPausedInfo(null); }} className="accent-[hsl(var(--brand))]" />
            {t('stepByStepCheckboxLabel')}
          </label>
        )}
        {canRun && wf.source === 'managed' && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={t('dryRunTitle')}>
            <input type="checkbox" checked={dryMode} onChange={(e) => { setDryMode(e.target.checked); setPausedInfo(null); }} className="accent-[hsl(var(--warning))]" />
            dry-run
          </label>
        )}
        {pausedInfo && canRun && !busy && (
          <Btn size="xs" variant="outline" onClick={() => runStepwise({ runId: pausedInfo.runId, count: pausedInfo.next, dry: pausedInfo.dry })} title={t('continueTitle', { stepId: pausedInfo.stepId })}>
            <Play size={13} /> {t('continueLabel', { stepId: pausedInfo.stepId })}
          </Btn>
        )}
        {busy && <Btn size="xs" variant="outline" onClick={() => abortRef.current?.abort()} title={t('cancelTitle')}><Ban size={13} /> {t('cancelLabel')}</Btn>}
        {result?.suspended && canRun && !busy && (
          <Btn size="xs" variant="outline" onClick={() => run(result.runId)} title={t('resumeTitle')}>
            <RotateCw size={13} /> Resume
          </Btn>
        )}
        {failed && canRun && !busy && (
          <Btn size="xs" variant="outline" onClick={() => run(lastRunId!)} title={t('retryTitle')}>
            <RotateCw size={13} /> Retry
          </Btn>
        )}
        {/* Run status, not a data tag → the pill-shaped StatusBadge (components.tsx), same visual
            language as any other status chip in the app — not the square/mono Badge used for data
            tags (model/tool names) elsewhere in this toolbar. Also fixes a color mismatch: this used
            to be tone="success" (green) while every other "running" indicator in this file (canvas
            node fill via STATUS_STYLE, NodeStatusBadge below) is info (blue). StatusBadge matches
            "running" case-insensitively and adds its own live pulse, so no separate `live` prop is
            needed here. */}
        {busy && <StatusBadge status="running" />}
        {attempt > 1 && <Badge tone="muted">{t('attemptBadge', { n: attempt })}</Badge>}
        {result?.suspended && <Badge tone="warning">{t('suspendedAtBadge', { stepId: result.stepId })}</Badge>}
        {pausedInfo && <Badge tone="info">{t('pausedAtBadge', { stepId: pausedInfo.stepId })}</Badge>}
        {result?.dryRun && <Badge tone="warning">dry-run</Badge>}
        {result && !result.suspended && <Badge tone="success">{t('completedBadge')}</Badge>}
        {err && <span className="text-xs text-destructive">{err}</span>}
        <HistMenu
          runs={runs.data ?? []}
          active={lastRunId}
          onOpen={openRun}
          onDiff={lastRunId ? (rid) => setDiffPair({ a: lastRunId!, b: rid }) : undefined}
        />
      </div>
      {wf.input && (wf.input.description || params.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/20 px-4 py-1.5 text-xs">
          {wf.input.description && <span className="text-muted-foreground">{wf.input.description}</span>}
          {params.length > 0
            ? params.map((p) => (
                <span key={p.key} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono" title={p.description}>
                  {p.key}<span className="text-muted-foreground">: {p.type}</span>{p.required && <span className="text-warning" title={t('requiredTitle')}>*</span>}
                </span>
              ))
            : <span className="text-muted-foreground">{t('noInputLabel')}</span>}
        </div>
      )}

      {/* Schema-driven input form: fields are two-way synced with the JSON (source = input state). */}
      {showForm && params.length > 0 && <InputForm params={params} input={input} onChange={setInput} />}

      {/* Presets: last successful inputs — restore with one click (survives an F5 refresh). */}
      {presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5">
          <span className="microlabel text-muted-foreground">preset</span>
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setInput(p)}
              title={p}
              className="max-w-56 truncate rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-brand/50 hover:text-foreground"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {diffPair && <WorkflowRunDiff a={diffPair.a} b={diffPair.b} onClose={() => setDiffPair(null)} />}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_, n) => setPicked(gnodes.find((g) => g.id === n.id) ?? null)}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={3}
              nodeColor={(n) => MINIMAP_COLOR[status[gnodes.find((g) => g.id === n.id)?.statusKey ?? '']?.status ?? 'idle']}
              nodeStrokeColor={(n) => MINIMAP_COLOR[status[gnodes.find((g) => g.id === n.id)?.statusKey ?? '']?.status ?? 'idle']}
              maskColor="rgba(127,127,127,0.18)"
            />
          </ReactFlow>
        </div>
        {picked && (
          <NodePanel
            node={picked}
            state={status[picked.statusKey]}
            suspend={result?.suspended && result.stepId === picked.statusKey ? result.reason : undefined}
            edges={edges}
            gnodes={gnodes}
            order={order}
            allStatus={status}
            runId={lastRunId}
            stepDef={defMap[picked.statusKey]}
            onClose={() => setPicked(null)}
            onWhatIf={
              canRun && lastRunId && !busy
                ? async (idx) => {
                    // What-if fork: outputs UP TO this step are copied into a new run; running it
                    // With the same input replays the copied steps, and this step onward re-runs.
                    try {
                      const r = await api.forkWorkflowRun(wf.name, lastRunId!, idx);
                      toast.success(t('forkSuccess', { count: r.copied }));
                      await run(r.newRunId);
                    } catch (e) {
                      toast.error(t('forkFailed', { error: String(e) }));
                    }
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function WorkflowEditor({ initial, onSave, onCancel }: {
  initial?: WorkflowDef;
  onSave: (def: WorkflowDef) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('workflows');
  const agents = useAgents();
  const [name, setName] = useState(initial?.name ?? '');
  const [desc, setDesc] = useState(initial?.description ?? '');
  const [steps, setSteps] = useState<WorkflowStepDef[]>(initial?.steps ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Dirty tracking: any edit to name/description/steps flips this — used to gate the Cancel button
  // Behind a confirm dialog instead of silently discarding a filled-in form.
  const [dirty, setDirty] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const agentNames = agents.data?.map((a) => a.name) ?? [];

  function handleNameChange(v: string) { setName(v); setDirty(true); }
  function handleDescChange(v: string) { setDesc(v); setDirty(true); }

  function addStep() {
    const id = t('stepIdPrefix', { n: steps.length + 1 });
    setSteps((s) => [...s, { id, agentName: agentNames[0] ?? '', prompt: '' }]);
    setDirty(true);
  }
  function removeStep(i: number) { setSteps((s) => s.filter((_, j) => j !== i)); setDirty(true); }
  function updateStep(i: number, patch: Partial<WorkflowStepDef>) {
    setSteps((s) => s.map((st, j) => j === i ? { ...st, ...patch } : st));
    setDirty(true);
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((s) => { const a = [...s]; [a[i], a[i + dir]] = [a[i + dir], a[i]]; return a; });
    setDirty(true);
  }

  function handleCancel() {
    if (dirty) setConfirmCancel(true);
    else onCancel();
  }

  async function save() {
    if (!name.trim()) { setErr(t('nameRequired')); return; }
    setSaving(true); setErr(null);
    try { await onSave({ name: name.trim(), description: desc.trim() || undefined, steps, updatedAt: Date.now() }); }
    catch (e: any) { setErr(String(e?.message ?? e)); setSaving(false); }
  }

  const inputCls = 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none transition-colors';

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t('discardChangesTitle')}
        description={t('discardChangesDescription')}
        confirmLabel={t('discardChangesConfirmLabel')}
        destructive
        onConfirm={onCancel}
      />
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-semibold">{initial ? t('editWorkflowHeading') : t('newWorkflow')}</span>
        <div className="ml-auto flex gap-2">
          <Btn size="xs" variant="outline" onClick={handleCancel} disabled={saving}>{t('cancelLabel')}</Btn>
          <Btn size="xs" onClick={save} busy={saving}>{saving ? t('saving') : t('saveAction')}</Btn>
        </div>
      </div>
      {err && <div className="mx-4 mt-3 rounded-sm bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}
      <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('nameLabel')}</label>
          <input value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder={t('workflowNamePlaceholder')} disabled={!!initial} className={inputCls} />
          {initial && <p className="text-[11px] text-muted-foreground">{t('nameImmutableNote')}</p>}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('descriptionLabel')}</label>
          <input value={desc} onChange={(e) => handleDescChange(e.target.value)} placeholder={t('descriptionPlaceholder')} className={inputCls} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('stepsLabel')}</span>
            <button type="button" onClick={addStep}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs text-primary hover:bg-muted">
              <Plus size={12} /> {t('addStepAction')}
            </button>
          </div>
          {steps.length === 0 && <p className="text-xs text-muted-foreground">{t('noStepsNote')}</p>}
          {steps.map((step, i) => (
            <div key={i} className="rounded-md border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex flex-col gap-0.5">
                  <button type="button" title={t('moveUpTitle')} onClick={() => i > 0 && moveStep(i, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><GripVertical size={14} className="-mb-1" /></button>
                  <button type="button" title={t('moveDownTitle')} onClick={() => i < steps.length - 1 && moveStep(i, 1)} disabled={i === steps.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><GripVertical size={14} className="-mt-1 rotate-180" /></button>
                </div>
                <span className="text-[11px] text-muted-foreground font-mono shrink-0">#{i + 1}</span>
                <input value={step.id} onChange={(e) => updateStep(i, { id: e.target.value })}
                  placeholder={t('stepIdPlaceholder')} aria-label={t('stepIdAriaLabel')} className="w-32 rounded-sm border border-input bg-background px-2 py-1 text-xs font-mono outline-none transition-colors" />
                <select title={t('selectAgentTitle')} value={step.agentName} onChange={(e) => updateStep(i, { agentName: e.target.value })}
                  className="flex-1 rounded-sm border border-input bg-background px-2 py-1 text-xs outline-none transition-colors">
                  {agentNames.length === 0 && <option value={step.agentName}>{step.agentName || t('selectAgentOption')}</option>}
                  {agentNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button type="button" title={t('removeStepTitle')} onClick={() => removeStep(i)} className="text-muted-foreground hover:text-destructive"><Trash2 size={13} /></button>
              </div>
              <textarea value={step.prompt ?? ''} onChange={(e) => updateStep(i, { prompt: e.target.value })}
                placeholder={t('promptTemplatePlaceholder')}
                aria-describedby={`step-prompt-help-${i}`}
                rows={2} className="w-full resize-none rounded-sm border border-input bg-background px-2 py-1.5 text-xs font-mono outline-none transition-colors" />
              {/* D4-8: the placeholder-only behavior note (empty = pass-through, {{input}}/{{prev}} meaning)
                  used to vanish the instant the operator started typing — exactly when it's most needed.
                  Kept as a permanent help line instead; the placeholder itself is now just a concrete example. */}
              <p id={`step-prompt-help-${i}`} className="text-[11px] text-muted-foreground">{t('promptTemplateHelp')}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * D3-A suspended-runs inbox — GET /workflows/runs?status=suspended lists
 * EVERY suspended run across ALL workflows (code + managed) in one registry scan, not just the
 * Currently-selected workflow's history. The registry record's `workflowName` is OPTIONAL (older
 * Records won't have it, see WorkflowRunRegistryItem's JSDoc) — when absent, the resume form falls back
 * To deriving it from the runId convention (deriveWorkflowName) and, failing that, to the existing
 * Workflows-list picker, so the operator is never forced to guess without a signal. Auto-refreshes
 * Every 5s (same cadence as Approvals.tsx's inbox).
 */
function SuspendedRunsInbox({ workflows, canResume, canCancel, onClose }: {
  workflows: WorkflowMeta[]; canResume: boolean; canCancel: boolean; onClose: () => void;
}) {
  const { t } = useTranslation('workflows');
  const qc = useQueryClient();
  const registry = useWorkflowRunsRegistry('suspended');
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['wf-runs-registry'] });
    qc.invalidateQueries({ queryKey: ['wf-runs'] });
  };

  const doCancel = async (runId: string) => {
    setBusy(runId);
    try {
      const r = await api.cancelWorkflowRun(runId);
      toast.success(r.cancelled ? t('inboxCancelSuccess', { runId }) : t('inboxCancelNoop', { runId }));
      invalidate();
    } catch (e) {
      toast.error(t('inboxActionFailed', { error: errMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const items = registryItems(registry.data);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Inbox size={14} className="text-muted-foreground" />
        <span className="text-sm font-semibold">{t('inboxHeading')}</span>
        <Badge tone="warning">{items.length}</Badge>
        <div className="ml-auto">
          <Btn size="xs" variant="outline" onClick={onClose}>{t('inboxCloseAction')}</Btn>
        </div>
      </div>
      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(o) => { if (!o) setCancelTarget(null); }}
        title={t('inboxCancelDialogTitle')}
        description={t('inboxCancelDialogDescription', { runId: cancelTarget })}
        confirmLabel={t('inboxCancelConfirmLabel')}
        destructive
        onConfirm={() => { if (cancelTarget) void doCancel(cancelTarget); }}
      />
      <div className="flex-1 overflow-auto p-4">
        {registry.isLoading && <Spinner />}
        {!registry.isLoading && items.length === 0 && (
          <EmptyState icon={Inbox} title={t('inboxEmptyTitle')} description={t('inboxEmptyDescription')} />
        )}
        <div className="space-y-2">
          {items.map((it) => (
            <SuspendedRunRow
              key={it.runId}
              item={it}
              workflows={workflows}
              canResume={canResume}
              canCancel={canCancel}
              busy={busy === it.runId}
              onCancelRequest={() => setCancelTarget(it.runId)}
              onResumed={invalidate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One suspended-run row: resume (workflow picker + JSON payload keyed to waitId) + cancel. */
function SuspendedRunRow({ item, workflows, canResume, canCancel, busy, onCancelRequest, onResumed }: {
  item: WorkflowRunRegistryItem; workflows: WorkflowMeta[]; canResume: boolean; canCancel: boolean; busy: boolean;
  onCancelRequest: () => void; onResumed: () => void;
}) {
  const { t } = useTranslation('workflows');
  const [expanded, setExpanded] = useState(false);
  // FLOW-08: server-confirmed name wins outright; otherwise try to derive it from the runId
  // Convention; otherwise fall back to the old single-workflow default (unchanged behavior).
  const guessedWfName = useMemo(
    () => (item.workflowName ? null : deriveWorkflowName(item.runId, workflows.map((w) => w.name))),
    [item.workflowName, item.runId, workflows],
  );
  const [wfName, setWfName] = useState(
    () => item.workflowName ?? guessedWfName ?? (workflows.length === 1 ? workflows[0]!.name : ''),
  );
  // Confidence badge next to the select: stays attached to whichever value it's currently showing —
  // If the operator edits the dropdown away from the derived/known name, the badge disappears (it
  // Would otherwise misrepresent a hand-picked value as confirmed/guessed).
  const nameConfidence: 'known' | 'guessed' | null =
    wfName && wfName === item.workflowName ? 'known' : wfName && wfName === guessedWfName ? 'guessed' : null;
  const [payload, setPayload] = useState('{}');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!item.waitId) return; // the submit button is disabled in this case too — defensive
    let parsed: unknown;
    try { parsed = payload.trim() ? JSON.parse(payload) : {}; } catch { setErr(t('invalidJsonInput')); return; }
    if (!wfName) { setErr(t('inboxSelectWorkflowError')); return; }
    setSubmitting(true); setErr(null);
    try {
      await api.runWorkflow(wfName, { runId: item.runId, resume: { [item.waitId]: parsed } });
      toast.success(t('inboxResumeSuccess', { runId: item.runId }));
      setExpanded(false);
      onResumed();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="truncate font-mono text-xs font-semibold" title={item.runId}>{item.runId}</span>
        {item.stepId && <Badge tone="info">{item.stepId}</Badge>}
        {item.waitId && <Badge tone="muted">wait: {item.waitId}</Badge>}
        <span className="text-[10px] text-muted-foreground">{t('inboxUpdatedAtLabel')} {new Date(item.updatedAt).toLocaleString()}</span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          {canResume && (
            <Btn variant="outline" size="xs" onClick={() => setExpanded((e) => !e)}>
              <RotateCw size={12} /> {t('inboxResumeAction')}
            </Btn>
          )}
          {canCancel && (
            <Btn variant="deny" size="xs" busy={busy} onClick={onCancelRequest}>
              <Ban size={12} /> {t('inboxCancelAction')}
            </Btn>
          )}
        </div>
      </div>
      {item.reason !== undefined && (
        <details className="mb-1.5">
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">{t('inboxReasonSummary')}</summary>
          <JsonBlock value={item.reason} max={400} />
        </details>
      )}
      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
          {!item.waitId && <p className="text-[11px] text-warning">{t('inboxNoWaitIdNote')}</p>}
          <label className="flex flex-col gap-1 text-xs">
            <span className="flex items-center gap-1.5">
              {t('inboxWorkflowLabel')}
              {nameConfidence === 'known' && (
                <span title={t('inboxWorkflowKnownTitle')}><Badge tone="success">{t('inboxWorkflowKnownBadge')}</Badge></span>
              )}
              {nameConfidence === 'guessed' && (
                <span title={t('inboxWorkflowGuessedTitle')}><Badge tone="muted">{t('inboxWorkflowGuessedBadge')}</Badge></span>
              )}
            </span>
            <select
              aria-label={t('inboxWorkflowLabel')}
              value={wfName}
              onChange={(e) => setWfName(e.target.value)}
              className="w-56 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors"
            >
              <option value="">{t('inboxSelectWorkflowOption')}</option>
              {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t('inboxPayloadLabel', { waitId: item.waitId ?? '?' })}
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none transition-colors"
            />
          </label>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <Btn size="xs" onClick={() => void submit()} busy={submitting} disabled={!item.waitId}>
            {submitting ? t('inboxSubmitting') : t('inboxSubmitResume')}
          </Btn>
        </div>
      )}
    </div>
  );
}

function NodePanel({ node, state, suspend, edges, gnodes, order, allStatus, runId, stepDef, onClose, onWhatIf }: {
  node: GNode; state?: StepState; suspend?: unknown;
  edges: Edge[]; gnodes: GNode[]; order: string[];
  allStatus: Record<string, StepState>; runId: string | null;
  stepDef?: { agentName: string; prompt?: string };
  onClose: () => void;
  /** If provided, the "what-if fork" button appears: everything up to this step is copied, and it branches from here. */
  onWhatIf?: (stepIndex: number) => void;
}) {
  const { t } = useTranslation('workflows');
  const [showFull, setShowFull] = useState(false);
  const labelOf = (id: string) => gnodes.find((g) => g.id === id)?.label ?? id;
  const deps = edges.filter((e) => e.target === node.id).map((e) => labelOf(e.source));
  const next = edges.filter((e) => e.source === node.id).map((e) => labelOf(e.target));
  const idx = order.indexOf(node.statusKey);
  const incoming = idx > 0 ? allStatus[order[idx - 1]]?.output : undefined;
  const journalKey = runId ? `${runId}:wf:${node.statusKey}` : null;
  const copy = (v: unknown) => { void navigator.clipboard?.writeText(typeof v === 'string' ? v : JSON.stringify(v, null, 2)).catch(() => {}); };

  return (
    // Below md the graph canvas has no room next to a 384px-wide inspector (see Workflows' VIS-02
    // Note) — it becomes a full-viewport overlay instead of a side panel; the existing X button
    // Above is the only way to dismiss it there too. z-30 stays under ConfirmDialog (z-40/z-50) so a
    // Confirm prompt opened from this view still renders on top of it. At md+, back to a normal
    // In-flow side panel (unchanged from before).
    <div className="fixed inset-0 z-30 overflow-auto bg-background p-3 md:static md:z-auto md:w-96 md:shrink-0 md:border-l md:border-border md:bg-transparent">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-semibold">{node.label}</div>
          {node.id !== node.label && <div className="truncate font-mono text-[10px] text-muted-foreground" title={node.id}>{node.id}</div>}
        </div>
        <button type="button" aria-label={t('closeAriaLabel')} onClick={onClose} className="shrink-0 text-muted-foreground hover:text-foreground"><X size={15} /></button>
      </div>

      <div className="space-y-1.5 text-xs">
        <Row k="kind"><Badge tone="info">{KIND_GLYPH[node.kind] ?? '•'} {node.kind}</Badge></Row>
        <Row k={t('statusRowLabel')}><NodeStatusBadge s={state?.status ?? 'idle'} /></Row>
        {idx >= 0 && <Row k={t('orderRowLabel')}>{idx + 1} / {order.length}</Row>}
        {state?.ms != null && <Row k={t('stepDurationRowLabel')}>{Math.max(0, Math.round(state.ms))} ms</Row>}
        {state?.ts != null && <Row k={t('timeRowLabel')}>{new Date(state.ts).toLocaleTimeString()}</Row>}
      </div>

      {/* What-if fork: outputs up to this step are copied into a new branch, then re-run from here. */}
      {onWhatIf && runId && idx >= 0 && (
        <div className="mb-2">
          <Btn size="xs" variant="outline" onClick={() => onWhatIf(idx)} title={t('whatIfForkTitle', { count: idx, label: node.label })}>
            <GitFork size={12} /> {t('whatIfForkAction')}
          </Btn>
        </div>
      )}

      {/* Managed step: agent + prompt template */}
      {stepDef && (
        <Section title={t('stepDefSectionTitle')}>
          <Row k="agent"><Badge tone="model">{stepDef.agentName || '—'}</Badge></Row>
          {stepDef.prompt && <div className="mt-1.5"><div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">prompt</div><JsonBlock value={stepDef.prompt} max={600} /></div>}
        </Section>
      )}

      {/* Graph connections */}
      {(deps.length > 0 || next.length > 0) && (
        <Section title={t('connectionsSectionTitle')}>
          {deps.length > 0 && <PinRow icon={<ArrowRight size={11} className="rotate-180" />} label={t('incomingLabel')} items={deps} />}
          {next.length > 0 && <PinRow icon={<ArrowRight size={11} />} label={t('outgoingLabel')} items={next} />}
        </Section>
      )}

      {/* Journal key (if it was run) */}
      {journalKey && (
        <Section title={t('journalKeySectionTitle')}>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-muted/40 px-1.5 py-1 font-mono text-[10px]" title={journalKey}>{journalKey}</code>
            <button type="button" title={t('copyTitle')} onClick={() => copy(journalKey)} className="shrink-0 text-muted-foreground hover:text-foreground"><Copy size={12} /></button>
          </div>
        </Section>
      )}

      {/* Data coming into this step (previous step's output) */}
      {incoming !== undefined && (
        <Section title={t('incomingDataSectionTitle')}><JsonBlock value={incoming} max={800} /></Section>
      )}

      {suspend != null && (
        <Section title="suspend reason" tone="warning"><JsonBlock value={suspend} max={400} /></Section>
      )}

      {state?.error && (
        <Section title={t('errorSectionTitle')} tone="destructive">
          <div className="break-words rounded-sm bg-destructive/10 p-2 font-mono text-[11px] text-destructive">{state.error}</div>
        </Section>
      )}

      {state?.output !== undefined && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t('outputLabel')}</span>
            <button type="button" title={t('copyTitle')} onClick={() => copy(state.output)} className="text-muted-foreground hover:text-foreground"><Copy size={12} /></button>
            <button type="button" onClick={() => setShowFull((s) => !s)} className="ml-auto text-[10px] text-primary hover:underline">{showFull ? t('collapseLabel') : t('expandLabel')}</button>
          </div>
          <JsonBlock value={state.output} max={showFull ? 1_000_000 : 1500} />
        </div>
      )}

      {state?.output === undefined && state?.status !== 'idle' && !state?.error && (
        <p className="mt-3 text-[11px] text-muted-foreground">{t('noOutputNote')}</p>
      )}
      {(!state || state.status === 'idle') && (
        <p className="mt-3 text-[11px] text-muted-foreground">{t('notRunYetNote')}</p>
      )}
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone?: 'warning' | 'destructive'; children: React.ReactNode }) {
  const c = tone === 'warning' ? 'text-warning' : tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className="mt-3 border-t border-border/60 pt-2.5">
      <div className={`mb-1 text-[10px] font-medium uppercase tracking-wide ${c}`}>{title}</div>
      {children}
    </div>
  );
}

function PinRow({ icon, label, items }: { icon: React.ReactNode; label: string; items: string[] }) {
  return (
    <div className="mb-1 flex items-start gap-1.5 text-xs">
      <span className="mt-0.5 flex w-12 shrink-0 items-center gap-1 text-muted-foreground">{icon} {label}</span>
      <span className="flex flex-wrap gap-1">{items.map((it, i) => <Badge key={i} tone="muted">{it}</Badge>)}</span>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex items-center gap-2"><span className="w-14 text-muted-foreground">{k}</span>{children}</div>;
}
// NodeStatusBadge: intentionally the square/mono data-tag `Badge` (not the pill-shaped `StatusBadge`
// Imported from components.tsx) — this renders inside NodePanel's technical key/value rows (kind,
// Order, journal key…), all styled as data tags, so the step status stays visually part of that
// Family. Named distinctly from the imported `StatusBadge` to avoid shadowing it in this file (see
// The real StatusBadge's use for the run-level indicator above, a different, higher-level concept).
function NodeStatusBadge({ s }: { s: Status }) {
  const tone = s === 'done' ? 'success' : s === 'running' ? 'info' : s === 'suspended' ? 'warning' : s === 'failed' ? 'destructive' : 'muted';
  return <Badge tone={tone as any}>{s}</Badge>;
}

/**
 * Side-by-side step outputs for two workflow runs (what-if fork analysis):
 * Identical outputs are dimmed (the replayed common prefix), and divergent ones are
 * Highlighted with A=info, B=brand.
 */
function WorkflowRunDiff({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const { t } = useTranslation('workflows');
  const sa = useWorkflowRunState(a);
  const sb = useWorkflowRunState(b);
  const rows = useMemo(
    () => diffWorkflowSteps(sa.data?.steps ?? [], sb.data?.steps ?? []),
    [sa.data, sb.data],
  );
  const diffCount = rows.filter((r) => !r.equal).length;
  // STATE-08: sa.error/sb.error were never read — a failed GET /workflows/run/:runId left `rows`
  // Empty, which read exactly like "both runs have identical steps" (0/0 in the header, then
  // NoStepsToCompareNote). For a what-if-fork comparison that's the one message that must never
  // Appear on a fetch failure: it reads as "the fork changed nothing" instead of "couldn't load".
  const loadError = sa.error ?? sb.error;

  return (
    <div className="border-b border-border bg-muted/10 px-4 py-2">
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className="microlabel">RUN DIFF</span>
        <span className="truncate font-mono text-info" title={a}>A: {a}</span>
        <span className="truncate font-mono text-brand" title={b}>B: {b}</span>
        {/* Hidden on error: a stale/zeroed "0 identical · 0 diverged" would misreport a fetch
            failure as "the two runs have no differences". */}
        {!loadError && <span className="text-muted-foreground">{t('diffSummary', { same: rows.length - diffCount, diff: diffCount })}</span>}
        <button type="button" onClick={onClose} className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground" aria-label={t('closeAriaLabel')}>
          <X size={13} />
        </button>
      </div>
      {(sa.isLoading || sb.isLoading) ? <Spinner /> : loadError ? <ErrorBox error={loadError} /> : (
        <div className="max-h-64 space-y-1.5 overflow-auto">
          {rows.map((r) => (
            <div key={r.stepId} className={`rounded-md border p-2 ${r.equal ? 'border-border opacity-55' : 'border-brand/40 bg-brand/5'}`}>
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-[11px] font-medium">{r.stepId}</span>
                {r.equal
                  ? <span className="microlabel text-muted-foreground">{t('identicalReplayLabel')}</span>
                  : <span className="microlabel text-brand">{t('deviationLabel')}</span>}
                {r.a === undefined && <Badge tone="info">{t('onlyBLabel')}</Badge>}
                {r.b === undefined && <Badge tone="warning">{t('onlyALabel')}</Badge>}
              </div>
              {r.equal ? (
                <JsonBlock value={r.a} max={240} />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div><div className="microlabel mb-0.5 text-info">A</div><JsonBlock value={r.a} max={300} /></div>
                  <div><div className="microlabel mb-0.5 text-brand">B</div><JsonBlock value={r.b} max={300} /></div>
                </div>
              )}
            </div>
          ))}
          {rows.length === 0 && <div className="py-2 text-xs text-muted-foreground">{t('noStepsToCompareNote')}</div>}
        </div>
      )}
    </div>
  );
}

function HistMenu({ runs, active, onOpen, onDiff }: {
  runs: WorkflowRunSummary[]; active: string | null; onOpen: (runId: string) => void;
  /** If provided, ⇄ appears in the row: compare this run side by side with the active run. */
  onDiff?: (runId: string) => void;
}) {
  const { t } = useTranslation('workflows');
  const [open, setOpen] = useState(false);
  if (runs.length === 0) return null;
  return (
    <div className="relative ml-auto">
      <Btn size="xs" variant="ghost" onClick={() => setOpen((o) => !o)}><History size={13} /> {t('historyHeading', { count: runs.length })}</Btn>
      {open && (
        <div className="absolute right-0 z-10 mt-1 max-h-80 w-80 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {runs.map((h) => (
            <div key={h.runId} className={`flex items-center gap-1 rounded-sm px-1 ${active === h.runId ? 'bg-muted' : ''}`}>
              <button type="button" onClick={() => { onOpen(h.runId); setOpen(false); }}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm px-1 py-1.5 text-left text-xs hover:bg-muted">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={h.suspended ? 'warning' : 'success'}>{h.suspended ? 'susp' : 'ok'}</Badge>
                  <span className="truncate font-mono">{h.runId}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">{h.startedAt ? new Date(h.startedAt).toLocaleTimeString() : t('stepsCountLabel', { count: h.steps })}</span>
              </button>
              {onDiff && active !== h.runId && (
                <button type="button" title={t('compareWithActiveTitle')} onClick={() => { onDiff(h.runId); setOpen(false); }}
                  className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <Columns2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
