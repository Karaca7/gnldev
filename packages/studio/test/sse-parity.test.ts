// The playground stream and the REST stream promise one schema — @gnldev/client connects to either.
// They were two implementations kept "in sync" by comment, and the playground's copy fell behind: it
// sent the internal `__gnl_limit_exceeded` sentinel to the browser as a tool result and ended a limit
// breach with `done`. Both now write @gnldev/durable's agentStreamEvents; this feeds the SAME part
// sequences to both and requires the same events, so a surface that stops using the shared source
// fails here.
import { it, expect } from 'vitest';
import { Hono } from 'hono';
import { pipeAgentStream as studioPipe } from '../src/sse.js';
import { pipeAgentStream as serverPipe } from '../../server/src/sse.js';

const call = { type: 'tool-call', toolCallId: 't1', toolName: 'charge', input: {} };
const limit = { __gnl_limit_exceeded: { kind: 'maxToolCalls', message: 'limit hit' } };
const blocked = { __gnl_blocked: { code: 'RunBusyError', message: 'busy' } };
const CASES: Record<string, { parts: any[]; steps: any[] }> = {
  plain: { parts: [{ type: 'text-delta', text: 'hi' }], steps: [] },
  limit: {
    parts: [call, { type: 'tool-result', toolCallId: 't1', toolName: 'charge', output: limit }],
    steps: [{ content: [{ type: 'tool-result', toolCallId: 't1', output: limit }] }],
  },
  blocked: {
    parts: [call, { type: 'tool-result', toolCallId: 't1', toolName: 'charge', output: blocked }],
    steps: [{ content: [{ type: 'tool-result', toolCallId: 't1', output: blocked }] }],
  },
  toolError: { parts: [call, { type: 'tool-error', toolCallId: 't1', toolName: 'charge', error: new Error('503') }], steps: [] },
  unknown: { parts: [{ type: 'some-future-part', payload: 'secret' }], steps: [] },
};

async function wire(pipe: any, c: { parts: any[]; steps: any[] }): Promise<string> {
  const app = new Hono();
  app.get('/', (ctx) => pipe(ctx, 'r1', {
    fullStream: (async function* () { yield* c.parts; })(),
    steps: Promise.resolve(c.steps),
    finishReason: Promise.resolve('stop'),
    usage: Promise.resolve({}),
  }));
  const body = await (await app.request('/')).text();
  // `id:` lines are the server's resumable-SSE addition; the schema is event + data.
  return body.split('\n').filter((l) => l.startsWith('event:') || l.startsWith('data:')).join('\n');
}

for (const [name, c] of Object.entries(CASES)) {
  it(`the playground and REST streams send the same events: ${name}`, async () => {
    expect(await wire(studioPipe, c)).toBe(await wire(serverPipe, c));
  });
}

it('a limit breach reaches the browser as a typed error, never as the internal sentinel', async () => {
  const body = await wire(studioPipe, CASES.limit);
  expect(body).not.toContain('__gnl_limit_exceeded');
  expect(body).toContain('run_limit_exceeded');
  expect(body).not.toContain('event: done');
});
