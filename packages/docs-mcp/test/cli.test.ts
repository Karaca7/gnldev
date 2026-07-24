// REAL process test: starts src/cli.ts as a child process, sends a newline-delimited JSON-RPC
// sequence over stdio (initialize -> tools/list -> tools/call x3), and verifies the responses
// line by line. Fetch is fully disabled via GNL_DOCS_OFFLINE=1 — tests are network-independent/
// deterministic.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const cliScript = join(here, '..', 'src', 'cli.ts');

interface RpcClient {
  send(msg: unknown): void;
  /** Writes a raw line (JSON.stringify is NOT applied) — for deliberately sending malformed JSON. */
  sendRaw(line: string): void;
  next(): Promise<any>;
  close(): void;
}

function startCli(): RpcClient {
  const child = spawn(tsxBin, [cliScript], {
    env: { ...process.env, GNL_DOCS_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: child.stdout, terminal: false });
  const pending: any[] = [];
  const waiters: Array<(v: any) => void> = [];

  rl.on('line', (line: string) => {
    const parsed = JSON.parse(line);
    const w = waiters.shift();
    if (w) w(parsed);
    else pending.push(parsed);
  });

  return {
    send(msg: unknown) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    sendRaw(line: string) {
      child.stdin.write(line + '\n');
    },
    next() {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

describe('gnl-docs-mcp — real stdio process', () => {
  it('initialize -> tools/list -> tools/call (overview/feature/search) sequence responds correctly', async () => {
    const client = startCli();
    try {
      client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const init = await client.next();
      expect(init.result.protocolVersion).toBe('2024-11-05');
      expect(init.result.serverInfo.name).toBe('gnl-docs-mcp');

      // notification — NO response expected
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await client.next();
      expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(
        ['gnl_docs_feature', 'gnl_docs_overview', 'gnl_docs_search'].sort(),
      );

      client.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'gnl_docs_overview', arguments: {} },
      });
      const overview = await client.next();
      expect(overview.result.content[0].text).toContain('# GNL');
      expect(overview.result.content[0].text).toContain('Features (25)');

      client.send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'gnl_docs_feature', arguments: { slug: 'deterministic-replay' } },
      });
      const feature = await client.next();
      expect(feature.result.content[0].text).toContain('Deterministic replay');

      client.send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'gnl_docs_search', arguments: { query: 'workflow' } },
      });
      const search = await client.next();
      expect(search.result.content[0].text.toLowerCase()).toContain('workflow');

      client.send({ jsonrpc: '2.0', id: 6, method: 'foo/unknown' });
      const unknown = await client.next();
      expect(unknown.error.code).toBe(-32601);
    } finally {
      client.close();
    }
  }, 20_000);

  it('returns a -32700 parse error for an invalid JSON line', async () => {
    const client = startCli();
    try {
      client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await client.next();

      client.sendRaw('{ this is invalid json');
      const res = await client.next();
      expect(res.error.code).toBe(-32700);
    } finally {
      client.close();
    }
  }, 20_000);
});
