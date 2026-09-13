// Package #3 of `docs/RUNID-WORKKEY-HEYET-KARARI.md`: the declaration becomes BINDING.
//
// Package #1 minted the identity (`workDigest`/`derivedRunId`) and package #2 taught the journal to
// carry the declared name. Both were deliberately inert: a `workKey` was written down and obeyed by
// nothing. This file is where it starts deciding. Four doors mint run ids — `run`, `stream`,
// `runWorkflow`, `runNetwork` — and from here on a caller hands each of them EITHER a raw `runId` or
// a `workKey`, never both, and the engine derives the id from the second.
//
// What is pinned here, in the order the decision argues it:
//
//   THE PROMISE. Same workKey, same person, same agent → one run. The second call replays instead of
//   paying twice. That sentence is the whole product, and it is the first test.
//
//   THE ADDRESS IS PART OF THE NAME (§3, §6). A workKey is unique WITHIN a scope, so the same string
//   from two people is two jobs — the digest hashes the agent, the scope kind and the scope value
//   alongside the key. Two of those three are easy to forget; each has a test.
//
//   THE TYPE PREFIX (a micro-decision this package makes, flagged as such). §3 requires `agentName` in
//   the tuple. A registry may hold an agent and a workflow under the SAME name — `pay` the agent and
//   `pay` the pipeline — and a bare name would collide them on one digest. So the tuple's first
//   element is the TYPE-PREFIXED name (`agent:pay`, `wf:pay`, `net:pay`), which is the same alphabet
//   the engine already uses for its composite ids (§7's exception row).
//
//   FAIL-CLOSED ON A MISSING ADDRESS (§6). `'resource'` scope with nobody to scope to is not a wider
//   scope, it is an unanswered question, and xid's fail-open posture does not transfer: xid losing a
//   question costs a question, a workKey losing its address delivers the work to the wrong door.
//
//   THE CORE OWNS THE OWNERSHIP CHECK (§6, condition 2b). The counter-advocate's silent scenario is
//   the org-scope one: a wrongly-declared `'org'` gives two tenants ONE digest, and tenant B is handed
//   tenant A's answer while all three HTTP gates watch it happen. The check therefore lives in
//   `assertRunAdmissible`, which every door goes through, including the embedded (server-less) one.
//
//   STRICT INPUT IS NOT OPTIONAL IN `run1_` (§5, condition 4). Inside the derived namespace the digest
//   IS the claim about what the work is, so the same name arriving with different content is refused
//   whether or not the caller asked for the check — and the refusal speaks the caller's language,
//   because "use a fresh runId" is advice about an id the caller never chose.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { derivedRunId } from '../src/hash.js';
import { runKeys } from '../src/journal.js';
import { readRunOutcome } from '../src/outcome.js';
import { RunInputMismatchError, RunOwnerMismatchError, CALLER_CONFLICT_CODES } from '../src/errors.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const text = (t = 'bitti') => createMockModel(async () => finalTextResult(t));

/** A model that calls `charge` once and then answers — the shape that makes a duplicate VISIBLE. */
function chargingModel() {
  return createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-charge', {}) : finalTextResult('charged'));
}

function chargeTool(counter: { n: number }) {
  return tool({
    description: 'charge the card',
    inputSchema: z.object({}),
    execute: async () => { counter.n++; return { ok: true }; },
  });
}

/** A one-step text stream, with a call counter — the stream half of "did it run again?". */
function streamModel(counter: { n: number }, t = 'akan cevap'): any {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  return {
    specificationVersion: 'v4', provider: 'mock', modelId: 'mock-stream', supportedUrls: {},
    doGenerate: async () => { throw new Error('this mock is stream-only'); },
    doStream: async () => {
      counter.n++;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: '1' });
            c.enqueue({ type: 'text-delta', id: '1', delta: t });
            c.enqueue({ type: 'text-end', id: '1' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            c.close();
          },
        }),
      };
    },
  };
}

/** The smallest thing that satisfies `WorkflowLike` — one step, journalled by the registry. */
function countingWorkflow(counter: { n: number }) {
  return {
    build: () => [{ id: 'only' }],
    run: async (input: unknown, ctx: { runId: string; journal: InMemoryJournal }) => {
      const key = `${ctx.runId}:wf:only`;
      const existing = await ctx.journal.get(key);
      if (existing !== undefined) return existing;
      counter.n++;
      const out = { done: true, input };
      await ctx.journal.put(key, out);
      return out;
    },
  };
}

describe('workKey — the gate (package #3)', () => {
  it('the same workKey from the same person names ONE run: the second call replays, the charge fires once', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const gnl = createGnl({
      journal,
      agents: { pay: { model: chargingModel(), tools: { charge: chargeTool(charges) }, maxSteps: 4 } },
    });
    const call = () => gnl.run('pay', { prompt: 'faturayı kes', workKey: 'invoice-4471', resourceId: 'u-ayse' });
    const first = await call();
    const second = await call();
    expect(first.text).toBe('charged');
    expect(second.text).toBe('charged');
    expect(charges.n).toBe(1); // the point of the whole feature

    // …and the run it landed in is the one the formula names, carrying its declaration.
    const id = derivedRunId('agent:pay', 'resource', 'u-ayse', 'invoice-4471');
    const input = await journal.get<Record<string, unknown>>(runKeys.input(id));
    expect(input?.workKey).toBe('invoice-4471');
    expect(input?.workScope).toEqual({ kind: 'resource', value: 'u-ayse' });
    expect(input?.resourceId).toBe('u-ayse');
  });

  it('two people, one workKey: two runs — the address is part of the name', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const gnl = createGnl({
      journal,
      agents: { pay: { model: chargingModel(), tools: { charge: chargeTool(charges) }, maxSteps: 4 } },
    });
    await gnl.run('pay', { prompt: 'kes', workKey: 'invoice-4471', resourceId: 'u-ayse' });
    await gnl.run('pay', { prompt: 'kes', workKey: 'invoice-4471', resourceId: 'u-mehmet' });
    expect(charges.n).toBe(2); // two jobs, deliberately — Ayşe's invoice is not Mehmet's
    const ayse = derivedRunId('agent:pay', 'resource', 'u-ayse', 'invoice-4471');
    const mehmet = derivedRunId('agent:pay', 'resource', 'u-mehmet', 'invoice-4471');
    expect(ayse).not.toBe(mehmet);
    expect((await journal.get<Record<string, unknown>>(runKeys.input(ayse)))?.resourceId).toBe('u-ayse');
    expect((await journal.get<Record<string, unknown>>(runKeys.input(mehmet)))?.resourceId).toBe('u-mehmet');
  });

  it('two agents, one workKey → two runs; and an AGENT and a WORKFLOW of the same name do not collide', async () => {
    const journal = new InMemoryJournal();
    const wfRuns = { n: 0 };
    const gnl = createGnl({
      journal,
      agents: { pay: { model: text('a') }, refund: { model: text('b') } },
      workflows: { pay: countingWorkflow(wfRuns) as never },
    });
    await gnl.run('pay', { prompt: 'x', workKey: 'job-1', resourceId: 'u-ayse' });
    await gnl.run('refund', { prompt: 'x', workKey: 'job-1', resourceId: 'u-ayse' });
    const r = await gnl.runWorkflow('pay', { a: 1 }, { workKey: 'job-1', resourceId: 'u-ayse' });

    const agentPay = derivedRunId('agent:pay', 'resource', 'u-ayse', 'job-1');
    const agentRefund = derivedRunId('agent:refund', 'resource', 'u-ayse', 'job-1');
    const wfPay = derivedRunId('wf:pay', 'resource', 'u-ayse', 'job-1');
    expect(new Set([agentPay, agentRefund, wfPay]).size).toBe(3);
    expect(r.runId).toBe(wfPay);
    for (const id of [agentPay, agentRefund, wfPay]) {
      expect(await journal.get(runKeys.input(id))).toBeDefined();
    }
    // The workflow's own record carries the declaration too (the identity claim, not a frozen prompt).
    const wfInput = await journal.get<Record<string, unknown>>(runKeys.input(wfPay));
    expect(wfInput?.workKey).toBe('job-1');
    expect(wfInput?.workScope).toEqual({ kind: 'resource', value: 'u-ayse' });
    // …and a second call with the same workKey lands on the same run: the step is not re-run.
    await gnl.runWorkflow('pay', { a: 1 }, { workKey: 'job-1', resourceId: 'u-ayse' });
    expect(wfRuns.n).toBe(1);
  });

  it('a runId AND a workKey together is refused: one identity, one declaration', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { pay: { model: text() } } });
    await expect(
      gnl.run('pay', { prompt: 'x', runId: 'order-123', workKey: 'invoice-4471', resourceId: 'u-ayse' }),
    ).rejects.toThrow(/one identity, one declaration/);
    await expect(
      gnl.stream('pay', { prompt: 'x', runId: 'order-123', workKey: 'invoice-4471', resourceId: 'u-ayse' }),
    ).rejects.toThrow(/one identity, one declaration/);
  });

  it('NEITHER half is refused on the agent and network doors, and still generates a loud id on runWorkflow', async () => {
    const journal = new InMemoryJournal();
    const wfRuns = { n: 0 };
    const gnl = createGnl({
      journal,
      agents: { pay: { model: text() } },
      networks: { triage: { router: text('{"action":"final","answer":"ok"}'), agents: ['pay'] } },
      workflows: { nightly: countingWorkflow(wfRuns) as never },
    });
    await expect(gnl.run('pay', { prompt: 'x' })).rejects.toThrow(/needs an identity/);
    await expect(gnl.stream('pay', { prompt: 'x' })).rejects.toThrow(/needs an identity/);
    await expect(gnl.runNetwork('triage', { task: 'x' })).rejects.toThrow(/needs an identity/);
    // The workflow door keeps its anonymous fallback verbatim — a loud generated id, and the warning
    // that says a retry of this call will not dedupe. Package #3 adds a third option, it removes none.
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      const r = await gnl.runWorkflow('nightly', { a: 1 });
      expect(r.runId).toMatch(/^wf-nightly-/);
    } finally { console.warn = orig; }
    expect(warns.join('\n')).toMatch(/without a runId/);
  });

  it('the ownership gate is the ENGINE\'s, not the registry\'s — and it leaves raw ids alone', async () => {
    // The same refusal reached through `runDurable` directly: an embedded host, a batch worker and the
    // CLI never touch the registry, and §6 puts the check where all of them pass.
    const journal = new InMemoryJournal();
    const id = derivedRunId('agent:x', 'org', '~deployment', 'k-1');
    await runDurable({ journal, runId: id, model: text('sahibin cevabı'), prompt: 'iş', resourceId: 'u-a' } as never);
    await expect(
      runDurable({ journal, runId: id, model: text(), prompt: 'iş', resourceId: 'u-b' } as never),
    ).rejects.toThrow(RunOwnerMismatchError);
    // …and a RAW id keeps today's behaviour: the caller named it, and hosts legitimately hand a run
    // between subjects under their own rules. No new refusal outside `run1_`.
    await runDurable({ journal, runId: 'order-9', model: text('cevap'), prompt: 'iş', resourceId: 'u-a' } as never);
    const other = await runDurable({ journal, runId: 'order-9', model: text(), prompt: 'iş', resourceId: 'u-b' } as never);
    expect(other.text).toBe('cevap');
  });

  it("'resource' scope with no resourceId is refused — sealed or not (fail-closed, §6)", async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { pay: { model: text() } } });
    // (a) nothing at all
    await expect(gnl.run('pay', { prompt: 'x', workKey: 'invoice-4471' })).rejects.toThrow(/workScope/);
    // (b) a SEALED context that carries an authenticated thread but no subject — the seal is the
    //     trusted channel, and it saying nothing is still nothing.
    const sealed = sealRequestContext({}, { threadId: 't-1' });
    await expect(gnl.run('pay', { prompt: 'x', workKey: 'invoice-4471', context: sealed })).rejects.toThrow(/workScope/);
    // (c) and the positive control: a SEALED resourceId satisfies it, and it is the sealed value that
    //     lands in the digest — a body-supplied one may not choose the address.
    const journal = new InMemoryJournal();
    const gnl2 = createGnl({ journal, agents: { pay: { model: text() } } });
    await gnl2.run('pay', {
      prompt: 'x', workKey: 'invoice-4471', resourceId: 'u-mallory',
      context: sealRequestContext({}, { resourceId: 'u-ayse' }),
    });
    expect(await journal.get(runKeys.input(derivedRunId('agent:pay', 'resource', 'u-ayse', 'invoice-4471')))).toBeDefined();
    expect(await journal.get(runKeys.input(derivedRunId('agent:pay', 'resource', 'u-mallory', 'invoice-4471')))).toBeUndefined();
  });

  it("'org' scope on an org-less installation uses the '~deployment' sentinel, and SAYS so in the record", async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: { nightly: { model: text('mutabakat bitti'), workScope: 'org' } },
    });
    await gnl.run('nightly', { prompt: 'mutabakat', workKey: 'recon-2026-09-12', resourceId: 'u-ayse' });
    const id = derivedRunId('agent:nightly', 'org', '~deployment', 'recon-2026-09-12');
    const input = await journal.get<Record<string, unknown>>(runKeys.input(id));
    expect(input?.workScope).toEqual({ kind: 'org', value: '~deployment' });
  });

  it('the core refuses a derived run to a DIFFERENT owner (409), and the victim keeps their outcome', async () => {
    // The counter-advocate's silent scenario, made loud: `workScope: 'org'` chosen wrongly means both
    // tenants derive ONE id. Without this gate, B replays A's answer.
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { nightly: { model: text('A için cevap'), workScope: 'org' } } });
    await gnl.run('nightly', { prompt: 'rapor', workKey: 'recon-1', resourceId: 'u-a' });
    const id = derivedRunId('agent:nightly', 'org', '~deployment', 'recon-1');
    expect((await readRunOutcome(journal, id))?.status).toBe('completed');

    await expect(
      gnl.run('nightly', { prompt: 'rapor', workKey: 'recon-1', resourceId: 'u-b' }),
    ).rejects.toThrow(RunOwnerMismatchError);
    // A refusal is not a run failure: B's rejection must not rewrite A's finished history.
    expect((await readRunOutcome(journal, id))?.status).toBe('completed');
    expect(CALLER_CONFLICT_CODES.RunOwnerMismatchError).toBe('run_owner_mismatch');
  });

  it('inside run1_ the input fingerprint runs WITHOUT strictInput, and the refusal speaks workKey', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { pay: { model: text() } } });
    await gnl.run('pay', { prompt: 'ilk iş', workKey: 'invoice-4471', resourceId: 'u-ayse' });
    // No `strictInput` anywhere: not on the call, not on a preset. In this namespace it is not a flag.
    const err = await gnl.run('pay', { prompt: 'BAŞKA bir iş', workKey: 'invoice-4471', resourceId: 'u-ayse' })
      .then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(RunInputMismatchError);
    expect(String(err.message)).toMatch(/workKey/);
    expect(String(err.message)).not.toMatch(/fresh runId/);
  });

  it('REGRESSION: on a raw runId strictInput stays opt-in — the same second call just replays', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { pay: { model: text('cevap') } } });
    await gnl.run('pay', { prompt: 'ilk iş', runId: 'order-123', resourceId: 'u-ayse' });
    const second = await gnl.run('pay', { prompt: 'BAŞKA bir iş', runId: 'order-123', resourceId: 'u-ayse' });
    expect(second.text).toBe('cevap');
  });

  it('stream() derives the same way, and the second call does not hit the model again', async () => {
    const journal = new InMemoryJournal();
    const calls = { n: 0 };
    const gnl = createGnl({ journal, agents: { talk: { model: streamModel(calls) } } });
    const opts = { prompt: 'anlat', workKey: 'brief-9', resourceId: 'u-ayse' };
    await (await gnl.stream('talk', opts)).text;
    await (await gnl.stream('talk', opts)).text;
    expect(calls.n).toBe(1);
    const id = derivedRunId('agent:talk', 'resource', 'u-ayse', 'brief-9');
    expect((await journal.get<Record<string, unknown>>(runKeys.input(id)))?.workKey).toBe('brief-9');
  });

  it('runNetwork derives under the net: prefix and records the declaration', async () => {
    const journal = new InMemoryJournal();
    const router = createMockModel(async () => finalTextResult(JSON.stringify({ action: 'final', answer: 'tamam' })));
    const gnl = createGnl({
      journal,
      agents: { pay: { model: text() } },
      networks: { triage: { router, agents: ['pay'] } },
    });
    await gnl.runNetwork('triage', { task: 'bak', workKey: 'ticket-7', resourceId: 'u-ayse' });
    const id = derivedRunId('net:triage', 'resource', 'u-ayse', 'ticket-7');
    const input = await journal.get<Record<string, unknown>>(runKeys.input(id));
    expect(input?.workKey).toBe('ticket-7');
    expect(input?.network).toBe('triage');
  });
});
