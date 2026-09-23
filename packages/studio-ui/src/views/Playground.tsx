import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, X, Wrench, Plus, Trash2, Pencil, Ban, Copy, Database, Activity, RotateCw, ArrowDown, Settings, Paperclip, FileText, PanelLeft, ChevronDown, MessageSquare } from 'lucide-react';
import { useAgents, useCapabilities, useModelProviders, useMe, useThreads, useWorkingMemory, streamAgent, api, errMessage, ApiError, type Interrupt, type ThreadRecord, type AgentRunBody, type RunCost } from '../api';
import { Btn, Spinner, Empty, EmptyState, ErrorBox, Badge, JsonBlock, cn } from '../components';
import { Markdown } from '../markdown';
import { Stagger, StaggerItem, Reveal } from '../motion';
import { toast, ConfirmDialog } from '../ui';
import { currentLocale } from '../i18n/locale';
import { readLocalJson, writeLocal } from '../storage';

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

// PURE function (testable): write a tool's outcome onto the message it belongs to. Shared by
// tool-result and tool-error so the LIVE transcript ends up in the same shape mapMessages produces
// when the thread is reloaded from the journal — MsgBlock reads "still running" as
// `output === undefined`, so a failed tool has to land an output in both paths or it pulses forever.
//
// Replaces the element instead of assigning through it. The old `(copy[i] as any).output = …`
// mutated the very object still held by the previous state, so the message's identity never
// changed — harmless while nothing is memoized, and a silent stale render the moment something is.
export function applyToolOutcome(msgs: Msg[], toolCallId: string | undefined, output: unknown): Msg[] {
  const i = matchToolResult(msgs, toolCallId);
  if (i < 0) return msgs;
  const copy = [...msgs];
  copy[i] = { ...(copy[i] as Extract<Msg, { role: 'tool' }>), output };
  return copy;
}

/** What the agent is doing at this instant. `null` = idle. */
export type Activity =
  /** Request is open but the model has produced nothing yet — the state a long turn sits in. */
  | { kind: 'waiting' }
  /** Between reasoning-start and reasoning-end: the model is thinking, not writing. */
  | { kind: 'reasoning' }
  /** Between tool-input-start and tool-call: the model is composing the arguments. */
  | { kind: 'tool-input'; name?: string }
  /** Between tool-call and its result: OUR code is executing, the model is idle. */
  | { kind: 'tool-run'; name: string }
  /** text-delta is flowing — the answer is being written. */
  | { kind: 'writing' }
  | null;

// PURE function (testable): fold one stream event into the current activity. Returns `undefined`
// when the event says nothing about what is happening now, so the caller can leave the state alone
// instead of flickering through a spurious update.
//
// The distinction that matters to a waiting user is reasoning vs tool-run: "thinking" is the model
// burning time, "running X" is our tool doing so. Those have completely different expected
// durations and completely different things to do about them, and until now both looked identical —
// a greyed-out button.
export function activityFromEvent(type: string, data?: unknown): Activity | undefined {
  const toolName = (data as { toolName?: string } | undefined)?.toolName;
  switch (type) {
    // A new step of the agent loop begins: the model is called again and has said nothing yet.
    case 'step-start': return { kind: 'waiting' };
    case 'reasoning-start': return { kind: 'reasoning' };
    // Thinking is over; the model will now either write or call a tool, and we don't know which yet.
    case 'reasoning-end': return { kind: 'waiting' };
    case 'tool-input-start': return { kind: 'tool-input', name: toolName };
    case 'tool-call': return { kind: 'tool-run', name: toolName ?? '' };
    // The tool answered (or failed) — control is back with the model.
    case 'tool-result': case 'tool-error': return { kind: 'waiting' };
    case 'text-delta': return { kind: 'writing' };
    default: return undefined;
  }
}

// PURE function (testable): "8s", "1:07". Seconds up to a minute, then m:ss — long enough to be
// reassuring, short enough not to look like a countdown.
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

// Model suggestions: a DEFAULT set, extended by the server (see useModelProviders).
//
// These twelve stay here as the offline baseline — the box must be useful before any request lands.
// Everything else comes from the deployment: ids the host configured, ids it has priced in the
// journal, and every prefix the router understands. Providers ship models weekly, so a list that
// lives only in this bundle is one that needs a gnl release to mention a model that came out this
// morning; that is exactly the trap DEFAULT_PRICING was in.
//
// The list used to be these twelve strings and nothing else, so a deployment wired to an
// OpenAI-compatible endpoint registered `nvidia/` with the router and then found no trace of it in the
// box where a model is typed — the same "the agent's model reads as custom and no string reproduces
// it" symptom that registerModelProvider was added to fix, one layer up. A registered prefix now shows
// as `nvidia/`, which is a start rather than a full id: the router knows the prefix, only the host
// knows which ids are valid behind it.
//
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
  return readLocalJson(OV_KEY, {});
})();

// Shared by mapMessages and userMessageServerIndex (FLOW-10): extracts a user message's text the
// SAME way in both places, so the server-index lookup lines up with what mapMessages would have
// rendered as a user bubble (a user entry with no text is skipped by mapMessages, and must be
// skipped here too, or the ordinal count would drift).
/**
 * Attachments carried by a SERVER user entry, back into the local `Attachment` shape.
 *
 * `mapMessages` only ever read text parts, so a turn's files vanished on reload — and a turn that
 * was ONLY files (legal: `send()` proceeds when the prompt is empty but attachments exist) produced
 * no local message at all. Measured: an invoice image and its answer became a lone assistant bubble
 * saying "The invoice total is 4,812." with no visible question above it.
 *
 * The server writes these as AI SDK parts (see the `msgBody` builder): `{type:'image', image}` for
 * images, `{type:'file', data, mediaType}` for the rest — both hold a data URL. The file NAME is not
 * persisted, so it cannot be recovered; the media type can, and a placeholder name is honest about
 * what is known rather than inventing one.
 */
function extractUserFiles(m: any): { name: string; type: string; dataUrl: string }[] {
  if (!Array.isArray(m?.content)) return [];
  const out: { name: string; type: string; dataUrl: string }[] = [];
  for (const p of m.content) {
    if (p?.type === 'image' && typeof p.image === 'string') out.push({ name: 'image', type: 'image/*', dataUrl: p.image });
    else if (p?.type === 'file' && typeof p.data === 'string') out.push({ name: 'file', type: String(p.mediaType ?? 'application/octet-stream'), dataUrl: p.data });
  }
  return out;
}

/** A user turn CARRIES something — text, or attachments. The two sides of the FLOW-10 ordinal must
 *  agree on this predicate or they count different turns. */
function userTurnHasContent(m: any): boolean {
  return !!extractUserText(m) || extractUserFiles(m).length > 0;
}

function extractUserText(m: any): string {
  return typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text' && p.text).map((p: any) => p.text).join(' ')
    : (m.text ?? '');
}

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
      const text = extractUserText(m);
      const files = extractUserFiles(m);
      if (text || files.length) out.push({ role: 'user', text, ...(files.length ? { files } : {}) });
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

// FLOW-10 — PURE functions (testable): translate a LOCAL `msgs` index (edit/regenerate target) into
// the matching index on the SERVER's GET /threads/:id/messages array, so DELETE
// /threads/:id/messages can truncate the persisted thread, not just the local view.
//
// `msgs` and the server array are NOT 1:1: mapMessages fans a single assistant server entry out into
// several local Msg entries (interleaved text/tool-call blocks), and a role:'tool' server entry
// merges into an EXISTING tool Msg's `output` rather than adding one. A user server entry, however,
// ALWAYS maps to exactly 0 or 1 local Msg (0 only when its text is empty — which can't happen here,
// since both submitEdit and regenerate only ever target a non-empty user turn). So instead of
// tracking per-Msg source indices through both the history-load path AND every live-append call site
// (send/streamAgent callbacks/decide), we anchor on a stable, cheap-to-compute quantity both sides
// agree on: "this is the Nth user turn in the conversation" — that ordinal is the same on the local
// `msgs` array and on the freshly-fetched server array, because every user turn sent through this UI
// is exactly the one persisted server-side (edit/regenerate are both `!busy`-gated, so by the time
// either runs, every prior turn has already finished streaming and been persisted).

/** 0-based ordinal of the user message at local `msgs` index `i` among all user messages in `msgs`
 *  up to and including `i` (i.e. "this is the Nth user turn"). `msgs[i]` must be a user message. */
export function userOrdinalAt(msgs: Msg[], i: number): number {
  let n = -1;
  for (let k = 0; k <= i && k < msgs.length; k++) if (msgs[k].role === 'user') n++;
  return n;
}

/** The SERVER array index (matching GET /threads/:id/messages' order) of the `ordinal`-th (0-based)
 *  user turn with non-empty text — mirrors mapMessages' user branch exactly via extractUserText, so
 *  the result lines up with the ordinal computed by userOrdinalAt. Returns -1 when there's no such
 *  turn (out of range / the two sides couldn't be lined up) — callers must treat that as "can't
 *  safely truncate", not guess an index. */
export function userMessageServerIndex(data: any[], ordinal: number): number {
  let n = -1;
  for (let idx = 0; idx < (data?.length ?? 0); idx++) {
    const m = data[idx];
    const role = m.role ?? m.__source;
    if (role !== 'user') continue;
    // Same predicate `mapMessages` uses — an attachment-only turn is a turn on BOTH sides. When this
    // said "has text" while mapMessages pushed on "has text or files", an earlier attachment-only
    // turn shifted every later ordinal and this returned -1: the caller warned and refused to
    // truncate (honest, and it stayed honest), but edit/regenerate quietly stopped working for the
    // rest of the session. The FLOW-10 comment justified the alignment with "0 only when its text is
    // empty — which can't happen here"; it can, which is why the predicate is now shared.
    if (!userTurnHasContent(m)) continue;
    n++;
    if (n === ordinal) return idx;
  }
  return -1;
}

// Relative time label (for the thread row). `t` is passed in by the caller (HistorySidebar).
function relTime(ts: number | undefined, t: TFunction): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('justNow');
  const m = Math.floor(s / 60); if (m < 60) return t('minutesAgo', { count: m });
  const h = Math.floor(m / 60); if (h < 24) return t('hoursAgo', { count: h });
  const d = Math.floor(h / 24); if (d < 7) return t('daysAgo', { count: d });
  return new Date(ts).toLocaleDateString(currentLocale());
}

export function Playground() {
  const { t } = useTranslation('playground');
  const STARTERS = t('starters', { returnObjects: true }) as string[];
  const caps = useCapabilities();
  const providers = useModelProviders();
  // Built-in ids first (a complete, typable suggestion), then every prefix the router knows that none
  // of them covers — so a host provider appears without pretending to know its model ids.
  const modelOptions = useMemo(() => {
    const known = providers.data?.providers ?? [];
    const fromServer = providers.data?.models ?? [];
    // A prefix with no id behind it is still worth offering: the router knows `nvidia/` is routable,
    // only the host knows which ids are valid there. Skipped when something already starts with it,
    // so a real id is never displaced by a bare prefix.
    const all = [...MODEL_SUGGESTIONS, ...fromServer];
    const prefixes = known.filter((p: string) => !all.some((m) => m.startsWith(`${p}/`))).map((p: string) => `${p}/`);
    return [...new Set([...all, ...prefixes])];
  }, [providers.data]);
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
  // What the run is doing RIGHT NOW, and since when. `busy` alone only ever said "a request is open",
  // which is why a long turn was indistinguishable from a hung one: the send button greyed out and
  // nothing else moved. The server already streams the answer — reasoning-*, tool-input-*, tool-call,
  // step-* — the UI just dropped every one of those events on the floor. See `activityFromEvent`.
  const [activity, setActivity] = useState<Activity>(null);
  const [step, setStep] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
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
    writeLocal(OV_KEY, JSON.stringify({ modelOv, systemOv, tempOn, tempOv, topPOn, topPOv }));
  }, [modelOv, systemOv, tempOn, tempOv, topPOn, topPOv]);
  const runIdRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A11Y-07: the ⚙ settings popover's trigger — Escape needs to return focus to it on close.
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (!agent && agents.data?.[0]) setAgent(agents.data[0].name); }, [agents.data, agent]);
  // Smart auto-scroll: only follow while the user is pinned to the bottom.
  useEffect(() => { if (pinned) scrollTranscriptToBottom(); }, [msgs, pending, pinned]);
  // Unmount cleanup: abort any in-flight stream when navigating away (e.g. to Inspector) so it
  // doesn't keep burning tokens invisibly — same pattern as Workflows.tsx.
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  // A11Y-07: the settings popover had no keyboard way to close (only re-clicking ⚙, or clicking the
  // aria-hidden backdrop — unreachable from the keyboard). Escape closes it and returns focus to the
  // trigger, same as any other non-modal popover.
  useEffect(() => {
    if (!showSettings) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setShowSettings(false); settingsBtnRef.current?.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showSettings]);

  // D3-9: this is a whole-canvas configuration state (the host turned the capability off), not an
  // inline note inside an otherwise-populated view — EmptyState is the primitive for that (icon +
  // title + description), matching Cache/Evals/Mcp/Jobs/Networks/Audit/Approvals/Workflows. Icon is
  // Playground's own nav icon (see NAV_GROUPS in App.tsx) so it reads as "this exact feature", not a generic blank.
  if (caps.data && !caps.data.playground) return <EmptyState icon={MessageSquare} title={t('playgroundDisabledTitle')} description={t('playgroundDisabledDescription')} />;
  if (agents.isLoading) return <Spinner />;
  if (agents.error) return <ErrorBox error={agents.error} />;

  const canStream = !!caps.data?.stream;
  const currentMeta = agents.data?.find((a) => a.name === agent);

  function onScroll() {
    const el = scrollRef.current; if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }
  // Scroll ONLY the transcript box. `endRef.scrollIntoView()` used to do this, but scrollIntoView walks
  // the WHOLE ancestor chain and scrolls every scrollable ancestor it finds — which is how a stray 1px
  // out-of-flow element (see the `relative` note on the scroll box) turned into a fully blank chat area.
  // Driving scrollTop directly can only ever move this one element, whatever the surrounding layout does.
  function scrollTranscriptToBottom() {
    const el = scrollRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }
  function scrollToBottom() { setPinned(true); scrollTranscriptToBottom(); }

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
    // 'waiting' from the very first millisecond, before any event arrives. That gap — request sent,
    // model not yet answering — is precisely the one that used to look like a frozen screen, and on
    // a slow model it is the longest part of the turn.
    setActivity({ kind: 'waiting' });
    setStep(0);
    setStartedAt(Date.now());
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
    // No thread when there is no memory to put it in. `runDurable` gates every memory read and write on
    // `memory && threadId`, so the `threadId: runId` this used to send when memory was OFF reached
    // nothing — dead weight, until it started costing something: the server now refuses a named thread
    // whose store has no organization boundary, so an org-bound admin sent an inert threadId and got a
    // 403 on the whole run. Not the thread list: the Playground itself, for every prompt.
    const body: AgentRunBody = memoryOn
      ? { runId, threadId: tid, resourceId, ...msgBody, ...overrides }
      : { runId, ...msgBody, ...overrides };
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (canStream) {
        await streamAgent(agent, body, (ev) => {
          // Every event first updates "what is happening now". Events that say nothing about it
          // (interrupt, done, source, …) return undefined and leave the indicator untouched.
          const next = activityFromEvent(ev.type, ev.data);
          if (next !== undefined) setActivity(next);
          if (ev.type === 'step-start') setStep((n) => n + 1);

          if (ev.type === 'text-delta') pushAssistantDelta(ev.data.text);
          else if (ev.type === 'tool-call') setMsgs((m) => [...m, { role: 'tool', name: ev.data.toolName, input: ev.data.input, toolCallId: ev.data.toolCallId }]);
          else if (ev.type === 'tool-result') setMsgs((m) => applyToolOutcome(m, ev.data.toolCallId, ev.data.output));
          // A failing tool used to be dropped here entirely — the event had no case, and the client
          // type did not even declare it. MsgBlock derives "running" from `output === undefined`, so
          // that tool card pulsed "running" FOREVER: the run had long since moved on and the UI
          // still claimed work was in flight. {error} is the same shape mapMessages writes for a
          // 'tool-error' part, so live and reloaded transcripts now agree.
          else if (ev.type === 'tool-error') setMsgs((m) => applyToolOutcome(m, ev.data.toolCallId, { error: ev.data.error }));
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
      setActivity(null);
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

  // FLOW-10: truncates the SERVER-side thread to match a local edit/regenerate, so the next run
  // doesn't see both the abandoned turn AND the corrected one. `i` is the LOCAL msgs index of the
  // user message being replaced/re-run — translated to a server array index via the ordinal anchor
  // described above userOrdinalAt. MUST be called (and awaited) BEFORE runPrompt appends the new
  // turn: computing the ordinal→index mapping from data that already includes the new turn would
  // resolve to the same server index, and afterIndex = srcIdx - 1 would then also wipe out the turn
  // we just ran.
  async function truncateServerThread(i: number) {
    if (!caps.data?.memory || !thread) return;
    try {
      const ordinal = userOrdinalAt(msgs, i);
      const data = await api.messages(thread);
      const srcIdx = userMessageServerIndex(data, ordinal);
      if (srcIdx < 0) { warnStaleServerHistory(); return; } // couldn't line the turn up — be honest instead of guessing
      await api.truncateThreadMessages(thread, srcIdx - 1);
      // success → the server thread now matches the local trim, no "stale history" warning needed.
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) { warnStaleServerHistory(); return; } // adapter doesn't support truncateMessages → old behavior
      toast.error(errMessage(e)); // any other error: inform, but don't block the run
    }
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
    await truncateServerThread(lastUser);
    setMsgs((m) => m.slice(0, lastUser + 1));
    await runPrompt(u.text, atts);
  }

  // Edit & resend a user message: drop everything after that point, run with the new text.
  async function submitEdit(i: number) {
    const p = editVal.trim();
    setEditing(null);
    if (!p || busy) return;
    const u = msgs[i] as Extract<Msg, { role: 'user' }>;
    const atts = u.files ?? [];
    await truncateServerThread(i);
    setMsgs((m) => [...m.slice(0, i), { role: 'user', text: p, files: atts.length ? atts : undefined }]);
    await runPrompt(p, atts);
  }

  // Fallback for FLOW-10's truncateServerThread: the host's memory adapter doesn't implement
  // truncateMessages (DELETE /threads/:id/messages → 501), or the local edit/regenerate target
  // couldn't be safely lined up with a server index. Either way, the LOCAL trim above still happens,
  // but the server-side thread history still contains the old turn, and it reappears once the page is
  // reloaded and restored via loadThread — so we surface this explicitly rather than pretending it worked.
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
    // Re-pin: `pinned` tracks how far the user had scrolled in the PREVIOUS conversation. Left at
    // false, a freshly opened thread would render parked at its oldest message with the "scroll to
    // bottom" affordance already showing. A conversation always opens on its newest turn.
    setPinned(true);
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
  // FORM-08: the composer (input + attachments) is NOT part of that "fresh conversation" decision — a user
  // who wrote a long prompt and then reconsiders which agent to send it to must not lose it, so this keeps it.
  function changeAgent(name: string) {
    if (name === agent) return;
    setAgent(name);
    setToolsOff(new Set());
    newConversation(true);
  }

  // Clean chat: the next send creates a new thread. `keepComposer` (FORM-08) preserves the in-progress
  // input/attachments across the reset — used by changeAgent and the "New chat" button, where the reset is
  // about the conversation/thread, not about whatever the user was in the middle of typing. Other callers
  // (e.g. a deleted active thread) keep the full reset, including the composer.
  function newConversation(keepComposer = false) {
    runIdRef.current = '';
    setThread('');
    setMsgs([]);
    setPending([]);
    setError(null);
    setCost(null);
    setLastRunId('');
    if (!keepComposer) { setInput(''); setFiles([]); }
    setEditing(null);
    setEditVal('');
    setPinned(true); // empty transcript → the next reply must be followed (see loadThread)
  }

  // Configuration fields (agent · model · temperature · top-p · system · tools) — rendered in BOTH the
  // persistent desktop left panel and the mobile Settings dropdown (single source, closes over state).
  const configFields = (
    <div className="space-y-4">
      <div>
        <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgAgent')}</label>
        <select aria-label="Agent" value={agent} disabled={busy} onChange={(e) => changeAgent(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none disabled:opacity-50">
          {agents.data?.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
        </select>
      </div>
      <div>
        <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgModel')}</label>
        <input aria-label={t('cfgModel')} value={modelOv} onChange={(e) => setModelOv(e.target.value)} list="pg-models"
          placeholder={typeof currentMeta?.model === 'string' && currentMeta.model ? currentMeta.model : t('agentDefaultPlaceholder')}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm outline-none" />
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
          className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none" />
      </div>
      {currentMeta?.tools && currentMeta.tools.length > 0 && (
        <div>
          <label className="microlabel mb-1.5 block text-muted-foreground">{t('cfgTools')}</label>
          <div className="space-y-0.5">
            {currentMeta.tools.map((tool) => {
              const on = !toolsOff.has(tool.name);
              return (
                <button key={tool.name} type="button" title={tool.description} role="switch" aria-checked={on}
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
          onNew={() => { setMobileHistoryOpen(false); newConversation(true); }}
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
              {/* A plain <button> here, not <Btn> (which doesn't forward refs or accept aria-* props) —
                  classes match Btn's ghost/xs recipe exactly so this stays visually identical. */}
              <button
                ref={settingsBtnRef}
                type="button"
                aria-expanded={showSettings}
                aria-haspopup="dialog"
                onClick={() => setShowSettings((s) => !s)}
                title={t('configurationTitle')}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Settings size={14} /> {t('settingsButton')}
              </button>
              {showSettings && (
                <>
                  {/* Click-away backdrop (transparent) — closes the popover; sits under it, over everything else. */}
                  <div className="fixed inset-0 z-20" onClick={() => setShowSettings(false)} aria-hidden />
                  <div role="dialog" aria-label={t('configurationTitle')} className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-auto rounded-md border border-border bg-background p-4 shadow-lg">
                    <div className="microlabel mb-3 text-foreground">{t('configurationTitle')}</div>
                    {configFields}
                  </div>
                </>
              )}
            </div>
          )}
          {/* Live stream: pulse only while busy+streaming — double-coded with the "streaming" text (WCAG 1.4.1).
              record-dot, not live-dot: this isn't a badge's enduring state pill (there's no colored chip
              here), it's the same "content is actively flowing into the journal right now" signal as the
              streaming cursor (MsgBlock) / tool-running marker / ActivityRow below — same plain
              dot+label shape as those three, so it takes the same square mark for consistency. */}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground md:ml-auto">
            {busy && canStream && <span className="record-dot record-dot--live" aria-hidden />}
            {/* Guarded per field, not by `cost ?` alone: a /cost response missing costUsd made this
                `undefined.toFixed(4)` and unmounted the ENTIRE Playground — the whole transcript
                replaced by an error boundary because a token counter came back short. A cosmetic
                readout must never be able to do that; each half now renders only if it has a number. */}
            {canStream ? 'streaming' : 'sync'}
            {typeof cost?.totalTokens === 'number' ? ` · ${cost.totalTokens} tok` : ''}
            {typeof cost?.costUsd === 'number' ? ` · $${cost.costUsd.toFixed(4)}` : ''}
          </span>
          {msgs.some((m) => m.role === 'user') && !busy && <Btn variant="ghost" size="xs" onClick={regenerate}><RotateCw size={14} /> {t('regenerateButton')}</Btn>}
          {caps.data?.memory && thread && <Btn variant="ghost" size="xs" onClick={() => setShowWm((s) => !s)}><Database size={14} /> {t('memoryButton')}</Btn>}
          {lastRunId && (
            <Link to={`/inspector?run=${encodeURIComponent(lastRunId)}`} title={t('inspectLinkTitle')} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Activity size={14} /> {t('inspectButton')}
            </Link>
          )}
          {busy && canStream && <Btn variant="ghost" size="xs" onClick={() => abortRef.current?.abort()}><Ban size={14} /> {t('stopButton')}</Btn>}
          {!caps.data?.memory && <Btn variant="ghost" size="xs" onClick={newConversation}>{t('clearButton')}</Btn>}
        </div>

        <datalist id="pg-models">{modelOptions.map((m: string) => <option key={m} value={m} />)}</datalist>
        {showWm && thread && <WorkingMemoryPanel id={thread} />}

        <div className="relative flex-1 overflow-hidden">
          {/* `relative` on the SCROLL BOX is load-bearing, not decoration — do not drop it.
              An absolutely positioned descendant is sized/clipped by its CONTAINING BLOCK, and it
              contributes to THAT block's scrollable overflow — an `overflow:auto` ancestor in between
              does not clip it unless it is itself the containing block. The `.sr-only` live region
              below is `position:absolute`; with this box left `static`, its containing block was the
              outer `relative … overflow-hidden` wrapper, and because its static position sits at the
              very END of the transcript it inflated THAT wrapper's scrollHeight to the full transcript
              height (measured: 4438px against a 572px clientHeight). `overflow:hidden` still scrolls
              programmatically, so the auto-scroll below then scrolled the wrapper itself and shifted
              this entire 572px box up out of view (measured: getBoundingClientRect().top = -454px) —
              the "chat area is blank except for a clipped fragment at the top" bug. Making the scroll
              box positioned keeps every absolute descendant contained AND clipped by it. */}
          <div ref={scrollRef} onScroll={onScroll} className="relative h-full space-y-2 overflow-auto p-4">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <Empty>{t('emptyPrompt')}</Empty>
                <Stagger className="flex flex-wrap gap-1.5 px-6">
                  {STARTERS.map((s) => (
                    <StaggerItem key={s}>
                      <button type="button" onClick={() => send(s)} disabled={!agent || busy}
                        className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors enabled:hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed">{s}</button>
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            )}
            {/* The transcript is a PLAIN container on purpose — do NOT wrap it in <Stagger>/<StaggerItem>.
                Stagger's variant orchestration ("hidden" → "show") only reaches children when the PARENT's
                animate state CHANGES, which happens exactly once: at mount. This list mounts EMPTY (`msgs`
                starts as []), so every message appended afterwards — stream delta, thread load, regenerate,
                edit&resend — mounted as a late child and stayed on the `hidden` variant forever
                (opacity: 0; translateY(6px)): invisible, yet still occupying its full height. That is the
                "messages vanished, huge blank area below, scroll position acts as if content were there" bug.
                A chat transcript must never depend on an entrance animation firing in order to be readable.
                (The starters block above keeps Stagger — it mounts together with its children, so it's safe.) */}
            <div className="space-y-2">
              {msgs.map((m, i) => (
                editing === i && m.role === 'user'
                  ? <EditRow key={i} value={editVal} onChange={setEditVal} onSave={() => submitEdit(i)} onCancel={() => setEditing(null)} />
                  : (
                    <MsgBlock
                      key={i}
                      msg={m}
                      canEdit={m.role === 'user' && !busy}
                      onEdit={() => { setEditing(i); setEditVal((m as Extract<Msg, { role: 'user' }>).text); }}
                      streaming={busy && i === msgs.length - 1 && m.role === 'assistant'}
                    />
                  )
              ))}
            </div>
            {/* Suppressed while the answer is being written: the streaming cursor on the assistant
                bubble already says that, and a "Writing…" line under visibly appearing text is noise.
                Every other phase produces NOTHING on screen, which is the whole problem this solves. */}
            {busy && activity?.kind !== 'writing' && (
              <ActivityRow activity={activity} step={step} startedAt={startedAt} />
            )}
            {/* Live region: a SHORT status summary for screen-reader users (busy/pending-approval/complete) —
                NOT per-delta text (that would flood the screen reader with every streamed token). */}
            <div aria-live="polite" aria-atomic="true" className="sr-only">
              {pending.length > 0
                ? t('pendingApprovalTool', { count: pending.length })
                : busy
                ? t('respondingSrOnly')
                : cost
                ? t('responseCompleteSrOnly', { tokens: cost.totalTokens, cost: cost.costUsd.toFixed(4) })
                : ''}
            </div>
            {pending.length > 0 && (
              <Reveal>
                <ApprovalCards interrupts={pending} busy={busy} onDecide={decide} />
              </Reveal>
            )}
            {error && (
              <div role="alert">
                <Reveal className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <span className="min-w-0 break-words">⚠ {error}</span>
                  {msgs.some((m) => m.role === 'user') && <Btn variant="ghost" size="xs" onClick={regenerate}><RotateCw size={13} /> {t('retryButton')}</Btn>}
                </Reveal>
              </div>
            )}
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
                  {f.type.startsWith('image/') ? <img src={f.dataUrl} alt={f.name} className="h-6 w-6 rounded-sm object-cover" /> : <FileText size={13} className="text-muted-foreground" />}
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
            {/* Prompt-style input (GNL Input recipe): a static "›" prefix in the identity green, mono
                text, and the shared focus ring — carried by the WRAPPER (.field-ring), since the border
                is on the wrapper and not on the textarea. */}
            <div className="flex flex-1 items-start gap-1.5 rounded-md border border-input bg-background px-3 py-2 transition-colors field-ring">
              <span aria-hidden className="select-none pt-0.5 font-mono text-sm text-brand">›</span>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
                placeholder={t('messagePlaceholder')}
                rows={2}
                className="field-bare flex-1 resize-none bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Btn arrow onClick={() => send()} disabled={busy || !agent || (!input.trim() && files.length === 0)}>{t('sendButton')}</Btn>
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
   * Playground; this component just slots the node in). */
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
  // FORM-07: closing the rename row (Enter/Escape/✓/✕) removes the focused <input> from the DOM, which
  // fires a native blur on it — without this guard that blur would ALSO call onBlur's saveRename, double
  // submitting on Enter/✓ and, worse, silently overriding Escape/✕'s cancel with a save. Set right
  // before every one of those closes; onBlur checks it and, if set, skips the save-on-blur path once.
  const suppressRenameBlurRef = useRef(false);
  function closeRenaming(save: boolean, id: string) {
    suppressRenameBlurRef.current = true;
    if (save) saveRename(id); else setRenaming(null);
  }

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
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-sm transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
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
        ) : threads.error ? (
          <ErrorBox error={threads.error} />
        ) : !threads.data?.length ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">{t('noConversationsYet')}</div>
        ) : (
          threads.data.map((th) => {
            const active = activeId === th.id;
            if (renaming === th.id) {
              return (
                <div key={th.id} className="mb-0.5 flex items-center gap-1 px-1 py-0.5">
                  <input
                    autoFocus
                    aria-label={t('conversationNamePlaceholder')}
                    placeholder={t('conversationNamePlaceholder')}
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') closeRenaming(true, th.id); else if (e.key === 'Escape') closeRenaming(false, th.id); }}
                    // FORM-07: clicking away (a different thread row, outside the sidebar, …) now SAVES
                    // instead of silently discarding the typed title — saveRename is a no-op on an empty
                    // title. ✓/✕ below cover the discoverable, mouse-driven path (mirrors the delete flow).
                    onBlur={() => { if (suppressRenameBlurRef.current) { suppressRenameBlurRef.current = false; return; } saveRename(th.id); }}
                    className="w-full min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none"
                  />
                  <div className="flex items-center gap-0.5">
                    {/* onMouseDown preventDefault: keeps focus on the input through the click so onBlur's
                        save-on-blur path doesn't race this button's own (guarded) action. */}
                    <button type="button" title={t('rename')} onMouseDown={(e) => e.preventDefault()} onClick={() => closeRenaming(true, th.id)} disabled={working} className="rounded-sm p-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"><Check size={13} /></button>
                    <button type="button" title={t('cancel')} onMouseDown={(e) => e.preventDefault()} onClick={() => closeRenaming(false, th.id)} className="rounded-sm p-1 text-muted-foreground hover:bg-muted"><X size={13} /></button>
                  </div>
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
                {/* D5-7: deletion confirmation is the shared ConfirmDialog (below), not an inline
                    Check/X pair — this app has ONE interaction language for "permanently destroy
                    something", not two. */}
                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button type="button" title={t('rename')} onClick={() => { setRenaming(th.id); setRenameVal(th.title || ''); }} className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil size={13} /></button>
                  <button type="button" title={t('deleteThreadTitle')} onClick={() => setConfirmDel(th.id)} className="rounded-sm p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"><Trash2 size={13} /></button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {/* D5-7: shared destructive-confirm pattern (same ConfirmDialog Inspector's purge/unwind/cancel
          dialogs use) — deletion has no restore path (api.ts has no undelete/restore for threads), so
          the description says that explicitly, same wording as Inspector's purge dialog. */}
      <ConfirmDialog
        open={confirmDel != null}
        onOpenChange={(o) => { if (!o) setConfirmDel(null); }}
        title={t('deleteThreadDialogTitle', { name: threads.data?.find((x) => x.id === confirmDel)?.title || confirmDel || '' })}
        description={t('deleteThreadDialogDescription')}
        confirmLabel={t('deleteThreadConfirmLabel')}
        destructive
        onConfirm={() => { if (confirmDel) doDelete(confirmDel); }}
      />
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
      {wm.isLoading ? <Spinner /> : wm.error ? <ErrorBox error={wm.error} /> : value != null && value !== '' ? <JsonBlock value={value} max={600} /> : <div className="text-xs text-muted-foreground">{t('emptyDot')}</div>}
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
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
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
        'absolute -top-2 rounded-sm border border-border bg-background p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100',
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
        // VIS-07: user bubble is a TINT, not a full lime fill — a full-saturation `bg-primary` on every
        // turn of a long conversation buried the one control that should read as "primary action" (Send,
        // and Stop while streaming) in a wall of lime, and pending approval cards (border-warning/bg-warning)
        // got lost in it too. index.css's contract for lime is a sparse/high-impact accent, not a fill.
        isUser ? 'whitespace-pre-wrap border border-brand/40 bg-brand/10 text-foreground' : 'border-l-2 border-success/40 bg-muted',
      )}>
        {msg.role === 'user' && msg.files && msg.files.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {msg.files.map((f, i) => f.type.startsWith('image/')
              ? <img key={i} src={f.dataUrl} alt={f.name} className="max-h-32 rounded-sm border border-border" />
              : <span key={i} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"><FileText size={11} /> {f.name}</span>)}
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
            className="absolute -bottom-2 -left-2 rounded-sm border border-border bg-background p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100">
            <Pencil size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "What is happening right now", rendered where the next message will appear — the place the user is
 * already looking. Replaces inferring liveness from a greyed-out Send button.
 *
 * Mounted only while a run is open, so its 1s tick has no life outside that: the interval starts and
 * stops with the row instead of being a timer Playground has to remember to clear. The elapsed
 * counter is the load-bearing part — it keeps moving when the stream is silent, which is exactly the
 * stretch (model thinking before the first token) that used to be indistinguishable from a hang.
 */
function ActivityRow({ activity, step, startedAt }: { activity: Activity; step: number; startedAt: number }) {
  const { t } = useTranslation('playground');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!activity) return null;

  const label =
    activity.kind === 'reasoning' ? t('activityThinking')
    : activity.kind === 'tool-input' ? t('activityPreparingTool', { name: activity.name ?? t('activityToolFallback') })
    : activity.kind === 'tool-run' ? t('activityRunningTool', { name: activity.name || t('activityToolFallback') })
    : activity.kind === 'writing' ? t('activityWriting')
    : t('activityWaiting');

  return (
    <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
      <span className="record-dot record-dot--live" aria-hidden />
      <span className="text-foreground">{label}</span>
      <span className="ml-auto flex items-center gap-2 tabular-nums">
        {/* Only from the second step on: "step 1" on a single-step turn is noise. */}
        {step > 1 && <span className="microlabel">{t('activityStep', { n: step })}</span>}
        <span>{fmtElapsed(now - startedAt)}</span>
      </span>
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
          <div key={it.toolCallId} className="flex items-center justify-between gap-2 rounded-sm bg-background/60 px-2 py-1.5">
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
