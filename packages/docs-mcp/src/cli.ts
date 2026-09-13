#!/usr/bin/env node
// stdio entry point (bin: gnl-docs-mcp) — newline-delimited JSON-RPC 2.0 transport: reads stdin
// line by line, hands each line to handleMessage, and writes non-notification responses to
// stdout as a SINGLE line of JSON. No dependency beyond node:readline + process (no SDK).
//
// Lines are processed IN ARRIVAL ORDER (queued) — so that while a tools/call (which may involve
// a fetch) is still in flight, the next line doesn't get written to stdout first; MCP clients
// already match by id, but sequential processing is simpler/more deterministic.
import { createInterface } from 'node:readline';
import { ERR_PARSE, makeError, parseLine, serializeResponse } from './protocol.js';
import { createDocsProvider, handleMessage } from './server.js';

function main(): void {
  const provider = createDocsProvider(process.env);
  const rl = createInterface({ input: process.stdin, terminal: false });

  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line: string) => {
    queue = queue.then(async () => {
      const msg = parseLine(line);
      if (msg === null) {
        if (line.trim() === '') return; // blank line is skipped silently
        process.stdout.write(serializeResponse(makeError(null, ERR_PARSE, 'Parse error: invalid JSON')) + '\n');
        return;
      }
      const res = await handleMessage(provider, msg);
      if (res !== null) process.stdout.write(serializeResponse(res) + '\n');
    });
  });

  rl.on('close', () => process.exit(0));
}

main();
