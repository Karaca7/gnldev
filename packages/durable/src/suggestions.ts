// HERMES v1 — onay-kapılı öneri/öğrenme katmanı (suggestions).
//
// WHAT THIS IS: after a run completes, a learning pass MAY propose a `memory-lesson` — a short,
// generalizable rule plus the MANDATORY mechanism sentence ("why it works"). A proposal is never
// applied by itself: it sits as a `sugg:` record until a human approves it, and only then becomes a
// `lesson:` record that future runs inject into the system prompt. Hermes-Agent's loop, with the
// autonomy removed and the approval gate made structural.
//
// THE TWO SWITCHES (binding design decision): `generate` (may the system PROPOSE?) and `apply`
// (may APPROVED lessons be injected?) are independent. Approved lessons OUTLIVE the switches —
// turning `apply` off stops injection but deletes nothing.
//
// EVIDENCE DISCIPLINE (binding, from the "5 veri izledi — yanıltır mı?" round):
//   1. Evidence DIVERSITY at birth: repeats from the same user/thread/day count as ONE effective
//      evidence. The approval surface sees both raw and effective counts plus a same-source warning.
//   2. UNDER-INFLUENCE stamping: a run that had lesson L injected cannot contribute evidence to the
//      suggestion L came from — the rule must not cite its own shadow. Such entries are stored but
//      stamped `tainted` and excluded from every effective count, including promotion.
//
// PROMOTION (optional, pluggable-by-config): the org-promotion code path exists ONLY when the
// `promotion` block is present — no block, no cross-user leak, structurally. v1 ships the single
// named strategy 'on-approval' (one cheap scan at each personal-lesson approval); 'batch'/'both'
// are reserved and REFUSED at config time. Threshold: N = max(minUsers, ceil(activeUsers·ratio)).
// An org suggestion is itself just a `sugg:` record — it too waits for a human (triple opt-in).
//
// DETERMINISM CONTRACT with the run engine: the injected lesson block is FROZEN per runId at
// `<runId>:cfg:lessons` (claim, first-wins — even when EMPTY). A retry of the same runId always
// composes the same system prompt, so strictInput's raw-input fingerprint cannot be broken by a
// lesson approved between attempt and retry. purgeRun sweeps the provenance with the run.
//
// Best-effort applies to the LEARNING pass: a model/journal hiccup there loses one proposal, never
// a run. Generation is memoized AT-MOST-ONCE per runId (claim BEFORE the model call — a crash may
// lose a proposal; it can never double-propose noise). INJECTION is deliberately the opposite —
// fail-CLOSED: prepareInjection throwing aborts the run BEFORE anything is journaled (a safe,
// retryable refusal), because the alternative — silently injecting an empty block when the freeze
// could not be read or written — would poison the runId's fingerprint contract on retry.
import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { claim as journalClaim } from './journal.js';
import { resolveModel } from './model-router.js';
import { argsHash } from './hash.js';
import { cosine, decodeVec, encodeVec, embedCached } from './semantic-dup.js';
import type { Journal } from './journal.js';
import type { ModelInput } from './types.js';

export interface SuggestionsConfig {
  /** May the system PROPOSE lessons after completed runs? Requires `model` and journal listKeys. */
  generate: boolean;
  /** May APPROVED lessons be injected into future runs' system prompts? */
  apply: boolean;
  /** The learning-pass model ('provider/model' spec or an AI SDK model object). REQUIRED when `generate`. */
  model?: ModelInput;
  /** SAME signature as the semantic layer's embed — one closure can serve both. Optional: without it,
   *  similar-lesson merge and promotion clustering fall back to exact normalized-text equality. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** REQUIRED with `embed` — vectors from different models are never compared (semantic-layer rule). */
  embedModelId?: string;
  /** Merge/cluster threshold (cosine), default 0.85 — deliberately high: a false merge silently
   *  inflates another rule's evidence, which is the exact failure the evidence discipline exists for. */
  minSimilarity?: number;
  /** How many lessons a run's prompt may carry (newest first), default 5. */
  maxInject?: number;
  /** Org-promotion block — ABSENT means the promotion code path never runs (no-leak by structure). */
  promotion?: {
    /** v1: only 'on-approval'. 'batch'/'both' are designed but not shipped — refused at config time. */
    strategy: 'on-approval';
    threshold?: { minUsers?: number; ratio?: number };
  };
}

export interface SuggestionEvidence {
  /** The testifying run — EXCEPT on org-scope records, where promotion has no single run to cite and
   *  this carries the supporting suggestion's id (mirrored in `sourceSuggestionId`, which is the
   *  honest field; consumers deriving run keys from `runId` must skip entries that carry it). */
  runId: string;
  /** Org-scope only: the personal suggestion whose approved lesson supports this promotion. */
  sourceSuggestionId?: string;
  resourceId?: string;
  threadId?: string;
  at: number;
  /** Under-influence stamp: this run had the suggestion's own lesson injected — stored, never counted. */
  tainted?: boolean;
}

export interface SuggestionRecord {
  v: 1;
  id: string;
  type: 'memory-lesson';
  scope: 'personal' | 'org';
  /** Personal scope owner (absent on org-scope records). */
  resourceId?: string;
  status: 'pending' | 'approved' | 'rejected';
  rule: string;
  /** The mandatory "why it works" sentence — a rule without a mechanism is refused at birth. */
  mechanism: string;
  vecB64?: string;
  embedModelId?: string;
  evidence: SuggestionEvidence[];
  at: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface LessonRecord {
  v: 1;
  id: string;
  rule: string;
  mechanism: string;
  fromSuggestion: string;
  scope: 'personal' | 'org';
  resourceId?: string;
  at: number;
  /** Effective (diversity-deduped, untainted) evidence count at approval time — promotion reads this. */
  effectiveEvidence: number;
}

/** Computed at read time — the approval surface's honesty layer. */
export interface EvidenceQuality {
  total: number;
  tainted: number;
  /** Diversity-deduped untainted count: same user+thread+day repeats collapse to one. */
  effective: number;
  distinctUsers: number;
  distinctThreads: number;
  /** ≥2 raw entries but a single user produced them all — the "5 gözlem, hepsi aynı kullanıcıdan ⚠" flag. */
  sameSourceWarning: boolean;
}

export const suggKey = (id: string): string => `sugg:${id}`;
export const personalLessonKey = (resourceId: string, suggId: string): string => `lesson:res:${resourceId}:${suggId}`;
export const orgLessonKey = (suggId: string): string => `lesson:org:${suggId}`;
export const lessonProvenanceKey = (runId: string): string => `${runId}:cfg:lessons`;

const DAY_MS = 86_400_000;
const DEFAULT_MERGE_SIMILARITY = 0.85;
const DEFAULT_MAX_INJECT = 5;
const RULE_MAX_CHARS = 400;

export const normalizeRule = (v: string): string => v.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

// ── config-time validation (THROW, not warn — the semantic layer's precedent) ──

export function validateSuggestionsConfig(cfg: SuggestionsConfig, journal: Journal): void {
  if (typeof cfg.generate !== 'boolean' || typeof cfg.apply !== 'boolean') {
    throw new Error('@gnldev/durable: suggestions requires BOTH switches — `generate` and `apply` — as explicit booleans (the two-switch contract).');
  }
  if (cfg.generate && cfg.model === undefined) {
    throw new Error('@gnldev/durable: suggestions.generate=true requires `model` — the learning pass IS a model call; without one the switch would be silently inert.');
  }
  if ((cfg.embed !== undefined) !== (typeof cfg.embedModelId === 'string' && cfg.embedModelId.length > 0)) {
    throw new Error('@gnldev/durable: suggestions.embed and embedModelId come TOGETHER — vectors must carry their model stamp (semantic-layer rule).');
  }
  if (cfg.embed !== undefined && typeof cfg.embed !== 'function') {
    throw new Error('@gnldev/durable: suggestions.embed must be a (texts: string[]) => Promise<number[][]> closure.');
  }
  if (cfg.minSimilarity !== undefined && !(cfg.minSimilarity > 0 && cfg.minSimilarity <= 1)) {
    throw new Error('@gnldev/durable: suggestions.minSimilarity must be in (0, 1].');
  }
  if (cfg.promotion) {
    if (cfg.promotion.strategy !== 'on-approval') {
      throw new Error("@gnldev/durable: suggestions.promotion.strategy — v1 ships only 'on-approval'; 'batch'/'both' are reserved for v2 and refused rather than silently ignored.");
    }
    const t = cfg.promotion.threshold;
    if (t?.minUsers !== undefined && !(Number.isInteger(t.minUsers) && t.minUsers >= 1)) {
      throw new Error('@gnldev/durable: suggestions.promotion.threshold.minUsers must be an integer ≥ 1.');
    }
    if (t?.ratio !== undefined && !(t.ratio > 0 && t.ratio <= 1)) {
      throw new Error('@gnldev/durable: suggestions.promotion.threshold.ratio must be in (0, 1].');
    }
  }
  // ALL three switches that need listKeys gate on it — guarding generate/promotion while letting
  // apply stay silently inert (readLessons would return [] forever, no lesson ever injected, no
  // error ever raised) would turn this throw into a false "it validated, so it works" assurance.
  if ((cfg.generate || cfg.apply || cfg.promotion) && typeof journal.listKeys !== 'function') {
    throw new Error('@gnldev/durable: suggestions.generate/apply/promotion all need journal.listKeys — lesson injection, proposal merge and promotion clustering enumerate records; without listKeys the switch would be silently absent.');
  }
}

// ── evidence quality (the honesty math — shared by list() and approval-time snapshots) ──

export function evidenceQualityOf(evidence: SuggestionEvidence[]): EvidenceQuality {
  const untainted = evidence.filter((e) => e.tainted !== true);
  const users = new Set(untainted.map((e) => e.resourceId ?? ''));
  const threads = new Set(untainted.map((e) => e.threadId ?? ''));
  const diversity = new Set(untainted.map((e) => `${e.resourceId ?? ''}|${e.threadId ?? ''}|${Math.floor(e.at / DAY_MS)}`));
  return {
    total: evidence.length,
    tainted: evidence.length - untainted.length,
    effective: diversity.size,
    distinctUsers: users.size,
    distinctThreads: threads.size,
    sameSourceWarning: evidence.length >= 2 && users.size <= 1,
  };
}

// ── the learning prompt (Hermes'in _AUTHORING_STANDARDS disiplini, onay-kapılı hâli) ──

const LEARN_SYSTEM = [
  'You extract at most ONE reusable lesson from a completed agent run.',
  'Output STRICT JSON only, no prose, no code fences: {"found": boolean, "rule": string, "mechanism": string}.',
  'Standards:',
  '- rule: a GENERAL, reusable guideline for future runs — never a restatement of this specific task, never a fact about this one user. Max 2 sentences.',
  '- mechanism: one sentence stating WHY the rule works. A rule without a mechanism is invalid — set found=false instead.',
  '- If nothing generalizable happened, {"found": false, "rule": "", "mechanism": ""}.',
].join('\n');

function buildLearnPrompt(input: { prompt?: string; output: string }): string {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  return [
    input.prompt ? `USER REQUEST:\n${clip(input.prompt, 2000)}` : 'USER REQUEST: (not a plain-text prompt)',
    `FINAL ANSWER:\n${clip(input.output, 2000)}`,
    'Extract the lesson per the standards, or found=false.',
  ].join('\n\n');
}

function parseLearnJson(text: string): { found: boolean; rule: string; mechanism: string } | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { found?: unknown; rule?: unknown; mechanism?: unknown };
    if (typeof j.found !== 'boolean') return undefined;
    return { found: j.found, rule: typeof j.rule === 'string' ? j.rule.trim() : '', mechanism: typeof j.mechanism === 'string' ? j.mechanism.trim() : '' };
  } catch {
    return undefined;
  }
}

// ── the API factory (returned from createGnl as `gnl.suggestions`) ──

export interface SuggestionsApi {
  /** Freezes and returns the lesson block for a run (claim, first-wins, EMPTY is also frozen).
   *  Registry calls this before runDurable; hosts normally never call it directly. */
  prepareInjection(runId: string, resourceId?: string): Promise<{ ids: string[]; text: string }>;
  /** The learning pass — at-most-once per runId. Returns the (new or merged-into) suggestion id, or null. */
  generateFor(input: { runId: string; resourceId?: string; threadId?: string; prompt?: string; output: string }): Promise<{ id: string; merged: boolean } | null>;
  /** Inbox read — records plus computed evidence quality, newest first. */
  list(filter?: { status?: SuggestionRecord['status']; scope?: SuggestionRecord['scope']; resourceId?: string }): Promise<Array<SuggestionRecord & { quality: EvidenceQuality }>>;
  /** First-decision-wins approve/reject. Approving a personal suggestion births its lesson record and
   *  (when the promotion block exists) runs one on-approval promotion scan. */
  decide(id: string, opts: { approve: boolean; by?: string }): Promise<{ status: 'approved' | 'rejected'; alreadyDecided: boolean }>;
  /** Approved lessons visible to a resource (personal + org), newest first. `injected` = how many
   *  runs this lesson was frozen into (from the `suggstats:<lessonKey>` counter; absent without incrBy). */
  lessons(resourceId?: string): Promise<Array<LessonRecord & { key: string; injected?: number }>>;
}

export function createSuggestions(journal: Journal, cfg: SuggestionsConfig): SuggestionsApi {
  const embedCfg = cfg.embed && cfg.embedModelId ? { embed: cfg.embed, embedModelId: cfg.embedModelId } : undefined;
  const minSim = cfg.minSimilarity ?? DEFAULT_MERGE_SIMILARITY;
  const maxInject = cfg.maxInject ?? DEFAULT_MAX_INJECT;
  const nowOf = async () => (journal.now ? await journal.now() : Date.now());

  async function readLessons(resourceId?: string): Promise<Array<LessonRecord & { key: string; injected?: number }>> {
    if (typeof journal.listKeys !== 'function') return [];
    const keys: string[] = [];
    if (resourceId) keys.push(...(await journal.listKeys(`lesson:res:${resourceId}:`).catch(() => [] as string[])));
    keys.push(...(await journal.listKeys('lesson:org:').catch(() => [] as string[])));
    const out: Array<LessonRecord & { key: string; injected?: number }> = [];
    for (const k of keys) {
      const rec = await journal.get<LessonRecord>(k);
      if (!rec || rec.v !== 1) continue;
      // The injection counter's key carries the full LESSON KEY (`suggstats:lesson:res:...`) — the
      // one identity prepareInjection has in hand at freeze time. Surfaced here so the counter has a
      // reader (a written-only counter is dead weight); best-effort like its writer.
      const counters = journal.getCounters ? await journal.getCounters(`suggstats:${k}`).catch(() => undefined) : undefined;
      out.push({ ...rec, key: k, ...(counters?.injected !== undefined ? { injected: counters.injected } : {}) });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function renderBlock(lessons: Array<LessonRecord & { key: string }>): string {
    if (lessons.length === 0) return '';
    const lines = lessons.map((l) => `- ${l.rule} (why: ${l.mechanism})`);
    return `[Approved lessons — human-approved guidance from past runs; advisory, never overriding the task]\n${lines.join('\n')}`;
  }

  async function prepareInjection(runId: string, resourceId?: string): Promise<{ ids: string[]; text: string }> {
    // apply:false skips the freeze entirely (no journal write per run). Known, accepted edge: a run
    // started under apply:false and RETRIED after the deployment flips apply on will compose a
    // different system prompt and 409 under strictInput — flipping the switch is a deployment
    // change, and "one runId = one request" treats it as new content by design.
    if (!cfg.apply) return { ids: [], text: '' };
    const key = lessonProvenanceKey(runId);
    const frozen = await journal.get<{ ids: string[]; text: string }>(key);
    if (frozen !== undefined) return frozen;
    const all = await readLessons(resourceId);
    const chosen = all.slice(0, maxInject);
    const value = { ids: chosen.map((l) => l.key), text: renderBlock(chosen) };
    // First-wins, EMPTY INCLUDED: a lesson approved between attempt and retry must not change the
    // retry's composed system prompt (strictInput's fingerprint would 409 an honest retry).
    const won = await journalClaim(journal, key, value);
    if (!won) {
      const winner = await journal.get<{ ids: string[]; text: string }>(key);
      if (winner !== undefined) return winner; // K4: the loser holds itself to the winner's freeze
    } else if (journal.incrBy && value.ids.length) {
      for (const id of value.ids) await journal.incrBy(`suggstats:${id}`, { injected: 1 }).catch(() => {});
    }
    return value;
  }

  async function similarityMatch(rule: string, candidates: Array<{ rule: string; vecB64?: string; embedModelId?: string }>): Promise<number> {
    const norm = normalizeRule(rule);
    if (!embedCfg) return candidates.findIndex((c) => normalizeRule(c.rule) === norm);
    const embedded = await embedCached(embedCfg, norm);
    if (!embedded.vec) return candidates.findIndex((c) => normalizeRule(c.rule) === norm); // embed outage → exact-match fallback, never a throw
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (normalizeRule(c.rule) === norm) return i; // exact text equality wins regardless of vectors
      if (!c.vecB64 || c.embedModelId !== embedCfg.embedModelId) continue; // never compared across model stamps
      const score = cosine(embedded.vec, decodeVec(c.vecB64));
      if (score >= minSim && score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }

  async function generateFor(input: { runId: string; resourceId?: string; threadId?: string; prompt?: string; output: string }): Promise<{ id: string; merged: boolean } | null> {
    if (!cfg.generate) return null;
    if (!input.resourceId) return null; // a personal lesson needs an owner — resourceless runs don't learn
    const memoKey = `${input.runId}:sugg:gen`;
    const memo = await journal.get<{ suggId: string | null; merged?: boolean }>(memoKey);
    if (memo !== undefined) return memo.suggId ? { id: memo.suggId, merged: memo.merged === true } : null;
    // AT-MOST-ONCE: the claim lands BEFORE the model call. A crash mid-generation loses one proposal
    // (acceptable — suggestions are advisory); the alternative double-proposes on every race.
    const won = await journalClaim(journal, memoKey, { suggId: null, pending: true });
    if (!won) {
      const cur = await journal.get<{ suggId: string | null; merged?: boolean }>(memoKey);
      return cur?.suggId ? { id: cur.suggId, merged: cur.merged === true } : null;
    }
    try {
      const model = typeof cfg.model === 'string' ? await resolveModel(cfg.model) : cfg.model;
      const r = await generateText({ model: model as never, system: LEARN_SYSTEM, prompt: buildLearnPrompt(input) });
      const parsed = parseLearnJson(r.text ?? '');
      if (!parsed || !parsed.found || !parsed.rule || !parsed.mechanism || parsed.rule.length > RULE_MAX_CHARS) {
        await journal.put(memoKey, { suggId: null });
        return null;
      }
      // Under-influence set: which suggestions' lessons were injected into THIS run? Tracked BOTH by
      // record identity (fromSuggestion ids) AND by content (the injected rules themselves): an org
      // lesson echoed back by a user with no personal record would otherwise be born as a fresh,
      // untainted personal suggestion — the shadow slipping through the scope boundary (denetçi K6:
      // content-matched protections must not hang on record identity alone).
      const frozen = await journal.get<{ ids: string[] }>(lessonProvenanceKey(input.runId));
      const influencedBy = new Set<string>();
      const injectedRules: string[] = [];
      for (const lk of frozen?.ids ?? []) {
        const l = await journal.get<LessonRecord>(lk);
        if (l?.fromSuggestion) { influencedBy.add(l.fromSuggestion); injectedRules.push(l.rule); }
      }
      const shadowed = injectedRules.length > 0 && (await ruleShadowed(parsed.rule, injectedRules));
      const at = await nowOf();
      // Merge scan: an existing similar suggestion (this resource, pending/approved) absorbs the
      // evidence — the same lesson twice must be ONE rule with two evidences, not two rules.
      const existing: Array<SuggestionRecord & { key: string }> = [];
      if (typeof journal.listKeys === 'function') {
        for (const k of await journal.listKeys('sugg:').catch(() => [] as string[])) {
          if (k.split(':').length !== 2) continue; // decision side-keys (sugg:<id>:decision) are not records
          const rec = await journal.get<SuggestionRecord>(k);
          if (rec && rec.v === 1 && rec.scope === 'personal' && rec.resourceId === input.resourceId && rec.status !== 'rejected') {
            existing.push({ ...rec, key: k });
          }
        }
      }
      const matchIdx = await similarityMatch(parsed.rule, existing);
      if (matchIdx >= 0) {
        const target = existing[matchIdx]!;
        const entry: SuggestionEvidence = {
          runId: input.runId,
          resourceId: input.resourceId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          at,
          ...(influencedBy.has(target.id) || shadowed ? { tainted: true } : {}),
        };
        // CAS append (3 attempts) — two concurrent merges must not eat each other's evidence. On a
        // journal without putIfMatch this degrades to read+put (documented best-effort).
        for (let attempt = 0; attempt < 3; attempt++) {
          const cur = await journal.get<SuggestionRecord>(target.key);
          if (!cur) break;
          if (cur.evidence.some((e) => e.runId === input.runId)) break; // this run already testified
          const next = { ...cur, evidence: [...cur.evidence, entry] };
          if (typeof journal.putIfMatch === 'function') {
            if (await journal.putIfMatch(target.key, cur, next)) break;
          } else {
            await journal.put(target.key, next);
            break;
          }
        }
        await journal.put(memoKey, { suggId: target.id, merged: true });
        return { id: target.id, merged: true };
      }
      // New suggestion — born pending, vector best-effort.
      const id = randomUUID();
      let vecB64: string | undefined;
      if (embedCfg) {
        const e = await embedCached(embedCfg, normalizeRule(parsed.rule));
        if (e.vec) vecB64 = encodeVec(Array.from(e.vec));
      }
      const rec: SuggestionRecord = {
        v: 1,
        id,
        type: 'memory-lesson',
        scope: 'personal',
        resourceId: input.resourceId,
        status: 'pending',
        rule: parsed.rule,
        mechanism: parsed.mechanism,
        ...(vecB64 ? { vecB64, embedModelId: embedCfg!.embedModelId } : {}),
        evidence: [{ runId: input.runId, resourceId: input.resourceId, ...(input.threadId ? { threadId: input.threadId } : {}), at, ...(shadowed ? { tainted: true } : {}) }],
        at,
      };
      await journal.put(suggKey(id), rec);
      await journal.put(memoKey, { suggId: id, merged: false });
      return { id, merged: false };
    } catch {
      await journal.put(memoKey, { suggId: null }).catch(() => {});
      return null; // best-effort: the learning pass never fails a run
    }
  }

  async function list(filter?: { status?: SuggestionRecord['status']; scope?: SuggestionRecord['scope']; resourceId?: string }): Promise<Array<SuggestionRecord & { quality: EvidenceQuality }>> {
    if (typeof journal.listKeys !== 'function') return [];
    const out: Array<SuggestionRecord & { quality: EvidenceQuality }> = [];
    for (const k of await journal.listKeys('sugg:').catch(() => [] as string[])) {
      if (k.split(':').length !== 2) continue;
      const rec = await journal.get<SuggestionRecord>(k);
      if (!rec || rec.v !== 1) continue;
      if (filter?.status && rec.status !== filter.status) continue;
      if (filter?.scope && rec.scope !== filter.scope) continue;
      if (filter?.resourceId && rec.resourceId !== filter.resourceId) continue;
      out.push({ ...rec, quality: evidenceQualityOf(rec.evidence) });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async function decide(id: string, opts: { approve: boolean; by?: string }): Promise<{ status: 'approved' | 'rejected'; alreadyDecided: boolean }> {
    const key = suggKey(id);
    const rec = await journal.get<SuggestionRecord>(key);
    if (!rec || rec.v !== 1) throw new Error(`@gnldev/durable: suggestion '${id}' not found`);
    const at = await nowOf();
    // FIRST-DECISION-WINS via claim — two operators clicking at once must converge on one verdict.
    // Winning the claim locks the DECISION, not its EFFECTS (denetçi bloker): the status flip and the
    // lesson birth land AFTER the claim, so a transient failure in that window used to leave a
    // decision corpse every later call bounced off as `alreadyDecided` — a permanently pending
    // suggestion no call could ever unlock. Both paths therefore run the SAME idempotent effects
    // repair below: verify what the winning decision implies, complete whatever is missing.
    const won = await journalClaim(journal, `${key}:decision`, { approve: opts.approve, by: opts.by, at });
    const decision = won
      ? { approve: opts.approve, by: opts.by, at }
      : await journal.get<{ approve: boolean; by?: string; at: number }>(`${key}:decision`);
    if (!decision) {
      // Lost the claim but cannot read the winner: a read failure must not masquerade as a verdict
      // (reporting 'rejected' here would be inventing a decision that may well be 'approved').
      throw new Error(`@gnldev/durable: suggestion '${id}' was decided concurrently but the winning decision could not be read — retry.`);
    }
    await applyDecisionEffects(key, decision);
    return { status: decision.approve ? 'approved' : 'rejected', alreadyDecided: !won };
  }

  /** Idempotent completion of a decision's effects — safe to run on every decide() call.
   *  Status flip is CAS'd (3 attempts): a concurrent generateFor merge appending evidence (possibly
   *  with a taint stamp) must never be eaten by a stale blind put (denetçi K3 — writeSemRecord's twin). */
  async function applyDecisionEffects(key: string, decision: { approve: boolean; by?: string; at: number }): Promise<void> {
    const status: SuggestionRecord['status'] = decision.approve ? 'approved' : 'rejected';
    let rec: SuggestionRecord | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      rec = await journal.get<SuggestionRecord>(key);
      if (!rec || rec.v !== 1) return;
      if (rec.status === status) break; // flip already landed (this call or an earlier repair)
      const next: SuggestionRecord = { ...rec, status, decidedAt: rec.decidedAt ?? decision.at, ...(decision.by && !rec.decidedBy ? { decidedBy: decision.by } : {}) };
      if (typeof journal.putIfMatch === 'function') {
        if (await journal.putIfMatch(key, rec, next)) { rec = next; break; }
      } else {
        await journal.put(key, next);
        rec = next;
        break;
      }
    }
    if (!decision.approve || !rec) return;
    // Lesson birth — deterministic keys, so re-running is a no-op when the record already exists.
    const quality = evidenceQualityOf(rec.evidence);
    const lesson: LessonRecord = {
      v: 1,
      id: rec.id,
      rule: rec.rule,
      mechanism: rec.mechanism,
      fromSuggestion: rec.id,
      scope: rec.scope,
      ...(rec.resourceId ? { resourceId: rec.resourceId } : {}),
      at: decision.at,
      effectiveEvidence: quality.effective,
    };
    if (rec.scope === 'personal' && rec.resourceId) {
      const lk = personalLessonKey(rec.resourceId, rec.id);
      if ((await journal.get(lk)) === undefined) await journal.put(lk, lesson);
      // Promotion is claim-guarded on a deterministic org id — re-running the scan is idempotent.
      if (cfg.promotion) await promotionScan(rec, decision.at).catch(() => {}); // best-effort — promotion must never fail an approval
    } else if (rec.scope === 'org') {
      const lk = orgLessonKey(rec.id);
      if ((await journal.get(lk)) === undefined) await journal.put(lk, lesson);
    }
  }

  /** 'on-approval': one scan at each personal approval. Similar approved lessons across DISTINCT
   *  resources ≥ N → an org-scope suggestion is born (pending — promotion never applies by itself). */
  async function promotionScan(approved: SuggestionRecord, at: number): Promise<void> {
    if (typeof journal.listKeys !== 'function') return;
    const all: Array<LessonRecord & { key: string }> = [];
    for (const k of await journal.listKeys('lesson:res:').catch(() => [] as string[])) {
      const rec = await journal.get<LessonRecord>(k);
      if (rec && rec.v === 1) all.push({ ...rec, key: k });
    }
    const activeResources = new Set(all.map((l) => l.resourceId ?? '')).size;
    const minUsers = cfg.promotion?.threshold?.minUsers ?? 3;
    const ratio = cfg.promotion?.threshold?.ratio ?? 0.2;
    const needed = Math.max(minUsers, Math.ceil(activeResources * ratio));
    // Cluster around the just-approved rule; a lesson with ZERO effective evidence never counts
    // (under-influence discipline carried into promotion).
    const supporters = new Map<string, LessonRecord & { key: string }>();
    for (const l of all) {
      if (l.effectiveEvidence < 1 || !l.resourceId) continue;
      const idx = await similarityMatch(approved.rule, [{ rule: l.rule, vecB64: undefined }]);
      const same = idx >= 0 || (embedCfg ? await vecSimilar(approved, l) : false);
      if (same) supporters.set(l.resourceId, l);
    }
    if (supporters.size < needed) return;
    // Deterministic id from the normalized rule → the same cluster can never spawn two org
    // suggestions, and a REJECTED org suggestion is not re-asked (the claim finds the corpse).
    const orgId = `org-${argsHash({ rule: normalizeRule(approved.rule) })}`;
    const rec: SuggestionRecord = {
      v: 1,
      id: orgId,
      type: 'memory-lesson',
      scope: 'org',
      status: 'pending',
      rule: approved.rule,
      mechanism: approved.mechanism,
      evidence: [...supporters.values()].map((l) => ({ runId: l.fromSuggestion, sourceSuggestionId: l.fromSuggestion, resourceId: l.resourceId, at: l.at })),
      at,
    };
    await journalClaim(journal, suggKey(orgId), rec);
  }

  /** Content-level shadow test: is this rule the echo of a lesson injected into the same run?
   *  Exact normalized equality always; cosine when an embedder is configured (lessons carry no stored
   *  vector — both sides are embedded live through the shared cache, so the cost is one-off). */
  async function ruleShadowed(rule: string, injectedRules: string[]): Promise<boolean> {
    const norm = normalizeRule(rule);
    for (const ir of injectedRules) {
      const irNorm = normalizeRule(ir);
      if (irNorm === norm) return true;
      if (embedCfg) {
        const a = await embedCached(embedCfg, norm);
        const b = await embedCached(embedCfg, irNorm);
        if (a.vec && b.vec && cosine(a.vec, b.vec) >= minSim) return true;
      }
    }
    return false;
  }

  async function vecSimilar(a: SuggestionRecord, l: LessonRecord): Promise<boolean> {
    if (!embedCfg) return false;
    const ea = await embedCached(embedCfg, normalizeRule(a.rule));
    const eb = await embedCached(embedCfg, normalizeRule(l.rule));
    if (!ea.vec || !eb.vec) return false;
    return cosine(ea.vec, eb.vec) >= minSim;
  }

  return { prepareInjection, generateFor, list, decide, lessons: readLessons };
}
