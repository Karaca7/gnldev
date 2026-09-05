// @gnldev/client/react — useGnlAgent / useChat. NO JSX (pure logic hooks) → compiled with tsc.
import { useCallback, useRef, useState } from 'react';
import type { GnlClient } from '../index.js';
import { appendUserMessage, applyRunResult, applyStreamEvent, initialChatState } from '../accumulator.js';
import type { ChatMessage, ChatState } from '../accumulator.js';
import type { Interrupt, RunInput, RunResult } from '../types.js';

export interface UseGnlAgent {
  messages: ChatMessage[];
  interrupts: Interrupt[];
  loading: boolean;
  error: Error | null;
  runId: string | undefined;
  /** One-shot durable run. */
  run(input: RunInput): Promise<RunResult | undefined>;
  /** Streaming run (SSE) — accumulates text into messages. */
  stream(input: RunInput): Promise<void>;
  /** Resume the last run with approvals (same runId). */
  resume(approvals: Record<string, boolean>): Promise<void>;
  reset(): void;
}

export function useGnlAgent(client: GnlClient, name: string): UseGnlAgent {
  const [state, setState] = useState<ChatState>(initialChatState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lastInput = useRef<RunInput>({});

  const run = useCallback(
    async (input: RunInput) => {
      setLoading(true);
      setError(null);
      if (input.prompt) setState((s) => appendUserMessage(s, input.prompt!));
      lastInput.current = input;
      try {
        const r = await client.run(name, input);
        if (r.error) setError(new Error(r.error));
        setState((s) => applyRunResult(s, r));
        return r;
      } catch (e: any) {
        setError(e instanceof Error ? e : new Error(String(e)));
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [client, name],
  );

  const stream = useCallback(
    async (input: RunInput) => {
      setLoading(true);
      setError(null);
      if (input.prompt) setState((s) => appendUserMessage(s, input.prompt!));
      lastInput.current = input;
      try {
        for await (const ev of client.stream(name, input)) {
          setState((s) => applyStreamEvent(s, ev));
          if (ev.event === 'error') setError(new Error((ev.data as any).error));
        }
      } catch (e: any) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    },
    [client, name],
  );

  const resume = useCallback(
    async (approvals: Record<string, boolean>) => {
      const runId = state.runId;
      if (!runId) return;
      setLoading(true);
      setError(null);
      setState((s) => ({ ...s, interrupts: [] }));
      try {
        const r = await client.resume(name, runId, approvals, {
          prompt: lastInput.current.prompt,
          messages: lastInput.current.messages,
        });
        if (r.error) setError(new Error(r.error));
        setState((s) => applyRunResult(s, r));
      } catch (e: any) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    },
    [client, name, state.runId],
  );

  const reset = useCallback(() => {
    setState(initialChatState);
    setError(null);
  }, []);

  return { messages: state.messages, interrupts: state.interrupts, loading, error, runId: state.runId, run, stream, resume, reset };
}

export interface UseChat {
  messages: ChatMessage[];
  input: string;
  setInput(v: string): void;
  send(): Promise<void>;
  loading: boolean;
  error: Error | null;
  interrupts: Interrupt[];
  approve(toolCallId: string, ok: boolean): Promise<void>;
  reset(): void;
}

export interface UseChatOptions {
  /** Default true: streaming (SSE). false → one-shot run. */
  stream?: boolean;
  threadId?: string;
  resourceId?: string;
}

export function useChat(client: GnlClient, name: string, opts: UseChatOptions = {}): UseChat {
  const agent = useGnlAgent(client, name);
  const [input, setInput] = useState('');
  const useStream = opts.stream ?? true;

  const send = useCallback(async () => {
    // UX dedup, NEVER correctness (heyet sınırı): a double-click while a turn is in flight is
    // Swallowed client-side; the authority remains the server lock + journal claims.
    if (agent.loading) return;
    const prompt = input.trim();
    if (!prompt) return;
    setInput('');
    const payload: RunInput = { prompt, threadId: opts.threadId, resourceId: opts.resourceId };
    if (useStream) await agent.stream(payload);
    else await agent.run(payload);
  }, [agent, input, useStream, opts.threadId, opts.resourceId]);

  const approve = useCallback(
    async (toolCallId: string, ok: boolean) => {
      await agent.resume({ [toolCallId]: ok });
    },
    [agent],
  );

  return {
    messages: agent.messages,
    input,
    setInput,
    send,
    loading: agent.loading,
    error: agent.error,
    interrupts: agent.interrupts,
    approve,
    reset: agent.reset,
  };
}

export type { ChatMessage, ChatState } from '../accumulator.js';
