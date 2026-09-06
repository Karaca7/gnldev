// FAZ-6 — semantik-farkındalıklı idempotency katmanı (anlamsal mükerrer-aday kapısı).
//
// WHAT THIS IS, stated with the discipline the heyet mandated: hash-based dedup is byte identity;
// This layer finds PAST side-effect work that looks similar IN MEANING ("create product ABC" said
// Two different ways) and — only when the DETERMINISTIC field comparison also matches — surfaces it
// As an approval question. The embedding is a CANDIDATE FINDER, never a decider:
//
//   exact-hash layers (1-4)  →  hit: replay, this file never runs
//   toolName hard filter     →  a different tool is never a candidate (cross-tool negation gate)
//   cosine over the THREAD's own records  →  candidates (recall only)
//   discriminator fields     →  differ: candidate DROPS (intra-tool negation gate)
//   identity fields (normalized equality) + amount fields (exact equality)  →  the DECISION
//   __gnl_suspend            →  the ONLY exit: a human answers, shown the first result
//
// Score alone NEVER suspends. Nothing here is ever told to the model (a model that "knows it was
// Done" may skip the call itself — indirect silent dedup; permanent rule). Numbers/amounts never
// Enter the embedded text. The canonical sentence is built ONLY from validated tool args (never the
// Thread's free text — the injection boundary). Data lives in the journal under the thread's own
// `xthr:<threadId>:` family, so ONE purgeThread sweep reclaims vectors, tombstones and markers
// Together; records survive RUN retention on purpose (yesterday's work must outlive its run's log).
// Best-effort and fail-open end to end: an unreachable embedder degrades to today's behavior — it
// Never blocks a tool result and never takes the layers below with it.
import type { Journal } from './journal.js';

/** Run-level half of the double opt-in (`limits.sideEffectDuplicates.semantic`). */
export interface SemanticDupConfig {
  /** SAME signature as @gnldev/memory's observational `embed` — one closure can serve both. The
   *  Caller owns the provider, the API key and the bill (a local model behind this closure keeps
   *  Data on the machine entirely — see the README recipe). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** REQUIRED stamp — vectors from different models are apples and oranges; a record whose stamp
   *  Differs is EXCLUDED from comparison (never silently compared) and reported once. */
  embedModelId: string;
  /** Candidate threshold (cosine), default 0.60 — deliberately generous: recall-side misses are the
   *  Safe direction (an unasked question), and the deterministic phase filters the rest. */
  minSimilarity?: number;
  /** How many best-scoring candidates enter the deterministic phase (default 3). */
  topK?: number;
}

/** Tool-level half of the double opt-in (`tool.semanticIdentity`). */
export interface SemanticIdentity {
  /** The business-identity arg fields (e.g. ['sku'], ['orderId']). REQUIRED and non-empty — the
   *  Quality of this declaration IS the quality of the protection (documented Achilles heel). */
  keys: string[];
  /** Canonical sentence override — THE PII redaction point: only this string ever reaches the
   *  Embedder. Default: `"<toolName>: <normalized key values>"`. Receives ONLY the args. */
  describe?: (args: unknown) => string;
  /** Magnitude gate: identity-equal candidates whose amounts differ suspend with an explicit
   *  "amounts differ" message instead of a plain duplicate question. Exact equality. */
  amountFields?: string[];
  /** Intra-tool negation gate (cancel/direction/type booleans+enums): a candidate whose
   *  Discriminator differs is DROPPED deterministically — no vector is asked about negation. */
  discriminatorFields?: string[];
}

/** Journal value at `xthr:<threadId>:sem-<toolName>-<argsHash>`. */
export interface SemDupRecord {
  v: 1;
  toolName: string;
  argsHash: string;
  embedModelId: string;
  templateVersion: string;
  /** The exact sentence that was embedded — kept so a future model swap CAN re-embed (v1 doesn't). */
  canonical: string;
  /** Float32Array → base64. Absent when the embedder failed at write time (fields still wrote —
   *  The deterministic half of the protection survives an embedder outage). */
  vecB64?: string;
  identity: Record<string, string>;
  amounts: Record<string, number>;
  discriminators: Record<string, string>;
  firstToolCallId: string;
  at: number;
}

export const SEM_TEMPLATE_VERSION = '1';

export const semKey = (threadId: string, toolName: string, argsHash: string): string =>
  `xthr:${threadId}:sem-${toolName}-${argsHash}`;
/** "These two are DIFFERENT jobs" — born when a human approves a semantic suspend; that pair is
 *  Never asked about again. Same xthr family: dies with the thread. */
export const semTombKey = (threadId: string, toolName: string, priorHash: string, newHash: string): string =>
  `xthr:${threadId}:semtomb-${toolName}-${priorHash}-${newHash}`;

/** Normalized equality for identity values: trim + NFKC + case-fold — 'ABC-1' vs 'abc-1' class
 *  Differences close deterministically instead of leaning on the probabilistic side. */
export const normalizeId = (v: unknown): string => String(v ?? '').trim().normalize('NFKC').toLowerCase();

export interface SemFields {
  identity: Record<string, string>;
  amounts: Record<string, number>;
  discriminators: Record<string, string>;
}

export function extractSemFields(id: SemanticIdentity, args: unknown): SemFields {
  const a = (args ?? {}) as Record<string, unknown>;
  const identity: Record<string, string> = {};
  for (const k of id.keys) identity[k] = normalizeId(a[k]);
  const amounts: Record<string, number> = {};
  for (const k of id.amountFields ?? []) {
    const n = Number(a[k]);
    // NaN is never stored: NaN !== NaN would flag two identically-amount-less calls as "amounts
    // Differ", and JSON backends silently turn NaN into null (store-dependent behavior). Absent on
    // Both sides = equal; absent on one side = differ — stated by construction.
    if (Number.isFinite(n)) amounts[k] = n;
  }
  const discriminators: Record<string, string> = {};
  for (const k of id.discriminatorFields ?? []) discriminators[k] = normalizeId(a[k]);
  return { identity, amounts, discriminators };
}

/** The embedded sentence. Default deliberately excludes amounts and discriminators (they are the
 *  DECISION layer's job) and everything not declared (nothing undeclared leaks to the provider). */
export function canonicalTextOf(id: SemanticIdentity, toolName: string, args: unknown, fields: SemFields): string {
  if (typeof id.describe === 'function') return String(id.describe(args));
  return `${toolName}: ${id.keys.map((k) => fields.identity[k]).join(' ')}`;
}

// ── config-time validation (THROW, not warn — a static contradiction must be impossible to ship) ──

export function validateSemanticConfig(raw: unknown): void {
  const cfg = raw as { action?: unknown; scope?: unknown; semantic?: Partial<SemanticDupConfig>; byClass?: Record<string, { action?: unknown; scope?: unknown }>; default?: { action?: unknown; scope?: unknown } } | null | undefined;
  const sem = cfg && typeof cfg === 'object' ? cfg.semantic : undefined;
  if (!sem) return;
  // SINIF-BAZLI form (K29): action/scope tek alan değil hücrelerdedir. Semantik yalnız SUSPEND
  // hücrelerine uygulanır (dupConfigOf) — o hücrelerin (ve default'un, suspend ise) scope'u 'thread'
  // olmalı; hiç suspend hücresi yoksa semantik ölü ağırlıktır ve LOUD reddedilir (sessiz-inert yasağı).
  if (cfg && typeof cfg === 'object' && 'byClass' in cfg && cfg.byClass) {
    const cells = [...Object.values(cfg.byClass), ...(cfg.default ? [cfg.default] : [])];
    const suspendCells = cells.filter((c) => c && c.action === 'suspend');
    if (suspendCells.length === 0) {
      throw new Error("@gnldev/durable: sideEffectDuplicates.semantic with byClass form requires at least one 'suspend' cell — the semantic gate's only exit is the human question; without a suspend cell it would be silently inert.");
    }
    for (const c of suspendCells) {
      if (c!.scope !== 'thread') {
        throw new Error("@gnldev/durable: byClass form — every 'suspend' cell that the semantic gate can apply to must declare scope: 'thread' (the layer answers \"was this done earlier IN THIS CONVERSATION\").");
      }
    }
    // embed/embedModelId kontrolleri aşağıda ortak yoldan devam eder.
  } else if (cfg!.action !== 'suspend') {
    throw new Error(
      "@gnldev/durable: sideEffectDuplicates.semantic requires action: 'suspend' — the ONLY exit of the semantic gate is the approval question; any other action would make it a silent (or blocking) decider.",
    );
  }
  const isByClass = !!(cfg && typeof cfg === 'object' && 'byClass' in cfg && cfg.byClass);
  if (!isByClass && cfg!.scope !== 'thread') {
    // Düz formun scope kontrolü — byClass formunda scope hücre hücre yukarıda doğrulandı.
    throw new Error(
      "@gnldev/durable: sideEffectDuplicates.semantic requires scope: 'thread' — the layer answers \"was this done earlier IN THIS CONVERSATION\"; no other scope is defined.",
    );
  }
  if ((sem as { embedStripped?: boolean }).embedStripped === true) return; // the frozen-limits round-trip: declaratively present, functionally inactive (see run.ts serializableLimits)
  if (typeof sem.embed !== 'function') {
    throw new Error('@gnldev/durable: sideEffectDuplicates.semantic.embed must be a (texts: string[]) => Promise<number[][]> closure.');
  }
  if (typeof sem.embedModelId !== 'string' || sem.embedModelId.length === 0) {
    throw new Error(
      '@gnldev/durable: sideEffectDuplicates.semantic.embedModelId is required — vectors from different models must never be compared, and the stamp is how records from a swapped model are excluded.',
    );
  }
}

export function assertSemanticIdentity(toolName: string, id: SemanticIdentity): void {
  if (!Array.isArray(id.keys) || id.keys.length === 0) {
    throw new Error(
      `@gnldev/durable: tool '${toolName}' declares semanticIdentity with EMPTY keys — the identity declaration IS the protection; an installed-but-inert gate is the false confidence this throw exists to prevent.`,
    );
  }
}

// ── vector plumbing ──

export function encodeVec(vec: number[]): string {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}
export function decodeVec(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Process-local embed cache: pure COST saving, never correctness — decisions read the journal, and a
// Restart losing this Map costs exactly one extra provider call. Keyed by model+hash so a model swap
// Can't serve stale vectors. LRU via Map insertion order, capped.
const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, Float32Array>();

// Embedder outage visibility: N consecutive failures → ONE operational incident per streak (a warn
// Log per call is how a protection stays silently absent for weeks).
const OUTAGE_STREAK = 3;
const embedFailStreaks = new Map<string, number>(); // per embedModelId — a healthy embedder's success must not reset a broken one's streak

export interface EmbedOutcome {
  vec?: Float32Array;
  failed: boolean;
  /** True exactly once per failure streak, at the OUTAGE_STREAK'th consecutive failure. */
  outage: boolean;
}

export async function embedCached(cfg: SemanticDupConfig, text: string): Promise<EmbedOutcome> {
  // K20: the cache key must identify the STORED CONTENT ITSELF — an args-derived hash collides
  // Across tools (createProduct/deleteProduct with the same args) and would serve one tool's
  // Canonical vector into the OTHER tool's permanent record. The canonical text is short; itself is the key.
  const k = `${cfg.embedModelId}:${SEM_TEMPLATE_VERSION}:${text}`;
  const hit = embedCache.get(k);
  if (hit) return { vec: hit, failed: false, outage: false };
  try {
    const [raw] = await cfg.embed([text]);
    if (!raw || raw.length === 0) throw new Error('embed returned an empty vector');
    const vec = new Float32Array(raw);
    embedCache.set(k, vec);
    if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value!);
    embedFailStreaks.set(cfg.embedModelId, 0);
    return { vec, failed: false, outage: false };
  } catch {
    const streak = (embedFailStreaks.get(cfg.embedModelId) ?? 0) + 1;
    embedFailStreaks.set(cfg.embedModelId, streak);
    return { vec: undefined, failed: true, outage: streak === OUTAGE_STREAK };
  }
}

// ── write side ──

export interface SemPlan {
  cfg: SemanticDupConfig;
  id: SemanticIdentity;
  threadId: string;
  toolName: string;
  argsHash: string;
  fields: SemFields;
  canonical: string;
}

/** Called from the success choke point. Fields write SYNCHRONOUSLY (cheap, deterministic half of the
 *  Protection); the vector is fail-open — an embed failure drops it, never the record, never the
 *  Tool result. Best-effort overall: a journal hiccup here loses one future question, nothing else. */
export async function writeSemRecord(journal: Journal, plan: SemPlan, firstToolCallId: string): Promise<EmbedOutcome> {
  const embedded = await embedCached(plan.cfg, plan.canonical);
  try {
    // First-wins stamps, same contract as the dup marker at the same choke point: a repeat's success
    // Never overwrites the original firstToolCallId/at (the future question must show the FIRST
    // Result's address, and `at` must not artificially extend a ttl window). A missing vector may be
    // Backfilled once the embedder recovers — that part is not identity, it is capability.
    const cur = await journal.get<SemDupRecord>(semKey(plan.threadId, plan.toolName, plan.argsHash)).catch(() => undefined);
    const rec: SemDupRecord = {
      v: 1,
      toolName: plan.toolName,
      argsHash: plan.argsHash,
      embedModelId: plan.cfg.embedModelId,
      templateVersion: SEM_TEMPLATE_VERSION,
      canonical: plan.canonical,
      ...(embedded.vec ? { vecB64: encodeVec(Array.from(embedded.vec)) } : {}),
      identity: plan.fields.identity,
      amounts: plan.fields.amounts,
      discriminators: plan.fields.discriminators,
      firstToolCallId: cur?.firstToolCallId ?? firstToolCallId,
      at: cur?.at ?? (journal.now ? await journal.now() : Date.now()),
    };
    if (cur?.vecB64 && !rec.vecB64) rec.vecB64 = cur.vecB64;
    await journal.put(semKey(plan.threadId, plan.toolName, plan.argsHash), rec);
  } catch {
    /* best-effort — the terminal record is authoritative and already written */
  }
  return embedded;
}

// ── read side ──

export type SemVerdict =
  | { kind: 'none'; embedFailed?: boolean; outage?: boolean; droppedIdentity?: number; droppedStamp?: number; noListKeys?: boolean }
  | { kind: 'suspend'; score: number; firstToolCallId: string; priorHash: string; priorCanonical: string; amountsDiffer: string[] };

/** The candidate scan. Everything probabilistic ends at "candidate"; everything that decides is
 *  Deterministic field equality. Returns 'none' loudly-typed rather than throwing — fail-open. */
export async function findSemanticCandidate(journal: Journal, plan: SemPlan, ttlMs?: number): Promise<SemVerdict> {
  // FAIL-OPEN AS A MECHANICAL BOUND, not a promise: every journal read below lives inside this one
  // Try — a single flaky get/now must degrade to 'none', never throw the TOOL CALL itself into
  // 'failed' (that would be a regression from today's behavior, the opposite of best-effort).
  try {
    return await scanCandidates(journal, plan, ttlMs);
  } catch {
    return { kind: 'none' };
  }
}

async function scanCandidates(journal: Journal, plan: SemPlan, ttlMs?: number): Promise<SemVerdict> {
  if (typeof journal.listKeys !== 'function') return { kind: 'none', noListKeys: true };
  const prefix = `xthr:${plan.threadId}:sem-${plan.toolName}-`;
  const keys = (await journal.listKeys(prefix).catch(() => [] as string[]))
    .filter((k) => k !== semKey(plan.threadId, plan.toolName, plan.argsHash));
  if (keys.length === 0) return { kind: 'none' };

  const nowMs = journal.now ? await journal.now() : Date.now();
  let droppedStamp = 0;
  const candidates: SemDupRecord[] = [];
  for (const k of keys) {
    const rec = await journal.get<SemDupRecord>(k);
    if (!rec || rec.v !== 1) continue;
    if (ttlMs !== undefined && nowMs - rec.at > ttlMs) continue; // aged out of the window
    if (rec.embedModelId !== plan.cfg.embedModelId || rec.templateVersion !== SEM_TEMPLATE_VERSION || !rec.vecB64) {
      droppedStamp++; // never compared silently across models/templates — excluded and counted
      continue;
    }
    if ((await journal.get(semTombKey(plan.threadId, plan.toolName, rec.argsHash, plan.argsHash))) !== undefined) {
      continue; // a human already ruled this pair "different work" — never re-asked
    }
    candidates.push(rec);
  }
  if (candidates.length === 0) return { kind: 'none', ...(droppedStamp ? { droppedStamp } : {}) };

  const embedded = await embedCached(plan.cfg, plan.canonical);
  if (!embedded.vec) return { kind: 'none', embedFailed: true, outage: embedded.outage, ...(droppedStamp ? { droppedStamp } : {}) };

  const minSim = plan.cfg.minSimilarity ?? 0.6;
  const topK = plan.cfg.topK ?? 3;
  const scored = candidates
    .map((rec) => ({ rec, score: cosine(embedded.vec!, decodeVec(rec.vecB64!)) }))
    .filter((c) => c.score >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  let droppedIdentity = 0;
  for (const { rec, score } of scored) {
    const discKeys = plan.id.discriminatorFields ?? [];
    if (discKeys.some((k) => (rec.discriminators[k] ?? '') !== (plan.fields.discriminators[k] ?? ''))) continue; // negation gate
    const idEqual = plan.id.keys.every((k) => (rec.identity[k] ?? '') === (plan.fields.identity[k] ?? ''));
    if (!idEqual) { droppedIdentity++; continue; } // score alone NEVER suspends
    const amountsDiffer = (plan.id.amountFields ?? []).filter((k) => rec.amounts[k] !== plan.fields.amounts[k]);
    return { kind: 'suspend', score, firstToolCallId: rec.firstToolCallId, priorHash: rec.argsHash, priorCanonical: rec.canonical, amountsDiffer };
  }
  return { kind: 'none', ...(droppedIdentity ? { droppedIdentity } : {}), ...(droppedStamp ? { droppedStamp } : {}) };
}
