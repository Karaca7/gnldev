// AUDIT FINDINGS — round 12, finding #26 (audit-log.md): every `cli.ts` in the monorepo sat at 0%.
//
// `gnl chat` is a REPL, so most of it needs a terminal — but the parts that DECIDE things before the
// prompt appears do not, and that is where the gap bit: round 11's #24 (a runId that renames its own
// keyspace) is reachable from here, because `--session` flows straight into the runId.
//
// Driven as a SUBPROCESS. Coverage cannot see subprocess work, so these lines still report 0% in a
// coverage run; that is a property of the tool (docs-mcp/test/cli.test.ts has the same shape).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const CLI = join(__dirname, '..', 'dist', 'cli', 'chat.js');
const run = (...args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status ?? 1 };
  }
};

// These tests drive `dist/`, and no `test` script rebuilds it. A stale build silently turns them
// into a test of yesterday's source; a MISSING build makes `execFileSync` throw ENOENT, which the
// helper maps to exit code 1 — the very code several assertions below expect. Both failures must
// announce themselves rather than pass or lie.
beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`pnpm build\` in this package first.`);
  const newestIn = (dir: string): number => {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
      const p = join(dir, e.name);
      return Math.max(max, e.isDirectory() ? newestIn(p) : statSync(p).mtimeMs);
    }, 0);
  };
  const srcMs = newestIn(join(__dirname, '..', 'src'));
  const builtMs = statSync(CLI).mtimeMs;
  if (srcMs > builtMs) {
    throw new Error(`src is newer than ${CLI} by ${Math.round((srcMs - builtMs) / 60000)} min — run \`pnpm build\`; these tests measure the build, not the working tree.`);
  }
});

describe('gnl chat entry point', () => {
  it('--help prints usage and exits cleanly', () => {
    const r = run('--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('gnl chat');
    expect(r.out).toContain('Usage:');
    for (const flag of ['--provider', '--model', '--db', '--session']) {
      expect(r.out, `${flag} is accepted but undocumented`).toContain(flag);
    }
  });

  // The help text names the defaults. Nothing kept it honest, and a help screen that names a model
  // the code does not use sends the reader to configure something that was never the problem.
  it('the default model IDs in --help are the ones the code actually uses', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli', 'chat.ts'), 'utf8');
    const line = /const modelId = args\.model \?\? \(provider === 'openai' \? '([^']+)' : '([^']+)'\)/.exec(src);
    expect(line, 'the default-model expression changed shape — update this test with it').toBeTruthy();
    const [, openaiDefault, anthropicDefault] = line!;
    const help = run('--help').out;
    expect(help, `help must name the anthropic default '${anthropicDefault}'`).toContain(anthropicDefault!);
    expect(help, `help must name the openai default '${openaiDefault}'`).toContain(openaiDefault!);
  });

  it('the default provider in --help matches the code', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli', 'chat.ts'), 'utf8');
    const m = /const provider = args\.provider \?\? '([^']+)'/.exec(src);
    expect(m).toBeTruthy();
    expect(run('--help').out).toContain(`default: ${m![1]}`);
  });

  // The provider SDKs are optional peers, so which branch is correct depends on the environment.
  // Both are pinned; what must never happen is the third outcome — exiting 0 having started nothing.
  it('an absent provider package is reported and exits non-zero; a present one starts', async () => {
    const installed = await import('@ai-sdk/anthropic').then(() => true).catch(() => false);
    const r = run();                                   // defaults → provider 'anthropic'
    if (installed) {
      expect(r.out, 'a started session announces itself').toContain('gnl chat ·');
    } else {
      expect(r.code, 'exiting 0 would leave the caller believing a session started').toBe(1);
      expect(r.out).toContain('is not installed');
      expect(r.out, 'the message must name the package to install').toContain('@ai-sdk/anthropic');
    }
  });

});
