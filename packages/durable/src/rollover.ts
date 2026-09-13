// Rollover — a first-class period-closing helper for the long-lived SINGLE run problem
// (mitigation for the core-hardening review risk #1). Since the journal is append-only it can't be
// trimmed, and replay always starts from the beginning; for an agent that lives for weeks, the
// solution is to split the run into LOGICAL PERIODS: at period close, the old run's materialized
// final state (messages) is carried over into a new runId's `:input` seed, and the new period
// continues from that context with a fresh journal. This file turns that user pattern into a
// deterministic + idempotent API. IT DELETES NOTHING — the old journal remains as-is
// (purge/sweep is a separate decision, see retention.ts).
//
// PATTERN (long-lived agent):
//   1. Period N runs:              await runDurable({ runId: 'agent', journal, model, tools, ... })
//   2. Period close:               const r = await rolloverRun(journal, 'agent')          // → 'agent@2'
//   3. Period N+1 continuation (plain): await resumeRun(r.newRunId, { journal, model, tools }) // from :input seed
// or explicitly:            await runDurable({ runId: r.newRunId, journal, model, tools, messages: r.messages })
//
// INPUT-SEED CONTRACT: the seed is written to `runKeys.input(newRunId)` in the shape run.ts's
// `persistInput` writes (`{ messages, system? }`) → WITHOUT BREAKING `resumeRun`/`persistInput`
// semantics, the new run naturally inherits the input (persistInput sees the key already filled
// and skips it; resumeRun reads from there). IMPORTANT LIMIT: do NOT pass `messages` DIFFERENT
// from the seed to the new period's FIRST call — since `:input` is already filled, the difference
// is not written to the journal and a subsequent resume won't see those messages. If the new
// period needs extra instructions/a summary, do it inside `carry` (the seed and the live call
// always stay the same). For convenience, the seed messages are also returned in `RolloverResult.messages`.
//
// FORMAT NOTE (honest deviation): reconstructState's raw output is in journal-record shape —
// tool-result parts have no `toolName` and `output` is untyped; AI SDK v5's `generateText`
// VALIDATES messages against a schema (missing toolName → InvalidPromptError). Therefore the
// carried-over messages are normalized into ModelMessage shape while preserving CONTENT exactly
// (filling in toolName, typing `output` as `{type:'json'|'text', value}`, parsing the tool-call
// `input` JSON string into an object). "Carried over exactly" is at the content level, not the byte level.
import { runKeys, claim } from './journal.js';
import { derivedRunIdBase, executionRunId, parseDerivedRunId, rawInputFingerprint } from './hash.js';
import type { WorkScope } from './hash.js';
import { stampFormat, upgradeFormat } from './format.js';
import { reconstructState } from './time-travel.js';
import type { ReconstructSeed } from './time-travel.js';
import type { Journal, JournalReader } from './journal.js';

export interface RolloverOptions {
  /**
   * New runId. Omitted → `pickNextRunId` picks one, and WHICH SPELLING depends on the source:
   * `run1_<digest>#2` for an engine-derived run (the execution axis), `${runId}@2` for a raw one
   * (incrementing @N — existing ones are counted/skipped). See that function for why the two regimes
   * exist rather than one.
   */
  newRunId?: string;
  /** Summarize and carry over the old conversation: (messages) => messages to carry over. If not given, messages are carried over EXACTLY. */
  carry?: (messages: unknown[]) => unknown[] | Promise<unknown[]>;
}

export interface RolloverResult {
  newRunId: string;
  seededMessages: number;
  /** Messages seeded into the new run (identical to the `messages` in `runKeys.input(newRunId)`). */
  messages: unknown[];
}

/** Handoff marker on the old run: `${runId}:rollover` → `{ to, at }` (invisible to parseJournalKey). */
export const rolloverKey = (runId: string) => `${runId}:rollover`;

/**
 * The next period's id — TWO REGIMES, deliberately (§4, condition 5).
 *
 * DERIVED SOURCE (`run1_<digest>…`) → the engine's execution axis: `run1_<digest>#2`, `#3`, … The
 * `@N` spelling was invented here, before there was an axis, and the decision names it by file and
 * line as one of the two places GNL was breaking its own rule: a hash-free string minted inside a
 * namespace whose whole promise is that the engine owns the shape. `@N` is not merely off-style
 * there — `run1_<digest>@2` wears the prefix without the shape and `assertRunIdSafe` refuses it, so
 * a period handoff of derived work would have died at the next `resumeRun`.
 *
 * RAW SOURCE → `${runId}@2`, byte for byte, including the `agent@2 → agent@3` continuation. `#` is
 * unspellable outside `run1_` (assertRunIdSafe), so the two regimes cannot leak into each other, and
 * no journal already holding `agent@7` has to move. Two spellings for one concept is a cost paid on
 * purpose: the alternative is rewriting live ids.
 *
 * Both branches SKIP names that are already filled — a run with `:input` written is taken
 * (persistInput/forkRun/rollover all write it), so a second handoff never lands on a live period.
 *
 * HONEST BOUND on the derived branch: `#<n>` counts off the BASE, so handing over a run that carries
 * a DIFFERENT suffix (`#fork-1`, `#replay-3`) starts the search at `#2` and takes the first free
 * slot. One id carries one suffix, so "period 2 of fork 1" has no spelling; the seed still carries
 * the identity forward, which is what the next period actually reads.
 */
async function pickNextRunId(journal: Journal, runId: string): Promise<string> {
  const derivedBase = derivedRunIdBase(runId);
  if (derivedBase !== undefined) {
    const start = (parseDerivedRunId(runId)?.execution ?? 1) + 1;
    for (let n = start; n < start + 10_000; n++) {
      const cand = executionRunId(derivedBase, n);
      if ((await journal.get(runKeys.input(cand))) === undefined) return cand;
    }
    throw new Error(
      `@gnldev/durable: rolloverRun could not find a free execution number (all '${derivedBase}#<n>' are taken).`,
    );
  }
  const m = /^(.*)@(\d+)$/.exec(runId); // handoff of 'agent@2' → start searching from 'agent@3'
  const base = m ? m[1]! : runId;
  const start = m ? Number(m[2]) + 1 : 2;
  for (let n = start; n < start + 10_000; n++) {
    const cand = `${base}@${n}`;
    if ((await journal.get(runKeys.input(cand))) === undefined) return cand;
  }
  throw new Error(`@gnldev/durable: rolloverRun could not find a free epoch name (all '${base}@N' are taken).`);
}

function parseMaybeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Type the raw tool output as AI SDK v5's `LanguageModelV2ToolResultOutput` (leave untouched if already typed).
function toTypedToolOutput(v: unknown): unknown {
  if (
    v !== null &&
    typeof v === 'object' &&
    'value' in (v as any) &&
    ['text', 'json', 'error-text', 'error-json', 'content'].includes((v as any).type)
  ) {
    return v; // already typed (e.g. coming from a period that was already normalized and carried over)
  }
  return typeof v === 'string' ? { type: 'text', value: v } : { type: 'json', value: v ?? null };
}

/** Normalizes reconstructState's output into the ModelMessage shape `generateText` accepts (pure). */
export function toModelMessages(raw: unknown[]): unknown[] {
  const toolNames = new Map<string, string>(); // toolCallId → toolName (from assistant tool-calls)
  const out: unknown[] = [];
  for (const msg of raw as any[]) {
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      out.push({
        role: 'assistant',
        content: msg.content.map((p: any) => {
          if (p?.type !== 'tool-call') return p;
          if (p.toolCallId && p.toolName) toolNames.set(p.toolCallId, p.toolName);
          return { type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: parseMaybeJson(p.input) };
        }),
      });
    } else if (msg?.role === 'tool' && Array.isArray(msg.content)) {
      out.push({
        role: 'tool',
        content: msg.content.map((p: any) =>
          p?.type === 'tool-result'
            ? {
                type: 'tool-result',
                toolCallId: p.toolCallId,
                toolName: p.toolName ?? toolNames.get(p.toolCallId) ?? 'unknown',
                output: toTypedToolOutput(p.output),
              }
            : p,
        ),
      });
    } else {
      out.push(msg); // user/system (from the seed) — as-is
    }
  }
  return out;
}

/**
 * Period handoff: carries the old run's FINAL state (`reconstructState`) into a new runId's
 * `:input` seed. Deterministic + idempotent + non-destructive:
 *
 * **Deterministic target:** a `${runId}:rollover` → `{ to, at }` marker is written to the old run
 *   via `claim`. The same old run CANNOT be handed off a SECOND time (even with a different
 *   `newRunId`) — the EXISTING target in the marker is returned. Of two concurrent rollovers, only
 *   one determines the target.
 * **Idempotent seed:** `runKeys.input(newRunId)` is written via `claim`; if the key already
 *   exists, the EXISTING seed is preserved (not overwritten), and the second call returns the same
 *   result as a no-op. This also freezes the non-deterministic `carry` (e.g. an LLM summary) exactly once.
 * **No deletion:** the old journal is untouched; trimming/purge is a separate decision (retention.ts).
 *
 * The old run's `system` (if present, from its `:input`) is carried over to the new seed exactly.
 * `journal` must provide a read surface (`readRun`) — the SQLite/Postgres/InMemory adapters provide
 * it; a journal that doesn't provide it throws a clear error. Handing off a period that has a
 * suspended tool works structurally but is not recommended — do the handoff at period close (when nothing is suspended).
 */
export async function rolloverRun(journal: Journal, runId: string, opts?: RolloverOptions): Promise<RolloverResult> {
  const readRun = (journal as Partial<JournalReader>).readRun;
  if (typeof readRun !== 'function') {
    throw new Error(
      `@gnldev/durable: rolloverRun requires 'readRun' (JournalReader) — this journal does not provide a read surface. ` +
        `Use an adapter like InMemoryJournal / SqliteStorage.runs / PostgresStorage.runs.`,
    );
  }

  // 1) Determine the target deterministically: the marker claim's winner writes the target; the loser reads the EXISTING target.
  const candidate = opts?.newRunId ?? (await pickNextRunId(journal, runId));
  let newRunId = candidate;
  if (!(await claim(journal, rolloverKey(runId), { to: candidate, at: Date.now() }))) {
    const existing = await journal.get<{ to: string }>(rolloverKey(runId));
    if (!existing?.to) throw new Error(`@gnldev/durable: the '${rolloverKey(runId)}' marker could not be read (corrupt record?).`);
    newRunId = existing.to;
  }

  // 2) If the seed already exists → no-op: report the existing seed exactly WITHOUT OVERWRITING it (idempotent second call).
  const inputKey = runKeys.input(newRunId);
  const already = await journal.get<{ messages?: unknown[] }>(inputKey);
  if (already !== undefined) {
    const msgs = Array.isArray(already.messages) ? already.messages : [];
    return { newRunId, seededMessages: msgs.length, messages: msgs };
  }

  // 3) Materialize the old run's final state (input + all model/tool steps).
  const entries = await readRun.call(journal, runId);
  // Tip genişletildi: `:input` kimlik alanlarını da taşıyor (persistInput yazıyor) ve devir onları
  // aktarmak zorunda — ReconstructSeed yalnız mesaj/sistem yeniden kurulumunu tarifliyor.
  const oldInput = upgradeFormat(
    await journal.get<
      ReconstructSeed & {
        threadId?: string;
        resourceId?: string;
        actor?: string;
        agent?: string;
        workKey?: string;
        workScope?: WorkScope;
      }
    >(runKeys.input(runId)),
    runKeys.input(runId),
  ); // H13
  if (entries.length === 0 && oldInput === undefined) {
    throw new Error(`@gnldev/durable: rolloverRun — no journal record for '${runId}' (no state found to hand over).`);
  }
  const state = reconstructState(entries, entries.length, oldInput);
  let messages = toModelMessages(state.messages);
  if (opts?.carry) messages = await opts.carry(messages);

  // 4) Write the seed via claim (the race loser discards its own result and reports the winner's seed).
  // KİMLİK DE DEVREDİLİR. Tohum yalnız `messages` (+ `system`) taşıyordu; `threadId`, `resourceId`,
  // `actor` ve `agent` düşüyordu. Sonuç kalıcı: yeni koşumun `:input`'u ilk yazan kazanır, yani
  // dönem devrinde SAHİPLİ bir koşum SAHİPSİZ doğuyor ve bir daha sahiplenilemiyor. Sahipsizlik
  // sessizce her kapıyı açar — ownershipDenied `!owner` dalında geçer, actor kilidi ateşlemez,
  // purgeResource o koşumu hiç bulamaz. Devir bir kimlik değişimi değil, aynı işin devamıdır.
  //
  // İŞİN ADI DA DEVREDİLİR (P2 alanları, paket #4). `workKey`/`workScope` aynı sebeple burada:
  // dönem devri bir işin devamıdır, yeni bir iş değil. Düşerlerse yeni dönem `listRunsPaged({workKey})`
  // sorgusundan kaybolur ve Studio'da opak bir id olarak durur — üstelik tam da adı en çok gereken
  // koşumlarda: dönem devri haftalarca yaşayan, insanın "hangisiydi bu" diye sorduğu koşumun kendisi.
  // Kapsam devri değil KOPYASI: türetilmiş id'nin dijesti eski adı zaten dondurmuş durumda; buradaki
  // kayıt o adı okunur tutar, yeniden türetme iddiası taşımaz.
  //
  // PARMAK İZİ DE TOHUMLA BİRLİKTE DOĞAR. Türetilmiş bir id'de girdi parmak izi KOŞULSUZ denetlenir
  // (§5) — ama denetim `frozen.hash` üstünden yürüyor, tohumda `hash` yoktu, ve `persistInput`
  // `:input` doluysa hiç çalışmıyor. İki doğru davranış birleşince `run1_<dijest>#2` kalıcı olarak
  // parmak izsiz kalıyordu: yeni döneme ne gönderilirse gönderilsin denetim `undefined` dalında
  // sessizce geçiyor ve bambaşka bir içerik "aynı işin devamı" diye replay ediliyordu. Eksenin en
  // korunması gereken ucu — bir işin ikinci, üçüncü dönemi — tek korumasız ucuydu.
  //
  // Formül `persistInput`'unkiyle AYNI olmak zorunda, yoksa meşru sürdürme 409 yer; o yüzden iki
  // kopya değil tek fonksiyon (`rawInputFingerprint`). Tohumun `prompt`'u yok, `messages` + `system`
  // var — devrin sözleşmesi zaten bu: yeni dönem tohumun İÇERİĞİYLE sürdürülür. Ham devirde de
  // yazılıyor: orada kapı `strictInput` opt-in'i olmadan açılmaz, yani eski davranış aynı kalır,
  // ama isteyen için artık bağlayacak bir parmak izi vardır.
  const seed = {
    messages,
    hash: rawInputFingerprint({ messages, ...(oldInput?.system !== undefined ? { system: oldInput.system } : {}) }),
    ...(oldInput?.system !== undefined ? { system: oldInput.system } : {}),
    ...(oldInput?.threadId !== undefined ? { threadId: oldInput.threadId } : {}),
    ...(oldInput?.resourceId !== undefined ? { resourceId: oldInput.resourceId } : {}),
    ...(oldInput?.actor !== undefined ? { actor: oldInput.actor } : {}),
    ...(oldInput?.agent !== undefined ? { agent: oldInput.agent } : {}),
    ...(oldInput?.workKey !== undefined ? { workKey: oldInput.workKey } : {}),
    ...(oldInput?.workScope !== undefined ? { workScope: oldInput.workScope } : {}),
  };
  if (!(await claim(journal, inputKey, stampFormat(seed as object)))) {
    const winner = await journal.get<{ messages?: unknown[] }>(inputKey);
    const msgs = Array.isArray(winner?.messages) ? winner!.messages! : [];
    return { newRunId, seededMessages: msgs.length, messages: msgs };
  }
  return { newRunId, seededMessages: messages.length, messages };
}
