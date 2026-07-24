// REAL process test: runs src/cli.ts (via tsx, same pattern as packages/docs-mcp/test/cli.test.ts —
// no build step required) with real argv, asserts on real stdout/stderr/exit code. Covers dispatch-only
// concerns that don't belong in a single command's unit test: --version, --help grouping, unknown
// command + "did you mean" suggestion, exit codes.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const cliScript = join(here, '..', 'src', 'cli.ts');

function runCli(args: string[]) {
  const res = spawnSync(tsxBin, [cliScript, ...args], { encoding: 'utf8' });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe('gnl cli dispatch (real process)', () => {
  it('--version prints the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    const { stdout, status } = runCli(['--version']);
    expect(stdout.trim()).toBe(pkg.version);
    expect(status).toBe(0);
  });

  it('--help lists commands grouped as Project/Inspect/Operate, and only real commands', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Project:');
    expect(stdout).toContain('Inspect:');
    expect(stdout).toContain('Operate:');
    for (const name of ['init', 'dev', 'studio', 'runs', 'run', 'inspect', 'fork', 'resume', 'sweep', 'rm']) {
      expect(stdout).toContain(`gnl ${name}`);
    }
  });

  it('help <command> shows that command usage', () => {
    const { stdout, status } = runCli(['help', 'fork']);
    expect(status).toBe(0);
    expect(stdout).toContain('gnl fork <runId>');
  });

  it('an unknown command exits 1 with a "did you mean" suggestion', () => {
    const { stderr, status } = runCli(['sweeep']);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown command 'sweeep'");
    expect(stderr).toContain("did you mean 'sweep'");
  });

  it('a command failure (missing required arg) exits 1 with a clear stderr message', () => {
    const { stderr, status } = runCli(['run']);
    expect(status).toBe(1);
    expect(stderr).toContain('runId required');
  });
});
