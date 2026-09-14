// The four questions `gnl init` asks, and every way of not being asked them.
//
// The DECISION is a pure function (resolveAnswers) and the SCAFFOLD is a pure function of the answers,
// so the whole thing is testable without a terminal — which matters more here than usual, because the
// failure this suite exists to prevent is a prompt opening where no human is watching. A CI job or an
// agent that meets an interactive picker does not fail; it hangs until something kills it, and the
// output says nothing about why.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scaffold } from '../src/scaffold.js';
import {
  DEFAULT_ANSWERS, QUESTIONS, resolveAnswers, readLastAnswers, writeLastAnswers, answersPath,
  type InitAnswers,
} from '../src/init-answers.js';

const created: string[] = [];
afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const base = mkdtempSync(join(tmpdir(), 'gnl-init-'));
  created.push(base);
  return base;
}

/** Scaffolds with the given answers and hands back the generated config. */
function configFor(answers: Partial<InitAnswers>): string {
  const dir = join(tmp(), 'app');
  scaffold(dir, { answers: { ...DEFAULT_ANSWERS, ...answers } });
  return readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
}

describe('the questions themselves', () => {
  it('there are exactly four, and each one has a flag named after it', () => {
    // The count is the contract. A fifth question is a different product decision, and it should cost
    // somebody a red test and a paragraph rather than a quiet commit. (It went 3 → 4 once, for
    // `serving`: the argument is written at the top of init-answers.ts, which is the paragraph this
    // test exists to demand.)
    expect(QUESTIONS).toHaveLength(4);
    expect(QUESTIONS.map((q) => q.id)).toEqual(['preset', 'identity', 'store', 'serving']);
    for (const q of QUESTIONS) expect(q.flag, `${q.id} must be answerable non-interactively`).toBe(q.id);
  });

  it('every option describes a situation, not the name of the setting it sets', () => {
    // A label that says "assistant" is answerable only by somebody who already knows what the three
    // profiles do — which is the one person who does not need to be asked.
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        expect(o.label.toLowerCase(), `${q.id}/${o.id}: the label is just the value`).not.toBe(o.id);
        expect(o.hint, `${q.id}/${o.id} has no hint`).toBeTruthy();
      }
    }
  });
});

describe('resolveAnswers', () => {
  it('with no flags: every question is pending and every answer is the default', () => {
    const r = resolveAnswers({});
    expect(r.answers).toEqual(DEFAULT_ANSWERS);
    expect(r.pending).toHaveLength(4);
    expect(Object.values(r.from)).toEqual(['default', 'default', 'default', 'default']);
  });

  it('a flag ANSWERS its question — so that question is no longer pending', () => {
    const r = resolveAnswers({ preset: 'critical' });
    expect(r.answers.preset).toBe('critical');
    expect(r.from.preset).toBe('flag');
    expect(r.pending.map((q) => q.id)).toEqual(['identity', 'store', 'serving']);
  });

  it('all four flags leave nothing to ask', () => {
    const r = resolveAnswers({ preset: 'headless', identity: 'end-users', store: 'pg', serving: 'own' });
    expect(r.pending).toEqual([]);
    expect(r.answers).toEqual({ preset: 'headless', identity: 'end-users', store: 'pg', serving: 'own' });
  });

  it('a misspelled flag throws, and the message lists what was allowed', () => {
    // `--preset critcal` must not quietly produce a project with no critical protections at all.
    expect(() => resolveAnswers({ preset: 'critcal' })).toThrow(/assistant \| headless \| critical/);
  });

  it('remembered answers are a BASE that flags still outrank', () => {
    const last: InitAnswers = { preset: 'critical', identity: 'end-users', store: 'pg', serving: 'own' };
    const r = resolveAnswers({ store: 'sqlite' }, last, 'last');
    expect(r.answers).toEqual({ preset: 'critical', identity: 'end-users', store: 'sqlite', serving: 'own' });
    expect(r.from).toEqual({ preset: 'last', identity: 'last', store: 'flag', serving: 'last' });
  });
});

describe('remembering the last answers', () => {
  let home: string;
  beforeEach(() => { home = tmp(); process.env.GNL_HOME = home; });
  afterEach(() => { delete process.env.GNL_HOME; });

  it('round-trips', () => {
    const answers: InitAnswers = { preset: 'headless', identity: 'end-users', store: 'pg', serving: 'mount' };
    writeLastAnswers(answers);
    expect(readLastAnswers()).toEqual(answers);
  });

  it('absent → undefined, so the gate simply does not offer the option', () => {
    expect(readLastAnswers()).toBeUndefined();
  });

  it('corrupt → undefined, never a crash', () => {
    mkdirSync(dirname(answersPath()), { recursive: true });
    writeFileSync(answersPath(), 'not json at all');
    expect(readLastAnswers()).toBeUndefined();
  });

  it('a value this version does not recognise → undefined, not a project built on it', () => {
    // Written by a later version that grew a fourth preset. The shortcut is worth less than a
    // scaffold configured with a word this build cannot honour.
    mkdirSync(dirname(answersPath()), { recursive: true });
    writeFileSync(answersPath(), JSON.stringify({ preset: 'paranoid', identity: 'internal', store: 'sqlite' }));
    expect(readLastAnswers()).toBeUndefined();
  });
});

describe('each answer lands as a line in the generated config', () => {
  it('preset: the answer IS the profile', () => {
    for (const preset of ['assistant', 'headless', 'critical'] as const) {
      expect(configFor({ preset })).toContain(`preset: '${preset}',`);
    }
  });

  it('store: sqlite writes a file, pg reads DATABASE_URL and never defaults it', () => {
    const sqlite = configFor({ store: 'sqlite' });
    expect(sqlite).toContain("new SqliteStorage('runs.db')");
    expect(sqlite).not.toContain('PostgresStorage');

    const pg = configFor({ store: 'pg' });
    expect(pg).toContain("import { PostgresStorage } from '@gnldev/durable/postgres';");
    expect(pg).toContain('process.env.DATABASE_URL!');
    // A journal that silently falls back to a local file is a journal you find empty in production.
    expect(pg).not.toContain('SqliteStorage');
  });

  it('identity: both answers are DECLARED, because unstated and deliberate are different states', () => {
    expect(configFor({ identity: 'internal' })).toContain("subjects: 'internal',");
    expect(configFor({ identity: 'end-users' })).toContain("subjects: 'end-users',");
  });

  it("the internal config says what the trade actually is", () => {
    const cfg = configFor({ identity: 'internal' });
    expect(cfg).toMatch(/refuse nobody/);
    expect(cfg).toContain("'end-users'"); // and how to change it later
  });
});

describe('the end-users answer writes a file, and only a file', () => {
  it('src/identity.ts appears, with the one wrong answer refused out loud', () => {
    const dir = join(tmp(), 'app');
    scaffold(dir, { answers: { ...DEFAULT_ANSWERS, identity: 'end-users' } });
    const file = readFileSync(join(dir, 'src', 'identity.ts'), 'utf8');
    expect(file).toMatch(/NEVER/);
    expect(file).toMatch(/request body/i);
    expect(file).toMatch(/session cookie|JWT|principalOf/);
    // Erasure, which is the concrete payoff of runs being born with an owner.
    expect(file).toContain('purgeResource');
  });

  it('and the internal answer writes no such file', () => {
    const dir = join(tmp(), 'app');
    const res = scaffold(dir, { answers: { ...DEFAULT_ANSWERS, identity: 'internal' } });
    expect(res.files).not.toContain(join('src', 'identity.ts'));
  });

  it('THE IRON RULE: an answer adds a config line or a new file — it never forks an existing one', () => {
    // The rule this whole design rests on (init-answers.ts). Measured directly: scaffold every
    // combination of answers and compare the files that are not gnl.config.ts. `templates/full` was a
    // five-file fork that drifted in three separate places; a question that produces two versions of
    // src/model.ts is the same shape, arriving one answer at a time.
    const combos: InitAnswers[] = [];
    for (const preset of ['assistant', 'critical'] as const) {
      for (const identity of ['internal', 'end-users'] as const) {
        for (const store of ['sqlite', 'pg'] as const) combos.push({ preset, identity, store });
      }
    }
    const baseline = new Map<string, string>();
    const forked: string[] = [];
    for (const answers of combos) {
      const dir = join(tmp(), 'app');
      const res = scaffold(dir, { answers });
      for (const rel of res.files) {
        if (rel === 'gnl.config.ts') continue;              // the config is where lines are allowed
        if (rel === join('src', 'identity.ts')) continue;    // a NEW file, also allowed
        const text = readFileSync(join(dir, rel), 'utf8');
        const seen = baseline.get(rel);
        if (seen === undefined) baseline.set(rel, text);
        else if (seen !== text) forked.push(`${rel} (differs under ${JSON.stringify(answers)})`);
      }
    }
    expect(baseline.size, 'no files were compared — this test would pass vacuously').toBeGreaterThan(3);
    expect(forked,
      'an answer produced a second version of a file that already existed. That is the template matrix '
      + 'growing back: express it as a config line, or as a new file, or do not ask the question.').toEqual([]);
  });
});

describe('the feature and host questions are gone from init', () => {
  it('a plain answered scaffold carries no recipe files', () => {
    const dir = join(tmp(), 'app');
    const res = scaffold(dir, { answers: DEFAULT_ANSWERS });
    // The charge tool is base (every project shows the framework's point), so what must be absent
    // here is what was never asked for: an optional recipe, and a host server file.
    for (const rel of [join('src', 'tools', 'rag.ts'), join('src', 'memory.ts'), join('src', 'server.ts')]) {
      expect(res.files, `${rel} arrived without being asked for`).not.toContain(rel);
    }
  });

  it('but features still compose ON TOP of the answers', () => {
    // The flags are orthogonal: choosing a profile must not cost you the ability to pick features.
    const dir = join(tmp(), 'app');
    const res = scaffold(dir, { answers: { ...DEFAULT_ANSWERS, preset: 'critical' }, features: ['rag'] });
    expect(res.files).toContain(join('src', 'tools', 'rag.ts'));
    expect(readFileSync(join(dir, 'gnl.config.ts'), 'utf8')).toContain("preset: 'critical',");
  });
});

// ── the part that has to be driven as a real process ─────────────────────────

const cliRoot = join(import.meta.dirname, '..');
const cliBin = join(cliRoot, 'dist', 'cli.js');

/** Runs `gnl init` with stdin NOT a TTY — the CI/agent shape. */
function runInit(args: string[], cwd: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [cliBin, 'init', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, GNL_HOME: join(cwd, '.gnl-home') },
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string };
    if (err.signal === 'SIGTERM') throw new Error('gnl init HUNG — it opened a prompt with no TTY');
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.runIf(existsSync(cliBin))('gnl init without a terminal', () => {
  it('completes rather than waiting for a keypress', () => {
    const cwd = tmp();
    const { status, out } = runInit(['app'], cwd);
    expect(status, out).toBe(0);
    expect(out).toContain('created');
    expect(readFileSync(join(cwd, 'app', 'gnl.config.ts'), 'utf8')).toContain("preset: 'assistant',");
  }, 70_000);

  it('honours the flags it was given, and says how many decisions were made', () => {
    const cwd = tmp();
    const { status, out } = runInit(['app', '--preset', 'critical', '--store', 'pg'], cwd);
    expect(status, out).toBe(0);
    const cfg = readFileSync(join(cwd, 'app', 'gnl.config.ts'), 'utf8');
    expect(cfg).toContain("preset: 'critical',");
    expect(cfg).toContain('PostgresStorage');
    expect(out).toMatch(/answered 2 of 4/);
  }, 70_000);

  it('prints the protections matrix it DERIVES from the config it just wrote', () => {
    // Not a hand-written "everything is fine" list. The rows come from describeProtections reading
    // the generated file, which is the only way the summary can be wrong in a visible way.
    const cwd = tmp();
    const { out } = runInit(['app', '--preset', 'critical'], cwd);
    expect(out).toContain('what is protecting it');
    expect(out).toMatch(/dedup profile/);
    expect(out).toMatch(/critical/);
    // And the closing reminder that features are additive, now that init no longer asks.
    expect(out).toContain('gnl add');
  }, 70_000);

  it('refuses a misspelled answer instead of scaffolding an unprotected project', () => {
    const cwd = tmp();
    const { status, out } = runInit(['app', '--preset', 'critcal'], cwd);
    expect(status).toBe(1);
    expect(out).toMatch(/assistant \| headless \| critical/);
    expect(existsSync(join(cwd, 'app')), 'a rejected run must not leave a half-project behind').toBe(false);
  }, 70_000);

  it('remembers the answers for next time', () => {
    const cwd = tmp();
    runInit(['app', '--preset', 'headless', '--identity', 'end-users'], cwd);
    const remembered = JSON.parse(readFileSync(join(cwd, '.gnl-home', 'init-answers.json'), 'utf8'));
    expect(remembered).toEqual({ preset: 'headless', identity: 'end-users', store: 'sqlite', serving: 'dev' });
  }, 70_000);
});
