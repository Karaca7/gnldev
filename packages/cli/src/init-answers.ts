// The three questions `gnl init` is allowed to ask, and the rule that keeps them three.
//
// THE IRON RULE — read this before adding a fourth.
//
//   A question may add a CONFIG LINE, or a NEW FILE. A question that FORKS AN EXISTING FILE is
//   forbidden.
//
// Not a style preference. A question that changes what an existing file contains multiplies the
// matrix: two options on one file is two versions of that file to keep correct, and the second
// version is the one that rots, because nobody generates it by hand while developing. This repository
// paid for that lesson twice over — `templates/full` was a five-file fork of `templates/minimal` that
// drifted in the `.env` line, the finish-reason shape and a commented-out identifier, each discovered
// separately and none by anybody reading the fork. It is retired now (scaffold.ts's
// RETIRED_TEMPLATES), and this rule is what stops it growing back one question at a time.
//
// The rule has one deliberate exception, and it is not a question: the charge-tool feature replaces
// `src/model.ts`, because the base template's mock cannot emit a tool call. See scaffold.ts, where
// that exception is argued in place.
//
// WHY THESE THREE AND NOT OTHERS. Each one decides something a project CANNOT DISCOVER BY READING ITS
// OWN CODE, and cannot change later without rework:
//
//   preset    — a tool's `effectClass` is read ONLY through a profile. Pick the wrong one and every
//               declaration in the project is inert, silently.
//   identity  — whether runs are born with an owner. Retrofitting a subject onto a live journal means
//               backfilling ownership for records that never had one.
//   store     — sqlite and postgres are one line apart on day one and a migration on day ninety.
//
// Features and hosts are NOT here any more, on purpose. They are additive (`gnl add <feature>`,
// `gnl add host`), a project that skipped them loses nothing, and asking about them at minute zero
// asks people to choose between names they have not met yet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type PresetAnswer = 'assistant' | 'headless' | 'critical';
export type IdentityAnswer = 'internal' | 'end-users';
export type StoreAnswer = 'sqlite' | 'pg';

export interface InitAnswers {
  preset: PresetAnswer;
  identity: IdentityAnswer;
  store: StoreAnswer;
}

/**
 * What "Recommended" means, spelled out rather than implied.
 *
 * `identity: 'internal'` is the one worth defending. The alternative default — assume end users —
 * writes an identity skeleton into every scaffold including the ones that are a single-operator
 * script, and an unused skeleton teaches people to delete generated files without reading them. So
 * the default is the smaller claim, and it is ANNOUNCED: the protections matrix carries an explicit
 * `○ identity` row saying runs are born ownerless, rather than the `?` an unstated config gets.
 * Unowned-and-said-so is a position; unowned-and-unmentioned is the bug this row exists to end.
 */
export const DEFAULT_ANSWERS: InitAnswers = { preset: 'assistant', identity: 'internal', store: 'sqlite' };

export interface AnswerOption<T extends string> {
  id: T;
  /** What the reader recognises about their own situation — never the name of the setting. */
  label: string;
  hint: string;
}

export interface Question<T extends string> {
  /** Matches the key in InitAnswers, and the `--<flag>` that skips this question. */
  id: keyof InitAnswers;
  flag: string;
  title: string;
  options: readonly AnswerOption<T>[];
}

/**
 * The questions, as data.
 *
 * Every option's label describes a SITUATION, not a setting: "a person is waiting on screen" rather
 * than "assistant". Somebody at minute zero knows which of those is true of them and does not yet
 * know what the three profile names mean — and a question you cannot answer is a question you answer
 * by pressing Enter, which makes asking it worse than not asking.
 */
export const PRESET_QUESTION: Question<PresetAnswer> = {
  id: 'preset',
  flag: 'preset',
  title: 'Who sets this work going?',
  options: [
    { id: 'assistant', label: 'A person, on a screen, waiting for the answer', hint: 'a repeat can be turned into a question' },
    { id: 'headless', label: 'A scheduler or a queue — nobody is watching', hint: 'nobody to ask, so a repeated payment is refused outright' },
    { id: 'critical', label: 'Money or stock moves, and a double is unacceptable', hint: 'the above, plus a run lock, input fingerprinting, tombstones' },
  ],
};

export const IDENTITY_QUESTION: Question<IdentityAnswer> = {
  id: 'identity',
  flag: 'identity',
  title: 'Whose runs are these?',
  options: [
    { id: 'internal', label: 'Mine — an internal tool, one operator', hint: 'runs are born ownerless, and the matrix says so' },
    { id: 'end-users', label: 'My users have accounts, and their data must stay apart', hint: 'writes src/identity.ts + the route wiring' },
  ],
};

export const STORE_QUESTION: Question<StoreAnswer> = {
  id: 'store',
  flag: 'store',
  title: 'Where does the journal live?',
  options: [
    { id: 'sqlite', label: 'A file next to the project', hint: 'runs.db — nothing to install' },
    { id: 'pg', label: 'Postgres', hint: 'reads DATABASE_URL; needs `pnpm add pg`' },
  ],
};

export const QUESTIONS = [PRESET_QUESTION, IDENTITY_QUESTION, STORE_QUESTION] as const;

/** How the gate question's three doors are labelled. `last` is offered only when there are last answers. */
export type GateChoice = 'recommended' | 'customize' | 'last';

/** Where a single answer came from — drives the closing summary and nothing else. */
export type AnswerSource = 'default' | 'flag' | 'asked' | 'last';

export interface ResolvedAnswers {
  answers: InitAnswers;
  /** Per-field provenance, so the summary can say "you chose" and "left as it was" honestly. */
  from: Record<keyof InitAnswers, AnswerSource>;
  /** The questions still unanswered after flags — what an interactive run would ask. */
  pending: readonly Question<string>[];
}

/** Flag values, already read off argv. `undefined` = the flag was not given. */
export type AnswerFlags = Partial<Record<keyof InitAnswers, string | undefined>>;

/**
 * Flags first, then whatever a caller supplies — a pure function, so the whole decision is testable
 * without a terminal.
 *
 * A FLAG SILENCES ITS QUESTION. That is the contract that makes this scriptable: `--preset critical`
 * means the run never stops to ask about the profile, whether or not anything else is asked. Which is
 * also why the flags are named after the questions and not after the config fields they end up in.
 */
export function resolveAnswers(flags: AnswerFlags = {}, base: InitAnswers = DEFAULT_ANSWERS, baseSource: AnswerSource = 'default'): ResolvedAnswers {
  const answers = { ...base };
  const from = { preset: baseSource, identity: baseSource, store: baseSource } as Record<keyof InitAnswers, AnswerSource>;
  const pending: Question<string>[] = [];
  for (const q of QUESTIONS) {
    const given = flags[q.id];
    if (given === undefined) { pending.push(q as Question<string>); continue; }
    const match = q.options.find((o) => o.id === given);
    if (!match) {
      throw new Error(
        `gnl init: --${q.flag} '${given}' is not one of ${q.options.map((o) => o.id).join(' | ')}`,
      );
    }
    (answers as Record<string, string>)[q.id] = match.id;
    from[q.id] = 'flag';
  }
  return { answers, from, pending };
}

// ── remembering the last answers ─────────────────────────────────────────────

/**
 * Where the last answers are kept.
 *
 * `GNL_HOME` first so tests (and anybody with an unusual setup) can point it somewhere else — without
 * it, a test of this file writes into the developer's real home directory, which is both rude and a
 * source of tests that pass because of what a previous run left behind.
 */
export function answersPath(): string {
  return join(process.env.GNL_HOME ?? join(homedir(), '.gnl'), 'init-answers.json');
}

/**
 * The last answers, or undefined.
 *
 * EVERY failure is undefined, deliberately. This file is a convenience; a corrupt one, an unreadable
 * one, or one written by a future version with a value this version does not recognise must all mean
 * "no shortcut to offer" and never "cannot create a project". Validated field by field against the
 * questions themselves, so an unknown value cannot reach the scaffold.
 */
export function readLastAnswers(): InitAnswers | undefined {
  try {
    const raw = JSON.parse(readFileSync(answersPath(), 'utf8')) as Record<string, unknown>;
    const out = { ...DEFAULT_ANSWERS };
    for (const q of QUESTIONS) {
      const v = raw[q.id];
      if (!q.options.some((o) => o.id === v)) return undefined;
      (out as Record<string, string>)[q.id] = v as string;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Best-effort: a project that was created successfully must not fail on the way out. */
export function writeLastAnswers(answers: InitAnswers): void {
  try {
    const p = answersPath();
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(answers, null, 2) + '\n');
  } catch {
    // Nothing to say. The project exists; remembering was the bonus.
  }
}
