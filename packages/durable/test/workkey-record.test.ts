// Package #2 of `docs/RUNID-WORKKEY-HEYET-KARARI.md`: the journal learns to CARRY a workKey.
//
// Package #1 minted the identity (`workDigest`/`derivedRunId`) and reserved the `run1_`/`#` space.
// Nothing derived a runId from a workKey then and nothing does now — no call path ACCEPTS one yet
// (that is package #3, the registry gate). What this package buys is the storage side of §1: the
// declared name is "a first-class, queryable field in the `:input` record", so the moment the gate
// opens there is already somewhere to put the answer and a way to ask for it back.
//
// Three properties are pinned here, and each one is a promise the later packages will lean on:
//
//   (a) THE FIELD SURVIVES THE ROUND TRIP, on every adapter. `RunSummary.workKey` is derived the same
//       way `agent`/`resourceId` are — out of the invisible `:input` entry, inside the read the
//       adapter already does — and the in-memory, SQLite, Postgres and Redis paths derive it by four
//       genuinely different mechanisms. Only a shared test proves they agree (the resourceId
//       conformance case says the same thing, for the same reason).
//
//   (b) FIRST WRITER WINS. `:input` is claim-shaped: the run's name is fixed by whoever started it.
//       A second call cannot rename the work under an id that already exists — that is the same
//       first-wins rule threadId/agent/resourceId/actor already live under, and package #3's
//       conflict axes are only meaningful if the recorded name is stable.
//
//   (c) THE TOMBSTONE KEEPS A HASH, NEVER THE TEXT (§10.3). A swept run leaves `${runId}:swept`
//       behind, and that marker outlives the erasure — under `tombstonePolicy: 'reject'` it is
//       effectively permanent. Writing the workKey into it would mean a deletion that keeps the
//       caller's business string forever, which is the one thing a deletion may not do. The hash is
//       enough for the diagnosis it exists for, and `run_swept` reflects the workKey from the
//       REQUEST rather than from storage (packages #3/#5 — not this file).
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import {
  InMemoryJournal, InMemoryStorage, RedisStorage, runKeys, stampFormat, sweepRuns, purgeRun, purgeResource,
  toJournal, workKeyHash,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import { claimIdentityInput } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';
import type { Storage } from '../src/index.js';

const HOUR = 60 * 60 * 1000;
const model = () => createMockModel(async () => finalTextResult('bitti'));

describe('workKey — the record (package #2)', () => {
  it('persistInput freezes workKey + workScope into `:input`, and listRunsPaged finds the run by it', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      journal, runId: 'wk-1', model: model(), prompt: 'fatura kes',
      agentName: 'muhasebe', workKey: 'invoice-4471', workScope: { kind: 'resource', value: 'u-ayse' },
      resourceId: 'u-ayse',
    } as never);
    const input = await journal.get<Record<string, unknown>>(runKeys.input('wk-1'));
    expect(input?.workKey).toBe('invoice-4471');
    expect(input?.workScope).toEqual({ kind: 'resource', value: 'u-ayse' });

    const page = await journal.listRunsPaged({ workKey: 'invoice-4471' });
    expect(page.items.map((r) => r.runId)).toEqual(['wk-1']);
    expect(page.items[0]!.workKey).toBe('invoice-4471');
    // …and the filter is an EXACT match, not a prefix (`invoice-4` must not answer for `invoice-4471`).
    expect((await journal.listRunsPaged({ workKey: 'invoice-4' })).items).toEqual([]);
  });

  it('a run started without a workKey has NO such field — absent, not empty', async () => {
    // The `...(x ? {x} : {})` spelling matters to every reader that asks `'workKey' in record`:
    // an explicit `undefined` would answer yes and turn "this caller never declared a name" into
    // "this caller declared nothing", which are different facts about the same run.
    const journal = new InMemoryJournal();
    await runDurable({ journal, runId: 'wk-plain', model: model(), prompt: 'selam' } as never);
    const input = await journal.get<Record<string, unknown>>(runKeys.input('wk-plain'));
    expect('workKey' in (input ?? {})).toBe(false);
    expect('workScope' in (input ?? {})).toBe(false);
    const page = await journal.listRunsPaged();
    expect(page.items.find((r) => r.runId === 'wk-plain')!.workKey).toBeUndefined();
  });

  it('FIRST WRITER WINS: a second call cannot rename the work under an existing runId', async () => {
    const journal = new InMemoryJournal();
    const base = { journal, runId: 'wk-first', model: model(), prompt: 'aynı iş', agentName: 'muhasebe' };
    await runDurable({ ...base, workKey: 'invoice-4471' } as never);
    await runDurable({ ...base, workKey: 'invoice-9999' } as never);
    const input = await journal.get<Record<string, unknown>>(runKeys.input('wk-first'));
    expect(input?.workKey).toBe('invoice-4471');
    expect((await journal.listRunsPaged({ workKey: 'invoice-9999' })).items).toEqual([]);
  });

  it('claimIdentityInput carries it too — the workflow/batch/network doors are not second-class', async () => {
    // Those three paths never call `run()`, so `claimIdentityInput` is the only writer of their
    // `:input`. A workKey that only the agent door could record would make "the same job" a concept
    // half the engine cannot express.
    const journal = new InMemoryJournal();
    await claimIdentityInput(journal, 'wf-mutabakat', {
      at: Date.now(), resourceId: 'u-ayse', workflow: 'gece-mutabakati',
      workKey: 'recon-2026-09-12', workScope: { kind: 'org', value: '~deployment' },
    });
    const rec = await journal.get<Record<string, unknown>>(runKeys.input('wf-mutabakat'));
    expect(rec?.workKey).toBe('recon-2026-09-12');
    expect(rec?.workScope).toEqual({ kind: 'org', value: '~deployment' });
    expect((await journal.listRunsPaged({ workKey: 'recon-2026-09-12' })).items.map((r) => r.runId))
      .toEqual(['wf-mutabakat']);
  });
});

// The four adapters derive `RunSummary` fields by four different mechanisms (in-memory point read,
// SQLite correlated subquery, Postgres LEFT JOIN, Redis single SCAN). A field that surfaces on one
// and not another is how an operator's filter silently answers "no such run".
const backends: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:')],
  ['postgres', () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
  ['redis', () => new RedisStorage({ client: makeFakeRedis() as never })],
];

for (const [name, make] of backends) {
  describe(`workKey on RunSummary — ${name}`, () => {
    it('surfaces workKey from the `:input` entry and filters by it BEFORE slicing', async () => {
      const s = make();
      await (s as { init?: () => Promise<void> }).init?.();
      const runs = s.runs;
      for (const [id, key] of [['wa', 'job-A'], ['wb', 'job-B'], ['wc', 'job-A'], ['wd', 'job-A']] as const) {
        await runs.put(`${id}:input`, { prompt: 'hi', workKey: key, workScope: { kind: 'resource', value: 'u-a' } });
        await runs.put(`${id}:model:0`, { ok: true });
      }
      await runs.put('wnone:model:0', { ok: true }); // no `:input` → no workKey, matches no filter

      const all = await runs.listRuns();
      expect(all.items.find((r) => r.runId === 'wa')!.workKey).toBe('job-A');
      expect(all.items.find((r) => r.runId === 'wnone')!.workKey).toBeUndefined();

      const a = await runs.listRuns({ workKey: 'job-A' });
      expect(a.items.map((r) => r.runId).sort()).toEqual(['wa', 'wc', 'wd']);

      // Filter-before-slice: walking job-A at limit 2 must yield exactly those three, never a short
      // page whose cursor has already stepped past a match.
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await runs.listRuns({ workKey: 'job-A', limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((r) => r.runId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.sort()).toEqual(['wa', 'wc', 'wd']);
      await (s as { close?: () => void }).close?.();
    });

    it('the same filter reaches through `toJournal` (the JournalReader.listRunsPaged bridge)', async () => {
      const s = make();
      await (s as { init?: () => Promise<void> }).init?.();
      const j = toJournal(s.runs);
      await j.put('tj-1:input', { prompt: 'hi', workKey: 'job-Z' });
      await j.put('tj-1:model:0', { ok: true });
      await j.put('tj-2:model:0', { ok: true });
      const page = await j.listRunsPaged!({ workKey: 'job-Z' });
      expect(page.items.map((r) => r.runId)).toEqual(['tj-1']);
      await (s as { close?: () => void }).close?.();
    });
  });
}

describe('workKey and the tombstone (§10.3 — deletion stays deleted)', () => {
  /** The fast path (`listStaleRuns`) dates a run by WRITE time; the slow scan reads `at`. Both write
   *  the tombstone, so both are asked the question. */
  const slowScan = (j: InMemoryJournal) => {
    (j as unknown as { listStaleRuns?: unknown }).listStaleRuns = undefined;
    return j;
  };

  it('the swept marker keeps the workKey HASH and the scope KIND — never the text (fast path)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      journal, runId: 'tomb-1', model: model(), prompt: 'fatura kes',
      agentName: 'muhasebe', workKey: 'invoice-4471', workScope: { kind: 'resource', value: 'u-ayse' },
    } as never);

    const res = await sweepRuns(journal, { olderThanMs: HOUR, now: Date.now() + 3 * HOUR, tombstones: true });
    expect(res.purged).toContain('tomb-1');

    const tomb = await journal.get<Record<string, unknown>>('tomb-1:swept');
    expect(tomb?.workKeyHash).toBe(workKeyHash('invoice-4471'));
    expect(tomb?.workScope).toBe('resource');
    // The text itself is gone, and the assertion is on the SERIALIZED marker rather than on the
    // fields we happen to know about: a future field that quietly re-embeds the string would pass a
    // per-field check and fail this one.
    expect(JSON.stringify(tomb)).not.toContain('invoice-4471');
    // And the run is genuinely gone — the tombstone is a refusal, not a copy.
    expect(await journal.get(runKeys.input('tomb-1'))).toBeUndefined();
  });

  it('the same, through the slow scan and an identity record', async () => {
    const journal = slowScan(new InMemoryJournal());
    const now = Date.now();
    await claimIdentityInput(journal, 'wf-tomb', {
      at: now - 3 * HOUR, resourceId: 'u-ayse', workflow: 'gece-mutabakati',
      workKey: 'recon-2026-09-12', workScope: { kind: 'org', value: '~deployment' },
    });
    const res = await sweepRuns(journal, { olderThanMs: HOUR, now, tombstones: true });
    expect(res.purged).toEqual(['wf-tomb']);
    const tomb = await journal.get<Record<string, unknown>>('wf-tomb:swept');
    expect(tomb?.workKeyHash).toBe(workKeyHash('recon-2026-09-12'));
    expect(tomb?.workScope).toBe('org');
    expect(JSON.stringify(tomb)).not.toContain('recon-2026-09-12');
  });

  it('a run swept without a workKey leaves the plain marker — no empty fields to read as facts', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ journal, runId: 'tomb-plain', model: model(), prompt: 'selam' } as never);
    await sweepRuns(journal, { olderThanMs: HOUR, now: Date.now() + 3 * HOUR, tombstones: true });
    const tomb = await journal.get<Record<string, unknown>>('tomb-plain:swept');
    expect(tomb).toBeDefined();
    expect('workKeyHash' in (tomb ?? {})).toBe(false);
    expect('workScope' in (tomb ?? {})).toBe(false);
  });
});

describe('workKey and erasure (regression — a named run deletes like any other)', () => {
  it('purgeRun removes a workKey-carrying run whole', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      journal, runId: 'pr-1', model: model(), prompt: 'fatura kes',
      agentName: 'muhasebe', workKey: 'invoice-4471', workScope: { kind: 'resource', value: 'u-ayse' },
    } as never);
    expect(await purgeRun(journal, 'pr-1')).toBeGreaterThan(0);
    expect(await journal.get(runKeys.input('pr-1'))).toBeUndefined();
    expect((await journal.listRunsPaged({ workKey: 'invoice-4471' })).items).toEqual([]);
  });

  it('purgeResource still finds the person’s runs when they carry a workKey', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.input('pres-1'), stampFormat({
      at: Date.now(), prompt: 'x', resourceId: 'u-ayse', workKey: 'invoice-4471',
      workScope: { kind: 'resource', value: 'u-ayse' },
    }));
    await journal.put('pres-1:model:0', { ok: true });
    await purgeResource(journal, 'u-ayse');
    expect(await journal.get(runKeys.input('pres-1'))).toBeUndefined();
    expect(await journal.get('pres-1:model:0')).toBeUndefined();
  });
});
