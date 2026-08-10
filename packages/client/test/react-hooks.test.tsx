// @vitest-environment jsdom
// useGnlAgent / useChat — the entire public surface of @gnldev/client/react, previously at 0%
// coverage. These hooks are thin, but every branch they own is a place a UI silently misbehaves:
// loading stuck on after a throw, resume firing without a runId, send() posting an empty prompt,
// stream:false still streaming. A fake GnlClient drives all of it; no network, no server.
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GnlClient } from '../src/index.js';
import { useGnlAgent, useChat } from '../src/react/index.js';

type Ev = { event: string; data: unknown };

/** A GnlClient stand-in: every method records its arguments and returns what the test dictates. */
function fakeClient(over: Partial<Record<'run' | 'stream' | 'resume', any>> = {}) {
  const calls: { run: any[][]; stream: any[][]; resume: any[][] } = { run: [], stream: [], resume: [] };
  const client = {
    run: vi.fn(async (...args: any[]) => {
      calls.run.push(args);
      return over.run ? await over.run(...args) : { runId: 'run-1', text: 'hello' };
    }),
    stream: vi.fn((...args: any[]) => {
      calls.stream.push(args);
      const events: Ev[] = over.stream ?? [
        { event: 'text-delta', data: { text: 'he' } },
        { event: 'text-delta', data: { text: 'llo' } },
        { event: 'done', data: { runId: 'run-s' } },
      ];
      if (typeof events === 'function') return (events as any)(...args);
      return (async function* () {
        for (const e of events) yield e;
      })();
    }),
    resume: vi.fn(async (...args: any[]) => {
      calls.resume.push(args);
      return over.resume ? await over.resume(...args) : { runId: 'run-1', text: 'resumed', interrupts: [] };
    }),
  } as unknown as GnlClient;
  return { client, calls };
}

describe('useGnlAgent — run()', () => {
  it('appends the user message, then the assistant reply, and records the runId', async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));

    await act(async () => {
      await result.current.run({ prompt: 'hi' });
    });

    expect(result.current.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(result.current.runId).toBe('run-1');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('a run WITHOUT a prompt adds no user message (resume-style calls must not fabricate one)', async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.run({});
    });
    expect(result.current.messages).toEqual([{ role: 'assistant', content: 'hello' }]);
  });

  it('a run result carrying `error` sets error AND still applies the result (both, not either)', async () => {
    const { client } = fakeClient({ run: async () => ({ runId: 'run-e', text: 'partial', error: 'model refused' }) });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.run({ prompt: 'x' });
    });
    expect(result.current.error?.message).toBe('model refused');
    expect(result.current.runId).toBe('run-e');
    expect(result.current.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial' });
  });

  it('a THROWN client error is captured and loading is released (finally, not a stuck spinner)', async () => {
    const { client } = fakeClient({
      run: async () => {
        throw new Error('network down');
      },
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.run({ prompt: 'x' });
    });
    expect(returned).toBeUndefined();
    expect(result.current.error?.message).toBe('network down');
    expect(result.current.loading).toBe(false);
  });

  it('a non-Error rejection is wrapped into an Error (UIs render .message)', async () => {
    const { client } = fakeClient({
      run: async () => {
        throw 'plain string';
      },
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.run({ prompt: 'x' });
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('plain string');
  });
});

describe('useGnlAgent — stream()', () => {
  it('accumulates text deltas into ONE assistant message and picks up the runId from done', async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.stream({ prompt: 'hi' });
    });
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(result.current.runId).toBe('run-s');
    expect(result.current.loading).toBe(false);
  });

  it('an `error` event sets error without aborting the accumulated text', async () => {
    const { client } = fakeClient({
      stream: [
        { event: 'text-delta', data: { text: 'partial' } },
        { event: 'error', data: { error: 'upstream 429' } },
      ],
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.stream({ prompt: 'hi' });
    });
    expect(result.current.error?.message).toBe('upstream 429');
    expect(result.current.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial' });
  });

  it('a mid-stream throw is captured and loading is released', async () => {
    const { client } = fakeClient({
      stream: () =>
        (async function* () {
          yield { event: 'text-delta', data: { text: 'a' } };
          throw new Error('socket closed');
        })(),
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.stream({ prompt: 'hi' });
    });
    expect(result.current.error?.message).toBe('socket closed');
    expect(result.current.loading).toBe(false);
  });

  it('interrupts from the stream are exposed for the approval UI', async () => {
    const { client } = fakeClient({
      stream: [{ event: 'interrupt', data: { interrupts: [{ toolCallId: 'tc-1', toolName: 'refund' }] } }],
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.stream({ prompt: 'refund it' });
    });
    expect(result.current.interrupts).toEqual([{ toolCallId: 'tc-1', toolName: 'refund' }]);
  });
});

describe('useGnlAgent — resume() / reset()', () => {
  it('does NOTHING when there is no runId yet (no request, no spinner)', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.resume({ 'tc-1': true });
    });
    expect(calls.resume).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  it('resumes with the SAME runId and replays the last input (prompt/messages)', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.run({ prompt: 'refund it' });
    });
    await act(async () => {
      await result.current.resume({ 'tc-1': true });
    });
    expect(calls.resume[0]![0]).toBe('agent');
    expect(calls.resume[0]![1]).toBe('run-1'); // same run, not a new one
    expect(calls.resume[0]![2]).toEqual({ 'tc-1': true });
    expect(calls.resume[0]![3]).toMatchObject({ prompt: 'refund it' });
  });

  it('clears pending interrupts as soon as the approval is sent (no double-approve window)', async () => {
    const { client } = fakeClient({
      stream: [{ event: 'interrupt', data: { interrupts: [{ toolCallId: 'tc-1' }] } }, { event: 'done', data: { runId: 'r' } }],
    });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.stream({ prompt: 'x' });
    });
    expect(result.current.interrupts).toHaveLength(1);
    await act(async () => {
      await result.current.resume({ 'tc-1': true });
    });
    expect(result.current.interrupts).toEqual([]);
  });

  it('reset() clears messages, runId and error', async () => {
    const { client } = fakeClient({ run: async () => ({ runId: 'r', text: 't', error: 'boom' }) });
    const { result } = renderHook(() => useGnlAgent(client, 'agent'));
    await act(async () => {
      await result.current.run({ prompt: 'x' });
    });
    act(() => result.current.reset());
    expect(result.current.messages).toEqual([]);
    expect(result.current.runId).toBeUndefined();
    expect(result.current.error).toBeNull();
  });
});

describe('useChat', () => {
  it('send() streams by default and clears the input box', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useChat(client, 'agent'));
    act(() => result.current.setInput('hi'));
    await act(async () => {
      await result.current.send();
    });
    expect(calls.stream).toHaveLength(1);
    expect(calls.run).toHaveLength(0);
    expect(result.current.input).toBe('');
    expect(result.current.messages.at(-1)?.role).toBe('assistant');
  });

  it('stream:false uses the one-shot run path instead', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useChat(client, 'agent', { stream: false }));
    act(() => result.current.setInput('hi'));
    await act(async () => {
      await result.current.send();
    });
    expect(calls.run).toHaveLength(1);
    expect(calls.stream).toHaveLength(0);
  });

  it('an empty or whitespace-only input sends nothing', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useChat(client, 'agent'));
    await act(async () => {
      await result.current.send();
    });
    act(() => result.current.setInput('   '));
    await act(async () => {
      await result.current.send();
    });
    expect(calls.stream).toHaveLength(0);
  });

  it('the prompt is trimmed and threadId/resourceId ride along', async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useChat(client, 'agent', { threadId: 'th-1', resourceId: 'res-1' }));
    act(() => result.current.setInput('  hi  '));
    await act(async () => {
      await result.current.send();
    });
    expect(calls.stream[0]![1]).toEqual({ prompt: 'hi', threadId: 'th-1', resourceId: 'res-1' });
  });

  it('approve() resumes the run with a single toolCallId decision', async () => {
    const { client, calls } = fakeClient({
      stream: [{ event: 'interrupt', data: { interrupts: [{ toolCallId: 'tc-9' }] } }, { event: 'done', data: { runId: 'r9' } }],
    });
    const { result } = renderHook(() => useChat(client, 'agent'));
    act(() => result.current.setInput('refund'));
    await act(async () => {
      await result.current.send();
    });
    await act(async () => {
      await result.current.approve('tc-9', false);
    });
    expect(calls.resume[0]![2]).toEqual({ 'tc-9': false });
  });

  it('reset() is wired through to the underlying agent', async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useChat(client, 'agent'));
    act(() => result.current.setInput('hi'));
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.messages).toEqual([]));
  });
});
