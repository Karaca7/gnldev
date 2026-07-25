// API-04: GET /events used to scan the WHOLE run list every second and compare a signature — a run
// mid-flight (its modelSteps changing every step) kept the stream firing constantly, and the payload
// carried no information (just `data:'runs'`), forcing every client to re-fetch everything on ANY event.
// This pins the fix: the event body now names exactly which runIds changed, computed via a cheap
// countRunsByStatus()+newest-run fingerprint (never a per-tick full listRuns() scan) — and a reader
// without that capability keeps the exact pre-fix behavior (full scan, uninformative payload).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

/** nextEvent's cross-call state: the decoded buffer, plus a `read()` call that may still be in
 *  flight when a previous call timed out — MUST be reused (never re-issued) so its eventual result
 *  isn't silently dropped (a fresh `reader.read()` on every call would orphan the pending one and
 *  lose whatever chunk it resolves with). */
interface SseReadState { buf: string; pending: Promise<ReadableStreamReadResult<Uint8Array>> | null; }

/** Reads one SSE frame (`event:`/`data:` lines up to the blank-line separator), or null on timeout. */
async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: SseReadState,
  timeoutMs: number,
): Promise<{ event?: string; data?: string } | null> {
  const dec = new TextDecoder();
  for (;;) {
    const idx = state.buf.indexOf('\n\n');
    if (idx !== -1) {
      const chunk = state.buf.slice(0, idx);
      state.buf = state.buf.slice(idx + 2);
      let event: string | undefined;
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      return { event, data };
    }
    if (!state.pending) state.pending = reader.read();
    const raced = await Promise.race([
      state.pending.then((r) => ({ timedOut: false as const, r })),
      new Promise<{ timedOut: true }>((res) => setTimeout(() => res({ timedOut: true }), timeoutMs)),
    ]);
    if (raced.timedOut) return null; // `state.pending` stays set — the NEXT call reuses it, nothing lost
    state.pending = null; // resolved — the next iteration issues a fresh read()
    const { value, done } = raced.r;
    if (done) return null;
    state.buf += dec.decode(value, { stream: true });
  }
}

describe('GET /events (API-04 informative diff)', () => {
  it(
    '(a) no event while nothing changes; a run advancing produces exactly its own runId',
    async () => {
      const journal = new InMemoryJournal(); // implements countRunsByStatus + listRunsPaged (the cheap path)
      await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'b' }], finishReason: 'stop' });
      const app = createStudioApi({ reader: journal });

      const res = await app.request('/events');
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const bufRef: SseReadState = { buf: '', pending: null };

      // First tick establishes the baseline silently; nothing mutates → no event across a full interval.
      // (generous margins below: this suite shares a slow/contended box with real-timer tests elsewhere
      // that already run into the tens of seconds, e.g. durable/compaction.test.ts)
      const none = await nextEvent(reader, bufRef, 3500);
      expect(none).toBeNull();

      // Only run-2 (the NEWEST run) advances a step — the cheap fingerprint's "newest run" tail slice
      // (see readCheapEventsSignal's JSDoc) is what catches this without a full listRuns() scan; an
      // OLDER run advancing while a newer one exists is the documented gap, deliberately not exercised
      // here (see the KNOWN GAP note in server.ts).
      await journal.put('run-2:model:1', { content: [{ type: 'text', text: 'c' }], finishReason: 'stop' });
      const changed = await nextEvent(reader, bufRef, 6000);
      expect(changed).not.toBeNull();
      expect(changed!.event).toBe('change');
      const body = JSON.parse(changed!.data!);
      expect(body.runIds).toEqual(['run-2']); // NOT run-1 — it never changed
      expect(typeof body.at).toBe('number');

      await reader.cancel();
    },
    12000,
  );

  it(
    '(b) a NON-newest run advancing is missed by the cheap signal alone, but caught by the periodic full scan',
    async () => {
      const journal = new InMemoryJournal();
      await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'b' }], finishReason: 'stop' });
      // run-2 is the NEWEST run (created after run-1) — the cheap fingerprint only tracks per-status
      // totals + the newest run's own tuple, so run-1 advancing alone can't move it (the documented
      // KNOWN GAP in server.ts). __fullScanEveryTicks is an internal-only override (NOT part of
      // StudioApiOptions) so this test doesn't have to wait out the real ~10s production default
      // (FULL_SCAN_EVERY_TICKS=5 at the 2s poll interval) — it shrinks the full-scan period to every
      // 2nd tick (~4s) instead.
      const app = createStudioApi({ reader: journal, __fullScanEveryTicks: 2 } as any);

      const res = await app.request('/events');
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const bufRef: SseReadState = { buf: '', pending: null };

      // First tick establishes the baseline silently.
      const none = await nextEvent(reader, bufRef, 3500);
      expect(none).toBeNull();

      // Advance the OLDER run only. The cheap signal (countRunsByStatus totals + the newest run's own
      // tuple) does not observe run-1 at all, so this is only picked up by the periodic full-scan tick —
      // give it a generous window (well past the shortened ~4s full-scan period) to land.
      await journal.put('run-1:model:1', { content: [{ type: 'text', text: 'c' }], finishReason: 'stop' });
      const changed = await nextEvent(reader, bufRef, 9000);
      expect(changed).not.toBeNull();
      expect(changed!.event).toBe('change');
      const body = JSON.parse(changed!.data!);
      expect(body.runIds).toContain('run-1'); // the non-newest run's progress WAS caught, not lost
      expect(typeof body.at).toBe('number');

      await reader.cancel();
    },
    20000,
  );

  it(
    '(c) a journal without countRunsByStatus keeps the pre-API-04 behavior (full scan, plain "runs" payload)',
    async () => {
      const journal = new InMemoryJournal();
      await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      // A bare reader: only the mandatory JournalReader methods — no countRunsByStatus/listRunsPaged.
      const bareReader = { listRuns: journal.listRuns.bind(journal), readRun: journal.readRun.bind(journal) };
      const listSpy = vi.spyOn(bareReader, 'listRuns');
      const app = createStudioApi({ reader: bareReader as any });

      const res = await app.request('/events');
      const reader = res.body!.getReader();
      const bufRef: SseReadState = { buf: '', pending: null };

      // The legacy loop's signature baseline starts empty, so it fires immediately on connect — same as
      // the pre-API-04 code (pinned here so a bare/custom JournalReader's behavior stays byte-identical).
      const first = await nextEvent(reader, bufRef, 2700);
      expect(first).not.toBeNull();
      expect(first!.event).toBe('change');
      expect(first!.data).toBe('runs'); // the OLD, uninformative payload — no JSON/runIds
      expect(listSpy).toHaveBeenCalled();

      await reader.cancel();
    },
    12000,
  );
});
