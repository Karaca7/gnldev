import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, X, Wrench, Plus, Trash2, Pencil, Ban, Copy, Database, Activity, RotateCw, ArrowDown, Settings, Paperclip, FileText, PanelLeft, ChevronDown } from 'lucide-react';
import { useAgents, useCapabilities, useMe, useThreads, useWorkingMemory, streamAgent, api, errMessage, type Interrupt, type ThreadRecord, type AgentRunBody, type RunCost } from '../api';
import { Btn, Spinner, Empty, Badge, JsonBlock, cn } from '../components';
import { Markdown } from '../markdown';
import { Stagger, StaggerItem, Reveal } from '../motion';
import { toast } from '../ui';

type Attachment = { name: string; type: string; dataUrl: string };
export type Msg =
  | { role: 'user'; text: string; files?: Attachment[] }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; input: unknown; output?: unknown; toolCallId?: string };

// PURE function (testable): match a tool-result to its toolCallId during live streaming.
// The previous heuristic ("the LAST tool message without an output") wrote to the wrong
// bubble under parallel tool calls — id-based matching (like the byCallId pattern in mapMessages) finds the exact result.
export function matchToolResult(msgs: Msg[], toolCallId: string | undefined): number {
  if (!toolCallId) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'tool' && m.toolCallId === toolCallId) return i;
  }
  return -1;
}

// Attachment size limit: unbounded uploads bloat both the browser and the base64-encoded prompt body.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB

// PURE function (testable, DOM-independent): returns a clear rejection reason if the limit is exceeded.
// The i18n-dependent message is passed in via the optional `tooLargeMsg` callback (the same
// "robust" pattern as threadGroupLabel) — stays hook-free, and falls back to the EN default when
// called without the 2nd argument in tests.
export function validateAttachment(
  file: { size: number; type?: string },
  tooLargeMsg?: (mb: string) => string,
): { ok: true } | { ok: false; reason: string } {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: tooLargeMsg ? tooLargeMsg(mb) : `File too large (${mb} MB) — max 5 MB.` };
  }
  return { ok: true };
}

// Fallback resource for a local, NO-AUTH studio (a personal dev tool — one user, one machine). When
// auth IS on (shared/hosted studio, several developers), the resource is scoped to the authenticated
// user id instead (see `resourceId` in Playground, derived from GET /me) so each developer only sees
// their OWN Playground conversations — otherwise everyone's threads would pool under one resource.
const RESOURCE_ID = 'studio-user';
/** Per-user resource when authenticated; the shared fallback when auth is off (id === null). */
function resourceForUser(meId: string | null | undefined): string {
  return meId ? `studio:${meId}` : RESOURCE_ID;
}

// Model suggestions: known ids from the 4 providers the model-router supports.
// Suggestion only (datalist) — free text is always valid, the list may be incomplete.
const MODEL_SUGGESTIONS = [
  'anthropic/claude-fable-5', 'anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5-20251001',
  'openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/gpt-4o', 'openai/gpt-4o-mini',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
  'mistral/mistral-large-latest', 'mistral/mistral-small-latest',
];

// Session override persistence (survives F5; a single set independent of the agent — deliberately kept simple).
const OV_KEY = 'gnl-pg-overrides';
const savedOverrides: {
  modelOv?: string; systemOv?: string; tempOn?: boolean; tempOv?: number; topPOn?: boolean; topPOv?: number;
} = (() => {
  try { return JSON.parse(localStorage.getItem(OV_KEY) ?? '{}'); } catch { return {}; }
})();

// Convert messages coming from the server (AI SDK core-message format — response.messages) to the
// Playground's Msg type. content is an array of parts: 'text' → user/assistant bubble; a 'tool-call'
// inside an assistant message → opens a tool Msg (same fields as the live streamAgent's tool-call
// event: toolName/input); the tool result arrives SEPARATELY, in a role:'tool' message as a
// 'tool-result'/'tool-error' part, and is written as output onto the tool Msg matched by toolCallId
// (same pattern as the live streamAgent's tool-result event).
export function mapMessages(data: any[]): Msg[] {
  const out: Msg[] = [];
  const byCallId = new Map<string, number>();
  for (const m of data ?? []) {
    const role = m.role ?? m.__source;
    if (role === 'user') {
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text' && p.text).map((p: any) => p.text).join(' ')
        : (m.text ?? '');
      if (text) out.push({ role: 'user', text });
      continue;
    }
    if (role === 'assistant') {
      if (Array.isArray(m.content)) {
        // Preserve part order: text and tool-call can be interleaved → separate bubble/block, just like in the live stream.
        let buf = '';
        const flush = () => { if (buf) { out.push({ role: 'assistant', text: buf }); buf = ''; } };
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) buf += (buf ? ' ' : '') + p.text;
          else if (p?.type === 'tool-call') {
            flush();
            out.push({ role: 'tool', name: p.toolName, input: p.input });
            if (p.toolCallId) byCallId.set(p.toolCallId, out.length - 1);
          }
        }
        flush();
      } else {
        const text = typeof m.content === 'string' ? m.content : (m.text ?? '');
        if (text) out.push({ role: 'assistant', text });
      }
      continue;
    }
    if (role === 'tool' && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type !== 'tool-result' && p?.type !== 'tool-error') continue;
        const output = p.type === 'tool-result' ? p.output : { error: p.error };
        const i = p.toolCallId != null ? byCallId.get(p.toolCallId) : undefined;
        if (i != null) (out[i] as any).output = output;
        else out.push({ role: 'tool', name: p.toolName, input: undefined, output });
      }
    }
  }
  return out;
}

// Relative time label (for the thread row). `t` is passed in by the caller (HistorySidebar).
function relTime(ts: number | undefined, t: TFunction): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('justNow');
  const m = Math.floor(s / 60); if (m < 60) return t('minutesAgo', { count: m });
  const h = Math.floor(m / 60); if (h < 24) return t('hoursAgo', { count: h });
  const d = Math.floor(h / 24); if (d < 7) return t('daysAgo', { count: d });
  return new Date(ts).toLocaleDateString();
}

export function Playground() {
  const { t } = useTranslation('playground');
  const STARTERS = t('starters', { returnObjects: true }) as string[];
  const caps = useCapabilities();
  const agents = useAgents();
  const me = useMe();
  // Per-user thread scoping: authenticated → `studio:<id>`; local no-auth → the shared 'studio-user'.
  const resourceId = resourceForUser(me.data?.id);
  const qc = useQueryClient();
  const [agent, setAgent] = useState('');
  const [thread, setThread] = useState('');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Interrupt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState('');
  const [showWm, setShowWm] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');
  const [pinned, setPinned] = useState(true);
  const [cost, setCost] = useState<RunCost | null>(null);
  // Mobile master-detail (<768px): the history sidebar (w-60) used to sit side-by-side with the
  // chat column no matter the viewport, squeezing chat down to a sliver on a phone (the reported
  // "Send button clipped" bug). Below md, only ONE of {history, chat} is shown at a time.
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  // Session overrides (empty → the agent definition is used). Persisted in localStorage (survives F5).
  const [showSettings, setShowSettings] = useState(false);
  const [modelOv, setModelOv] = useState(() => savedOverrides.modelOv ?? '');
  const [systemOv, setSystemOv] = useState(() => savedOverrides.systemOv ?? '');
  const [tempOn, setTempOn] = useState(() => savedOverrides.tempOn ?? false);
  const [tempOv, setTempOv] = useState(() => savedOverrides.tempOv ?? 0.7);
  const [topPOn, setTopPOn] = useState(() => savedOverrides.topPOn ?? false);
  const [topPOv, setTopPOv] = useState(() => savedOverrides.topPOv ?? 1);
  // TOOLS: per-run enable/disable of the SELECTED agent's tools (config panel switches). Names in this
  // set are excluded → an allow-list of the remaining tools is passed to the run as a `tools` override.
  const [toolsOff, setToolsOff] = useState<Set<string>>(new Set());
  useEffect(() => {
    localStorage.setItem(OV_KEY, JSON.stringify({ modelOv, systemOv, tempOn, tempOv, topPOn, topPOv }));
  }, [modelOv, systemOv, tempOn, tempOv, topPOn, topPOv]);
  const runIdRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!agent && agents.data?.[0]) setAgent(agents.data[0].name); }, [agents.data, agent]);
  // Smart auto-scroll: only follow while the user is pinned to the bottom.
  useEffect(() => { if (pinned) endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, pending, pinned]);

  if (caps.data && !caps.data.playground) return <Empty>{t('playgroundDisabled')}</Empty>;
  if (agents.isLoading) return <Spinner />;

  const canStream = !!caps.data?.stream;
  const currentMeta = agents.data?.find((a) => a.name === agent);

  function onScroll() {
    const el = scrollRef.current; if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }
  function scrollToBottom() { setPinned(true); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }

  function pushAssistantDelta(text: string) {
    setMsgs((m) => {
      const last = m[m.length - 1];
      if (last?.role === 'assistant') return [...m.slice(0, -1), { role: 'assistant', text: last.text + text }];
      return [...m, { role: 'assistant', text }];
    });
  }

  // Run a single prompt (does NOT add the user message — the caller adds it). Shared core for send/regenerate/edit.
  async function runPrompt(prompt: string, attachments: Attachment[] = []) {
    if ((!prompt && attachments.length === 0) || !agent || busy) return;
    const runId = `pg-${Date.now()}`;
    runIdRef.current = runId;
    setLastRunId(runId);
    setError(null);
    setCost(null);
    setPending([]);
    setBusy(true);
    const memoryOn = !!caps.data?.memory;
    // With memory on, every conversation gets a persistent threadId + resourceId → shows up in the history list.
    let tid = thread;
    if (memoryOn && !tid) { tid = crypto.randomUUID(); setThread(tid); }
    // Session overrides (empty → agent definition).
    const overrides = {
      ...(modelOv.trim() ? { model: modelOv.trim() } : {}),
      ...(systemOv.trim() ? { system: systemOv } : {}),
      ...(tempOn ? { temperature: tempOv } : {}),
      ...(topPOn ? { topP: topPOv } : {}),
      // Tool allow-list: only sent when the user has disabled ≥1 tool in the config panel.
      ...(currentMeta?.tools && toolsOff.size
        ? { tools: currentMeta.tools.map((x) => x.name).filter((n) => !toolsOff.has(n)) }
        : {}),
    };
    // If there are attachments, use AI SDK message parts (image → image, other → file); otherwise a plain prompt.
    const msgBody = attachments.length
      ? { messages: [{ role: 'user', content: [
          ...(prompt ? [{ type: 'text', text: prompt }] : []),
          ...attachments.map((a) => a.type.startsWith('image/')
            ? { type: 'image', image: a.dataUrl }
            : { type: 'file', data: a.dataUrl, mediaType: a.type }),
        ] }] }
      : { prompt };
    const body: AgentRunBody = memoryOn
      ? { runId, threadId: tid, resourceId, ...msgBody, ...overrides }
      : { runId, threadId: runId, ...msgBody, ...overrides };
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (canStream) {
        await streamAgent(agent, body, (ev) => {
          if (ev.type === 'text-delta') pushAssistantDelta(ev.data.text);
          else if (ev.type === 'tool-call') setMsgs((m) => [...m, { role: 'tool', name: ev.data.toolName, input: ev.data.input, toolCallId: ev.data.toolCallId }]);
          else if (ev.type === 'tool-result')
            setMsgs((m) => {
              const i = matchToolResult(m, ev.data.toolCallId);
              if (i < 0) return m;
              const c = [...m]; (c[i] as any).output = ev.data.output; return c;
            });
          else if (ev.type === 'interrupt') setPending(ev.data.interrupts);
          else if (ev.type === 'error') setError(ev.data.error);
        }, ac.signal);
      } else {
        const r = await api.runAgent(agent, body);
        if (r.text) pushAssistantDelta(r.text);
        if (r.interrupts?.length) setPending(r.interrupts);
      }
    } catch (e) {
      // If the user pressed "Stop", fail silently; the partial response stays on screen.
      if (!ac.signal.aborted) setError(String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Fetch the turn's cost/tokens (the journal is written synchronously → ready immediately). Don't let a stale run overwrite the current one.
      try { const c = await api.cost(runId); if (runIdRef.current === runId) setCost(c); } catch { /* silent if there's no cost */ }
      // Reflect the new/active thread in the history list (the title is generated asynchronously on the server).
      if (memoryOn) qc.invalidateQueries({ queryKey: ['threads'] });
    }
  }

  async function send(promptArg?: string) {
    const prompt = (promptArg ?? input).trim();
    const atts = promptArg === undefined ? files : [];
    if ((!prompt && atts.length === 0) || !agent || busy) return;
    setEditing(null);
    setMsgs((m) => [...m, { role: 'user', text: prompt, files: atts.length ? atts : undefined }]);
    if (promptArg === undefined) { setInput(''); setFiles([]); }
    await runPrompt(prompt, atts);
  }

  // Read the selected files as data URLs (image/PDF attachments). Files over 5MB are rejected (toast).
  function addFiles(fl: FileList) {
    const accepted: File[] = [];
    for (const f of Array.from(fl)) {
      const v = validateAttachment(f, (mb) => t('attachmentTooLarge', { mb }));
      if (v.ok) accepted.push(f);
      else toast.error(`${f.name}: ${v.reason}`);
    }
    if (!accepted.length) return;
    Promise.all(accepted.map((f) => new Promise<Attachment>((res) => {
      const r = new FileReader();
      r.onload = () => res({ name: f.name, type: f.type || 'application/octet-stream', dataUrl: String(r.result) });
      r.readAsDataURL(f);
    }))).then((atts) => setFiles((p) => [...p, ...atts]));
  }

  // Regenerate the last response: drop everything after the last user message, re-run the same prompt (with its attachments).
  async function regenerate() {
    if (busy) return;
    setEditing(null);
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { lastUser = i; break; } }
    if (lastUser < 0) return;
    const u = msgs[lastUser] as Extract<Msg, { role: 'user' }>;
    const atts = u.files ?? [];
    if (!u.text.trim() && atts.length === 0) return; // can't be re-run → keep the existing response
    setMsgs((m) => m.slice(0, lastUser + 1));
    warnStaleServerHistory();
    await runPrompt(u.text, atts);
  }

  // Edit & resend a user message: drop everything after that point, run with the new text.
  async function submitEdit(i: number) {
    const p = editVal.trim();
    setEditing(null);
    if (!p || busy) return;
    setMsgs((m) => [...m.slice(0, i), { role: 'user', text: p }]);
    warnStaleServerHistory();
    await runPrompt(p);
  }

  // There is NO "drop everything after this point" (thread truncate) endpoint on the server — the
  // /threads/:id routes in server.ts only offer rename (PATCH) and delete (DELETE). So edit/regenerate
  // only trims the LOCAL view; with memory on, the thread history on the server still contains the old
  // turn, and it reappears once the page is reloaded and restored via loadThread. To avoid misleading
  // the user, we surface this explicitly (rather than calling a made-up "truncate" API).
  function warnStaleServerHistory() {
    if (caps.data?.memory && thread) toast(t('staleHistoryWarning'));
  }

  async function decide(approvals: Record<string, boolean>) {
    const rid = runIdRef.current;
    setPending([]);
    setError(null);
    setBusy(true);
    try {
      // Approval → re-run with the same runId + approvals (the pending tool is released).
      const r = await api.runAgent(agent, { runId: rid, approvals });
      if (r.text) pushAssistantDelta(r.text);
      if (r.interrupts?.length) setPending(r.interrupts);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      try { const c = await api.cost(rid); if (runIdRef.current === rid) setCost(c); } catch { /* silent if there's no cost */ }
      if (caps.data?.memory) qc.invalidateQueries({ queryKey: ['threads'] });
    }
  }

  // Select a past conversation → load its messages, continue the chat where it left off.
  async function loadThread(t: ThreadRecord) {
    if (busy) return;
    runIdRef.current = '';
    setThread(t.id);
    setError(null);
    setCost(null);
    setLastRunId('');
    setPending([]);
    setInput('');
    setFiles([]);
    setEditing(null);
    setEditVal('');
    try {
      setMsgs(mapMessages(await api.messages(t.id)));
    } catch (e) {
      setError(String(e));
      setMsgs([]);
    }
  }

  // Switching agents starts a FRESH conversation. The messages on screen — and the ACTIVE thread — belong
  // to the previous agent: keeping them would not only show its history under a different agent, it would
  // append the new agent's turns into the old agent's thread. Nothing is lost with memory on — the old
  // thread stays in the History list, one click away. Per-agent tool toggles are dropped too (they name
  // the previous agent's tools). The select is disabled while a run is in flight, so this never races a stream.
  function changeAgent(name: string) {
    if (name === agent) return;
    setAgent(name);
    setToolsOff(new Set());
    newConversation();
  }

  // Clean chat: the next send creates a new thread.
  function newConversation() {
    runIdRef.current = '';
    setThread('');
    setMsgs([]);
    setPending([]);
    setError(null);
    setCost(null);
    setLastRunId('');
    setInput('');
    setFiles([]);
    setEditing(null);
    setEditVal('');
  }

  // Configuration fields (agent · model · temperature · top-p · system · tools) — rendered in BOTH the
  // persistent desktop left panel and the mobile Settings dropdown (single source, closes over state).
  const configFields = (
    <div className="space-y-4">
      <div>
        <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgAgent')}</label>
        <select aria-label="Agent" value={agent} disabled={busy} onChange={(e) => changeAgent(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
          {agents.data?.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
        </select>
      </div>
      <div>
        <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgModel')}</label>
        <input aria-label={t('cfgModel')} value={modelOv} onChange={(e) => setModelOv(e.target.value)} list="pg-models"
          placeholder={typeof currentMeta?.model === 'string' && currentMeta.model ? currentMeta.model : t('agentDefaultPlaceholder')}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-1 focus:ring-ring" />
      </div>
      <div>
        <label className="microlabel mb-1.5 flex items-center justify-between text-muted-foreground">
          <span className="flex items-center gap-1.5"><input type="checkbox" checked={tempOn} onChange={(e) => setTempOn(e.target.checked)} className="accent-primary" /> {t('cfgTemperature')}</span>
          <span className="tabular-nums">{tempOn ? tempOv.toFixed(1) : '—'}</span>
        </label>
        <input aria-label="Temperature" type="range" min={0} max={2} step={0.1} value={tempOv} disabled={!tempOn}
          onChange={(e) => setTempOv(Number(e.target.value))} className="w-full accent-primary disabled:opacity-40" />
      </div>
      <div>
        <label className="microlabel mb-1.5 flex items-center justify-between text-muted-foreground">
          <span className="flex items-center gap-1.5"><input type="checkbox" checked={topPOn} onChange={(e) => setTopPOn(e.target.checked)} className="accent-primary" /> {t('cfgTopP')}</span>
          <span className="tabular-nums">{topPOn ? topPOv.toFixed(2) : '—'}</span>
        </label>
        <input aria-label="Top-p" type="range" min={0} max={1} step={0.05} value={topPOv} disabled={!topPOn}
          onChange={(e) => setTopPOv(Number(e.target.value))} className="w-full accent-primary disabled:opacity-40" />
      </div>
      <div>
        <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgSystem')}</label>
        <textarea aria-label={t('cfgSystem')} value={systemOv} onChange={(e) => setSystemOv(e.target.value)} rows={4}
          placeholder={currentMeta?.system || t('agentDefaultPlaceholder')}
          className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" />
      </div>
      {currentMeta?.tools && currentMeta.tools.length > 0 && (
        <div>
          <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgTools')}</label>
          <div className="space-y-0.5">
            {currentMeta.tools.map((tool) => {
              const on = !toolsOff.has(tool.name);
              return (
                <button key={tool.name} type="button" title={tool.description}
                  onClick={() => setToolsOff((s) => { const n = new Set(s); if (on) n.add(tool.name); else n.delete(tool.name); return n; })}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60">
                  <span className="truncate font-mono text-sm text-foreground">{tool.name}</span>
                  <span aria-hidden className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-brand' : 'bg-muted')}>
                    <span className={cn('absolute top-0.5 h-3 w-3 rounded-full transition-all', on ? 'left-3.5 bg-brand-foreground' : 'left-0.5 bg-muted-foreground')} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="text-[11px] leading-relaxed text-muted-foreground">{t('overrideHint')}</div>
    </div>
  );

  return (
    <div className="flex h-full flex-col md:flex-row">
      {caps.data?.memory && (
        <HistorySidebar
          open={mobileHistoryOpen}
          activeId={thread}
          busy={busy}
          onSelect={(th) => { setMobileHistoryOpen(false); loadThread(th); }}
          onNew={() => { setMobileHistoryOpen(false); newConversation(); }}
          onDeleted={(id) => { if (id === thread) newConversation(); }}
          configSlot={configFields}
          resourceId={resourceId}
        />
      )}
      {/* Configuration lives UNDER the thread list in the History sidebar (collapsible section). When memory
          is OFF there's no sidebar, so a ⚙ popover in the top toolbar (below) is the fallback home for it. */}
      <div className={cn('h-full min-w-0 flex-1 flex-col', mobileHistoryOpen ? 'hidden md:flex' : 'flex')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {/* Mobile-only: open the conversation history as a full-width panel (master-detail —
              see the wrapper divs above). Only relevant when memory/threads are on. */}
          {caps.data?.memory && (
            <span className="md:hidden">
              <Btn variant="ghost" size="xs" onClick={() => setMobileHistoryOpen(true)} title={t('historyButton')}>
                <PanelLeft size={14} />
              </Btn>
            </span>
          )}
          {/* Agent name as a compact label. Config normally lives under the thread list (sidebar); only when
              memory is OFF (no sidebar) does it fall back to a ⚙ popover anchored right here. */}
          <span className="font-mono text-sm text-foreground">{agent}</span>
          {!caps.data?.memory && (
            <div className="relative">
              <Btn variant="ghost" size="xs" onClick={() => setShowSettings((s) => !s)} title={t('configurationTitle')}>
                <Settings size={14} /> {t('settingsButton')}
              </Btn>
              {showSettings && (
                <>
                  {/* Click-away backdrop (transparent) — closes the popover; sits under it, over everything else. */}
                  <div className="fixed inset-0 z-20" onClick={() => setShowSettings(false)} aria-hidden />
                  <div className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-auto rounded-md border border-border bg-background p-4 shadow-lg">
                    <div className="microlabel mb-3 text-foreground">{t('configurationTitle')}</div>
                    {configFields}
                  </div>
                </>
              )}
            </div>
          )}
          {/* Live stream: pulse only while busy+streaming — double-coded with the "streaming" text (WCAG 1.4.1). */}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground md:ml-auto">
            {busy && canStream && <span className="live-dot" aria-hidden />}
            {canStream ? 'streaming' : 'sync'}{cost ? ` · ${cost.totalTokens} tok · $${cost.costUsd.toFixed(4)}` : ''}
          </span>
          {msgs.some((m) => m.role === 'user') && !busy && <Btn variant="ghost" size="xs" onClick={regenerate}><RotateCw size={14} /> {t('regenerateButton')}</Btn>}
          {caps.data?.memory && thread && <Btn variant="ghost" size="xs" onClick={() => setShowWm((s) => !s)}><Database size={14} /> {t('memoryButton')}</Btn>}
          {lastRunId && (
            <Link to={`/inspector?run=${encodeURIComponent(lastRunId)}`} title={t('inspectLinkTitle')}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Activity size={14} /> {t('inspectButton')}
            </Link>
          )}
          {busy && canStream && <Btn variant="ghost" size="xs" onClick={() => abortRef.current?.abort()}><Ban size={14} /> {t('stopButton')}</Btn>}
          {!caps.data?.memory && <Btn variant="ghost" size="xs" onClick={newConversation}>{t('clearButton')}</Btn>}
        </div>

        <datalist id="pg-models">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
        {showWm && thread && <WorkingMemoryPanel id={thread} />}

        <div className="relative flex-1 overflow-hidden">
          <div ref={scrollRef} onScroll={onScroll} className="h-full space-y-2 overflow-auto p-4">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <Empty>{t('emptyPrompt')}</Empty>
                <Stagger className="flex flex-wrap gap-1.5 px-6">
                  {STARTERS.map((s) => (
                    <StaggerItem key={s}>
                      <button type="button" onClick={() => send(s)} disabled={!agent || busy}
                        className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50">{s}</button>
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            )}
            <Stagger className="space-y-2">
              {msgs.map((m, i) => (
                editing === i && m.role === 'user'
                  ? <EditRow key={i} value={editVal} onChange={setEditVal} onSave={() => submitEdit(i)} onCancel={() => setEditing(null)} />
                  : (
                    <StaggerItem key={i}>
                      <MsgBlock
                        msg={m}
                        canEdit={m.role === 'user' && !busy}
                        onEdit={() => { setEditing(i); setEditVal((m as Extract<Msg, { role: 'user' }>).text); }}
                        streaming={busy && i === msgs.length - 1 && m.role === 'assistant'}
                      />
                    </StaggerItem>
                  )
              ))}
            </Stagger>
            {pending.length > 0 && (
              <Reveal>
                <ApprovalCards interrupts={pending} busy={busy} onDecide={decide} />
              </Reveal>
            )}
            {error && (
              <Reveal className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span className="min-w-0 break-words">⚠ {error}</span>
                {msgs.some((m) => m.role === 'user') && <Btn variant="ghost" size="xs" onClick={regenerate}><RotateCw size={13} /> {t('retryButton')}</Btn>}
              </Reveal>
            )}
            <div ref={endRef} />
          </div>
          {!pinned && (
            <button type="button" onClick={scrollToBottom} title={t('scrollToBottomTitle')}
              className="absolute bottom-3 right-3 rounded-full border border-border bg-background p-1.5 text-muted-foreground shadow transition-colors hover:text-foreground">
              <ArrowDown size={16} />
            </button>
          )}
        </div>

        <div className="border-t border-border p-3">
          {files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
                  {f.type.startsWith('image/') ? <img src={f.dataUrl} alt={f.name} className="h-6 w-6 rounded object-cover" /> : <FileText size={13} className="text-muted-foreground" />}
                  <span className="max-w-[140px] truncate">{f.name}</span>
                  <button type="button" title={t('removeTitle')} onClick={() => setFiles((p) => p.filter((_, k) => k !== i))} className="text-muted-foreground hover:text-foreground"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <label title={t('attachFileTitle')} className="flex cursor-pointer items-center rounded-md border border-input px-2 text-muted-foreground transition-colors hover:bg-muted">
              <Paperclip size={15} />
              <input type="file" aria-label={t('attachFileAriaLabel')} multiple accept="image/*,application/pdf" className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            {/* Prompt-style input (GNL Input recipe): lime "›" prefix + blinking caret, mono; lime border + glow ring on focus. */}
            <div className="flex flex-1 items-start gap-1.5 rounded-md border border-input bg-background px-3 py-2 transition-colors focus-within:border-brand focus-within:shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]">
              <span aria-hidden className="select-none pt-0.5 font-mono text-sm text-brand">›</span>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
                placeholder={t('messagePlaceholder')}
                rows={2}
                className="flex-1 resize-none bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
              />
              <span aria-hidden className="brand-caret mt-1.5" />
            </div>
            <Btn arrow onClick={() => send()} disabled={busy || (!input.trim() && files.length === 0)}>{t('sendButton')}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistorySidebar({ open, activeId, busy, onSelect, onNew, onDeleted, configSlot, resourceId }: {
  /** Mobile-only master-detail toggle (see the `mobileHistoryOpen` state in Playground) — always
   *  visible at md+ regardless of this flag. */
  open: boolean;
  activeId: string; busy: boolean; onSelect: (t: ThreadRecord) => void; onNew: () => void; onDeleted: (id: string) => void;
  /** The Configuration fields, rendered as a collapsible section UNDER the thread list (state is owned by
   *  Playground; this component just slots the node in). */
  configSlot?: ReactNode;
  /** Per-user (or shared-fallback) resource the thread list is scoped to — see Playground's `resourceId`. */
  resourceId: string;
}) {
  const { t } = useTranslation('playground');
  const [allRes, setAllRes] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(true);
  const threads = useThreads(allRes ? undefined : resourceId);
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function saveRename(id: string) {
    const title = renameVal.trim();
    setRenaming(null);
    if (!title) return;
    setWorking(true);
    try { await api.renameThread(id, title); qc.invalidateQueries({ queryKey: ['threads'] }); }
    catch (e) { toast.error(errMessage(e)); }
    finally { setWorking(false); }
  }

  async function doDelete(id: string) {
    setConfirmDel(null);
    setWorking(true);
    try { await api.deleteThread(id); qc.invalidateQueries({ queryKey: ['threads'] }); onDeleted(id); }
    catch (e) { toast.error(errMessage(e)); }
    finally { setWorking(false); }
  }

  return (
    <div className={cn('w-full flex-col border-r border-border md:flex md:w-64', open ? 'flex' : 'hidden md:flex')}>
      <div className="space-y-1.5 border-b border-border p-2">
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus size={14} /> {t('newChatButton')}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={allRes} onChange={(e) => setAllRes(e.target.checked)} className="accent-primary" />
          {t('allConversations')}
        </label>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-1.5">
        {threads.isLoading ? (
          <Spinner />
        ) : !threads.data?.length ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">{t('noConversationsYet')}</div>
        ) : (
          threads.data.map((th) => {
            const active = activeId === th.id;
            if (renaming === th.id) {
              return (
                <div key={th.id} className="mb-0.5 px-1 py-0.5">
                  <input
                    autoFocus
                    aria-label={t('conversationNamePlaceholder')}
                    placeholder={t('conversationNamePlaceholder')}
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(th.id); else if (e.key === 'Escape') setRenaming(null); }}
                    onBlur={() => setRenaming(null)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              );
            }
            return (
              <div key={th.id} className={cn('group mb-0.5 flex items-center gap-1 rounded-md pr-1', active ? 'bg-muted' : 'hover:bg-muted/60')}>
                <button
                  type="button"
                  onClick={() => onSelect(th)}
                  disabled={busy || working}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-2 text-left disabled:opacity-50"
                >
                  <span className="w-full truncate text-sm">{th.title || th.id}</span>
                  <span className="w-full truncate text-[10px] text-muted-foreground">{relTime(th.updatedAt ?? th.createdAt, t)}{allRes && th.resourceId ? ` · ${th.resourceId}` : ''}</span>
                </button>
                {confirmDel === th.id ? (
                  <div className="flex items-center gap-0.5">
                    <button type="button" title={t('delete')} onClick={() => doDelete(th.id)} disabled={working} className="rounded p-1 text-destructive hover:bg-destructive/15 disabled:opacity-50"><Check size={13} /></button>
                    <button type="button" title={t('cancel')} onClick={() => setConfirmDel(null)} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={13} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" title={t('rename')} onClick={() => { setRenaming(th.id); setRenameVal(th.title || ''); }} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil size={13} /></button>
                    <button type="button" title={t('delete')} onClick={() => setConfirmDel(th.id)} className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {/* Configuration — a collapsible section pinned UNDER the thread list. The thread list above scrolls
          (flex-1 min-h-0); this section has its own bounded scroll so it never crowds the list out. */}
      {configSlot && (
        <div className="shrink-0 border-t border-border">
          <button
            type="button"
            onClick={() => setCfgOpen((o) => !o)}
            aria-expanded={cfgOpen}
            className="microlabel flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-muted-foreground transition-colors hover:text-foreground"
          >
            <Settings size={13} /> {t('configurationTitle')}
            <ChevronDown size={13} className={cn('ml-auto transition-transform', cfgOpen ? '' : '-rotate-90')} />
          </button>
          {cfgOpen && <div className="max-h-[45vh] overflow-auto px-3 pb-3">{configSlot}</div>}
        </div>
      )}
    </div>
  );
}

// Active thread's working memory (folded in from the Memory view).
function WorkingMemoryPanel({ id }: { id: string }) {
  const { t } = useTranslation('playground');
  const wm = useWorkingMemory(id);
  const value = (wm.data as any)?.value ?? wm.data;
  return (
    <div className="border-b border-border bg-muted/20 px-4 py-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Working Memory</div>
      {wm.isLoading ? <Spinner /> : value != null && value !== '' ? <JsonBlock value={value} max={600} /> : <div className="text-xs text-muted-foreground">{t('emptyDot')}</div>}
    </div>
  );
}

function EditRow({ value, onChange, onSave, onCancel }: { value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  const { t } = useTranslation('playground');
  return (
    <div className="flex justify-end">
      <div className="flex w-[80%] flex-col gap-1.5">
        <textarea
          autoFocus
          aria-label={t('editMessageAriaLabel')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave(); else if (e.key === 'Escape') onCancel(); }}
          rows={2}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex justify-end gap-1.5">
          <Btn variant="ghost" size="xs" onClick={onCancel}>{t('cancel')}</Btn>
          <Btn size="xs" onClick={onSave}>{t('saveAndSendButton')}</Btn>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text, isUser }: { text: string; isUser: boolean }) {
  const { t } = useTranslation('playground');
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={t('copyTitle')}
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch((e) => toast.error(errMessage(e))); }}
      className={cn(
        'absolute -top-2 rounded border border-border bg-background p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100',
        isUser ? '-left-2' : '-right-2',
      )}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function MsgBlock({ msg, canEdit, onEdit, streaming }: { msg: Msg; canEdit?: boolean; onEdit?: () => void; streaming?: boolean }) {
  const { t } = useTranslation('playground');
  if (msg.role === 'tool') {
    // "Running" if the result hasn't arrived yet — lime pulse + text (color+text double-coding), neutralizes once the result is in.
    const running = msg.output === undefined;
    return (
      <div className={cn('rounded-md border p-2.5', running ? 'border-brand/40 bg-brand/5' : 'border-border bg-muted/30')}>
        <div className="mb-1 flex items-center gap-1.5 text-xs">
          <Wrench size={13} className={running ? 'text-brand' : 'text-muted-foreground'} />
          <span className="font-mono font-medium">{msg.name}</span>
          {/* Tool = green (the exact same model=lime/tool=green mapping as Inspector/Trace). */}
          <Badge tone="success">tool</Badge>
          {running && (
            <span className="ml-auto flex items-center gap-1.5 text-brand">
              <span className="record-dot record-dot--live" aria-hidden />
              <span className="microlabel">{t('runningLabel')}</span>
            </span>
          )}
        </div>
        <JsonBlock value={{ input: msg.input, output: msg.output }} max={500} />
      </div>
    );
  }
  const isUser = msg.role === 'user';
  return (
    <div className={`group flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={cn(
        'relative max-w-[80%] rounded-lg px-3 py-2 text-sm',
        isUser ? 'whitespace-pre-wrap bg-primary text-primary-foreground' : 'border-l-2 border-success/40 bg-muted',
      )}>
        {msg.role === 'user' && msg.files && msg.files.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {msg.files.map((f, i) => f.type.startsWith('image/')
              ? <img key={i} src={f.dataUrl} alt={f.name} className="max-h-32 rounded border border-primary-foreground/20" />
              : <span key={i} className="inline-flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[11px]"><FileText size={11} /> {f.name}</span>)}
          </div>
        )}
        {isUser ? msg.text : <Markdown text={msg.text} />}
        {streaming && (
          <span className="ml-1 inline-flex translate-y-[-1px] items-center align-middle">
            <span className="record-dot record-dot--live" aria-hidden />
            <span className="sr-only">{t('respondingSrOnly')}</span>
          </span>
        )}
        {msg.text && <CopyButton text={msg.text} isUser={isUser} />}
        {canEdit && onEdit && (
          <button type="button" title={t('editAndResendTitle')} onClick={onEdit}
            className="absolute -bottom-2 -left-2 rounded border border-border bg-background p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100">
            <Pencil size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalCards({ interrupts, busy, onDecide }: { interrupts: Interrupt[]; busy: boolean; onDecide: (a: Record<string, boolean>) => void }) {
  const { t } = useTranslation('playground');
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
      <div className="mb-2 text-xs font-medium text-warning">{t('pendingApprovalTool', { count: interrupts.length })}</div>
      <div className="space-y-1.5">
        {interrupts.map((it) => (
          <div key={it.toolCallId} className="flex items-center justify-between gap-2 rounded bg-background/60 px-2 py-1.5">
            <div className="min-w-0">
              <span className="font-mono text-xs">{it.toolName}</span>
              {it.reason && <span className="ml-2 text-[11px] text-muted-foreground">{it.reason}</span>}
            </div>
            <div className="flex gap-1.5">
              <Btn variant="ok" size="xs" disabled={busy} onClick={() => onDecide({ [it.toolCallId]: true })}><Check size={13} /> {t('approveButton')}</Btn>
              <Btn variant="deny" size="xs" disabled={busy} onClick={() => onDecide({ [it.toolCallId]: false })}><X size={13} /> {t('rejectButton')}</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
