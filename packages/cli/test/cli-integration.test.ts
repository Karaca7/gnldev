// End-to-end through the real plumbing: a temp gnl.config.ts on disk, loaded via the real loadConfig
// (dynamic import), driven through a command's ACTUAL Command.run() (arg parsing + --json contract).
// The fixture lives under packages/cli/test/ so bare-specifier imports inside it (@gnl/durable) resolve
// via the workspace's node_modules (a fixture placed under system /tmp would NOT resolve them).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsCommand } from '../src/commands/runs.js';
import { forkCommand } from '../src/commands/fork.js';
import { captureLog } from './helpers.js';

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFixtureConfig(): string {
  const dir = mkdtempSync(join(__dirname, '.tmp-'));
  created.push(dir);
  const cfgPath = join(dir, 'gnl.config.ts');
  writeFileSync(
    cfgPath,
    `
import { InMemoryJournal, runDurable } from '@gnl/durable';

function mkModel(doGenerate) {
  return { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate, doStream: async () => { throw new Error('no'); } };
}
function finalText(text) {
  return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
}

const journal = new InMemoryJournal();
await runDurable({ runId: 'fixture-run-1', journal, model: mkModel(async () => finalText('hello from fixture')), prompt: 'hi' });

export default { journal };
`,
  );
  return cfgPath;
}

describe('CLI integration (real loadConfig + Command.run)', () => {
  it('runsCommand.run --json lists the seeded run through the real config-loading path', async () => {
    const cfgPath = writeFixtureConfig();
    const lines = await captureLog(async () => {
      await runsCommand.run({ argv: ['--config', cfgPath, '--json'] });
    });
    const rows = JSON.parse(lines.join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe('fixture-run-1');
    expect(rows[0].status).toBe('completed');
  });

  it('forkCommand.run --json produces a new runId through the real config-loading path', async () => {
    const cfgPath = writeFixtureConfig();
    const lines = await captureLog(async () => {
      await forkCommand.run({ argv: ['fixture-run-1', '--to', 'fixture-run-1-fork', '--json', '--config', cfgPath] });
    });
    const result = JSON.parse(lines.join('\n'));
    expect(result.newRunId).toBe('fixture-run-1-fork');
    expect(result.copiedModel).toBeGreaterThan(0);
  });

  it('an unknown runId gives a clear, non-JSON-crashing error', async () => {
    const cfgPath = writeFixtureConfig();
    await expect(forkCommand.run({ argv: ['does-not-exist', '--config', cfgPath] })).rejects.toThrow(/run not found/);
  });
});
