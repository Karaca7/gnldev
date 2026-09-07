// @gnldev/client: run/listAgents with mock fetch, split-frame SSE stream, pure accumulator.
import { describe, it, expect } from 'vitest';
import { GnlClient, GnlHttpError, applyStreamEvent, appendUserMessage, initialChatState, parseSSEStream } from '../src/index.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('GnlClient core', () => {
  it('run → correct URL/method/body, returns parsed JSON', async () => {
    const calls: any[] = [];
    const mockFetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true, runId: 'r1', text: 'hi', interrupts: [] });
    }) as unknown as typeof fetch;

    const client = new GnlClient({ baseUrl: 'http://x/', fetch: mockFetch });
    const r = await client.run('chat', { runId: 'r1', prompt: 'hi there' });
    expect(r.text).toBe('hi');
    expect(calls[0].url).toBe('http://x/agents/chat/run');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ runId: 'r1', prompt: 'hi there' });
  });

  it('generates a runId when not given', async () => {
    const calls: any[] = [];
    const mockFetch = (async (_u: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({ runId: 'x', interrupts: [] });
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: mockFetch });
    await client.run('chat', { prompt: 'hi' });
    expect(typeof calls[0].runId).toBe('string');
    expect(calls[0].runId.length).toBeGreaterThan(0);
  });

  it('listAgents → GET /agents', async () => {
    const mockFetch = (async (url: any) => {
      expect(String(url)).toBe('http://x/agents');
      return jsonResponse([{ name: 'chat', model: 'custom', hasTools: false, maxSteps: 4 }]);
    }) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: mockFetch });
    const agents = await client.listAgents();
    expect(agents[0].name).toBe('chat');
  });

  it('stream → split-frame SSE is parsed correctly (text + interrupt + done)', async () => {
    const mockFetch = (async () =>
      sseResponse([
        'event: text-delta\ndata: {"text":"Hel"}\n\nevent: text-d',
        'elta\ndata: {"text":"lo"}\n\nevent: interrupt\ndata: {"interrupts":[{"toolCallId":"c1","toolName":"x","args":{}}]}\n\nevent: done\ndata: {"runId":"r1"}\n\n',
      ])) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: mockFetch });

    const events: any[] = [];
    for await (const ev of client.stream('chat', { runId: 'r1', prompt: 'hi' })) events.push(ev);

    const text = events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('');
    expect(text).toBe('Hello');
    expect(events.find((e) => e.event === 'interrupt')?.data.interrupts).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ event: 'done', data: { runId: 'r1' } });
  });

  it('streamTo → handler callbacks are called', async () => {
    const mockFetch = (async () =>
      sseResponse(['event: text-delta\ndata: {"text":"A"}\n\nevent: done\ndata: {"runId":"r2"}\n\n'])) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: mockFetch });
    let text = '';
    let doneId = '';
    const { runId } = await client.streamTo('chat', { runId: 'r2', prompt: 'hi' }, {
      onText: (t) => (text += t),
      onDone: (d) => (doneId = d.runId),
    });
    expect(text).toBe('A');
    expect(doneId).toBe('r2');
    expect(runId).toBe('r2');
  });

  it('a failed stream reports its STATUS, whether or not it had a body', async () => {
    // This asserted `/no stream body/` while the only guard was `!res.body`. A 500 has a status worth
    // reporting and an empty body is the least interesting thing about it; now the status check runs
    // first and the emptiness is incidental. `!res.body` still guards the genuinely strange case — a
    // 2xx that carries nothing — which is a protocol violation rather than a refusal.
    const mockFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const client = new GnlClient({ baseUrl: 'http://x', fetch: mockFetch });
    let thrown: any = null;
    try { for await (const _ of client.stream('chat', { prompt: 'hi' })) void _; } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(GnlHttpError);
    expect(thrown.status).toBe(500);
    expect(String(thrown.message), 'an empty body left the error with nothing to say').toContain('500');
  });
});

describe('parseSSEStream', () => {
  it('skips empty/partial frames', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: a\ndata: {"v":1}\n\n\n\n'));
        c.close();
      },
    });
    const out: any[] = [];
    for await (const ev of parseSSEStream(body)) out.push(ev);
    expect(out).toEqual([{ event: 'a', data: { v: 1 } }]);
  });
});

describe('accumulator (pure reducer)', () => {
  it('appendUserMessage + text-delta accumulation + interrupt + done', () => {
    let s = appendUserMessage(initialChatState, 'hi');
    s = applyStreamEvent(s, { event: 'text-delta', data: { text: 'Hel' } });
    s = applyStreamEvent(s, { event: 'text-delta', data: { text: 'lo' } });
    s = applyStreamEvent(s, { event: 'interrupt', data: { interrupts: [{ toolCallId: 'c1', toolName: 'x', args: {} }] as any } });
    s = applyStreamEvent(s, { event: 'done', data: { runId: 'r9' } });
    expect(s.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(s.interrupts).toHaveLength(1);
    expect(s.runId).toBe('r9');
  });

  // P0.1: reasoning deltas used to be silently dropped by the reducer (default case).
  it('P0.1: reasoning-delta accumulates on the assistant message next to the answer text', () => {
    let s = appendUserMessage(initialChatState, 'hi');
    s = applyStreamEvent(s, { event: 'reasoning-delta', data: { id: 'rs1', text: 'Think… ' } });
    s = applyStreamEvent(s, { event: 'reasoning-delta', data: { id: 'rs1', text: 'ok.' } });
    s = applyStreamEvent(s, { event: 'text-delta', data: { text: 'Answer' } });
    expect(s.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Answer', reasoning: 'Think… ok.' },
    ]);
  });
});

/**
 * A refusal is a response too — the client has to READ it, not only its body.
 *
 * `run`/`resume` were `(await res.json()) as RunResult`: a cast, not a check. A refusal arrives as
 * `{error, code, detail}` with no `runId`, so the cast asserted a required `string` that was
 * `undefined` — a caller passing it back to `resume()` passed nothing, with the types agreeing. And
 * `stream()`'s only guard was `!res.body`, which a JSON error body passes: fed to the SSE frame parser
 * it produced no frames and threw nothing, so a UI stopped its spinner over an unchanged screen.
 */
describe('a non-2xx response reaches the caller', () => {
  const REFUSAL = {
    error: 'runId "r1" was started for thread "A" and is now being run for thread "B"',
    code: 'run_thread_mismatch',
    detail: { runId: 'r1', startedForThread: 'A', requestedThread: 'B' },
  };
  const refuse = (status: number, headers: Record<string, string> = {}) => async () =>
    new Response(JSON.stringify(REFUSAL), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('stream() throws a typed error instead of yielding nothing', async () => {
    const client = new GnlClient({ baseUrl: 'http://x', fetch: refuse(409) as never });
    const seen: unknown[] = [];
    let thrown: any = null;
    try {
      for await (const ev of client.stream('bot', { runId: 'r1' })) seen.push(ev);
    } catch (e) { thrown = e; }

    // Measured before: 0 events AND nothing thrown — indistinguishable from a stream that simply ended.
    expect(thrown, 'a refusal ended the stream silently').not.toBeNull();
    expect(thrown).toBeInstanceOf(GnlHttpError);
    expect(thrown.status).toBe(409);
    expect(thrown.code, 'the caller still has to parse the sentence').toBe('run_thread_mismatch');
    expect(thrown.detail).toEqual(REFUSAL.detail);
    expect(seen, 'a refusal produced events').toEqual([]);
  });

  it('run() keeps its promise about runId, and says which refusal it was', async () => {
    const client = new GnlClient({ baseUrl: 'http://x', fetch: refuse(429, { 'retry-after': '7' }) as never });
    const r = await client.run('bot', { runId: 'r1' });

    // The type says `runId: string`. The server omits it from every error body; the client knows it.
    expect(r.runId, 'the declared-required runId came back undefined').toBe('r1');
    expect(r.status).toBe(429);
    expect(r.code).toBe('run_thread_mismatch');
    expect(r.retryAfter, 'the server named a wait and it was dropped').toBe(7);
    expect(Array.isArray(r.interrupts), 'interrupts is declared as an array').toBe(true);
  });

  it('a successful response is unchanged — no refusal fields invented', async () => {
    const ok = async () => new Response(JSON.stringify({ ok: true, runId: 'r1', text: 'hello', interrupts: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const client = new GnlClient({ baseUrl: 'http://x', fetch: ok as never });
    expect(await client.run('bot', { runId: 'r1' })).toEqual({ ok: true, runId: 'r1', text: 'hello', interrupts: [] });
  });

  it('a non-JSON error body still produces a usable error', async () => {
    const html = async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const client = new GnlClient({ baseUrl: 'http://x', fetch: html as never });
    let thrown: any = null;
    try { for await (const _ of client.stream('bot', { runId: 'r1' })) { /* drain */ } } catch (e) { thrown = e; }
    expect(thrown, 'a proxy error page was swallowed').toBeInstanceOf(GnlHttpError);
    expect(thrown.status).toBe(502);
    expect(thrown.code, 'a code was invented for a body that had none').toBeUndefined();
    expect(String(thrown.message)).toContain('502');
  });
});
