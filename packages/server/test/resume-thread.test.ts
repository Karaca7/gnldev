// POST /agents/:name/resume must put the approved turn back into the conversation.
//
// A resume is self-contained: the client sends a runId and approvals, and the prompt is read back out
// of the journal's `:input` record. The threadId is frozen into that same record and was the one field
// not read back. runDurable appends a finished turn only when `memory && threadId` are both present,
// so the registry's memory had a thread history to READ from and none to write to.
//
// The result is a conversation with a hole in it exactly where a human made a decision. Measured
// against this endpoint:
//
//   POST /run    {prompt: 'charge 5000', threadId: 'th'}   → suspended, thread ['user']
//   POST /resume {approvals: {c1: true}}                   → 200 "Charged.", thread STILL ['user']
//
// The charge happened. The assistant said so. The conversation remembers only that someone asked. On
// the next turn the model is handed a thread in which no charge was ever made and no answer was ever
// given — for a money-shaped tool, the setup for doing it again. Nothing errors; the reply is returned
// on the wire, so the caller sees a healthy 200 and the loss shows up one turn later as the model
// behaving as though it had amnesia.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

/** Suspends on the first step (a tool call), answers on the second. */
function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => ((prompt ?? []).filter((m: any) => m.role === 'tool').length === 0
      ? {
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: JSON.stringify({ amount: 5000 }) }],
        finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [],
      }
      : {
        content: [{ type: 'text', text: 'Charged.' }],
        finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [],
      }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

/** The two Memory methods this path uses, and a handle on what actually landed. */
function fakeMemory() {
  const threads = new Map<string, { role: string }[]>();
  return {
    threads,
    memory: {
      getMessages: async (t: string) => threads.get(t) ?? [],
      append: async (t: string, msgs: { role: string }[]) => {
        threads.set(t, [...(threads.get(t) ?? []), ...msgs]);
      },
    },
  };
}

function mkApi(memory: unknown) {
  return createRestApi({
    journal: new InMemoryJournal(),
    memory,
    allowOpenAccess: true,
    agents: {
      a: {
        model: mkModel(),
        tools: {
          charge: {
            description: 'charge a card',
            inputSchema: z.object({ amount: z.number() }),
            execute: async () => ({ ok: true }),
          },
        },
        guard: async () => ({ action: 'require-approval' as const, reason: 'big amount' }),
      },
    },
  } as never);
}

const post = (api: any, path: string, body: unknown) =>
  call(api, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /agents/:name/resume and the conversation thread', () => {
  it('appends the approved turn to the thread the run started on', async () => {
    const { threads, memory } = fakeMemory();
    const api = mkApi(memory);

    const started = await (await post(api, '/agents/a/run', { runId: 'r1', prompt: 'charge 5000', threadId: 'th' })).json();
    expect(started.interrupts).toHaveLength(1);
    // Only the user's message so far — a suspended turn is deliberately not appended.
    expect(threads.get('th')?.map((m) => m.role)).toEqual(['user']);

    const resumed = await (await post(api, '/agents/a/resume', { runId: 'r1', approvals: { c1: true } })).json();
    expect(resumed.text).toBe('Charged.');

    const roles = threads.get('th')?.map((m) => m.role) ?? [];
    expect(roles, 'the approved turn never reached the thread — the client got the answer, the conversation did not')
      .toContain('assistant');
  });

  it('a run started with NO threadId resumes exactly as before', async () => {
    // The threadId is forwarded only when the run recorded one, so a caller who never used threads
    // gains no writes and no new failure mode.
    const { threads, memory } = fakeMemory();
    const api = mkApi(memory);

    await post(api, '/agents/a/run', { runId: 'r2', prompt: 'charge 5000' });
    const resumed = await (await post(api, '/agents/a/resume', { runId: 'r2', approvals: { c1: true } })).json();

    expect(resumed.text).toBe('Charged.');
    expect(threads.size, 'a threadless run wrote to a thread').toBe(0);
  });
});
