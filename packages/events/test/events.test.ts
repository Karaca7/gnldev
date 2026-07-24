// Phase 12 — @gnl/events: exactly-once marking + at-least-once delivery + fan-out + no redelivery on re-poll.
// (K2 audit: the marker is now written AFTER handler SUCCESS → the event isn't lost on handler error/crash.)
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '@gnl/durable';
import { emit, createConsumer, EventDepthExceededError } from '../src/index.js';

describe('@gnl/events', () => {
  it('fan-out: 2 consumers → each gets every event once; re-poll 0; new event delivered', async () => {
    const work = new InMemoryStorage().work;
    const a: string[] = [];
    const b: string[] = [];
    const ca = createConsumer(work, 'orders', (p: any) => void a.push(p.id), { name: 'A' });
    const cb = createConsumer(work, 'orders', (p: any) => void b.push(p.id), { name: 'B' });

    await emit(work, 'orders', { id: 'o1' }, { id: 'o1' });
    await emit(work, 'orders', { id: 'o2' }, { id: 'o2' });
    await emit(work, 'orders', { id: 'o3' }, { id: 'o3' });

    expect(await ca.poll()).toBe(3);
    expect(await cb.poll()).toBe(3); // fan-out: B got all of them too
    expect(a.sort()).toEqual(['o1', 'o2', 'o3']);
    expect(b.sort()).toEqual(['o1', 'o2', 'o3']);

    expect(await ca.poll()).toBe(0); // re-poll → no redelivery

    await emit(work, 'orders', { id: 'o4' }, { id: 'o4' });
    expect(await ca.poll()).toBe(1); // only the new event
    expect(a).toContain('o4');
  });

  it('concurrent poll (same consumer) → each event is COUNTED only once (exactly-once marking)', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 't', () => void calls++, { name: 'A' });
    await emit(work, 't', {}, { id: 'e1' });
    await emit(work, 't', {}, { id: 'e2' });
    await emit(work, 't', {}, { id: 'e3' });

    const counts = await Promise.all([c.poll(), c.poll(), c.poll()]);
    // New contract (at-least-once delivery): the handler may run more than once under a race
    // (idempotency is the handler's job), but thanks to ackOnce (CAS) each event is counted as
    // delivered EXACTLY ONCE in total.
    expect(counts.reduce((s, n) => s + n, 0)).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(await c.poll()).toBe(0); // race is over → markers written → no redelivery
  });

  // Phase 5.1 — cursor-based draining: no starvation at 50+ events (WorkStore.list's default page
  // was 50; previously anything beyond the first page was never seen) + per-consumer cursor
  // advancement + exactly-once is preserved.
  it('50+ events: all delivered with a single poll() (no starvation) + cursor advances + exactly-once', async () => {
    const work = new InMemoryStorage().work;
    const N = 60; // event count exceeding the default page size (50)
    const seen: Record<string, number> = {};
    const c = createConsumer(work, 'bulk', (p: any) => { seen[p.id] = (seen[p.id] ?? 0) + 1; }, { name: 'A' });
    for (let i = 0; i < N; i++) await emit(work, 'bulk', { id: `e${i}` }, { id: `e${i}` });

    const delivered = await c.poll();
    expect(delivered).toBe(N); // all delivered — page-1-and-beyond (e50..e59) wasn't skipped

    for (let i = 0; i < N; i++) expect(seen[`e${i}`]).toBe(1); // each event EXACTLY ONCE (exactly-once)
    expect(await c.poll()).toBe(0); // re-poll → no redelivery

    // After the first (fully consumed) page, this consumer's cursor should have permanently advanced.
    const cursor = await work.get('evtcursor:bulk:A');
    expect(cursor).toBeDefined();
  });

  it('fan-out with 50+ events: each consumer advances independently with its own cursor', async () => {
    const work = new InMemoryStorage().work;
    const N = 55;
    const a: string[] = [];
    const b: string[] = [];
    const ca = createConsumer(work, 'bulk2', (p: any) => void a.push(p.id), { name: 'A' });
    for (let i = 0; i < N; i++) await emit(work, 'bulk2', { id: `e${i}` }, { id: `e${i}` });

    expect(await ca.poll()).toBe(N); // A advanced its cursor

    // B hasn't polled yet → it has no cursor of its own, and gets all N events unaffected by A's progress.
    const cb = createConsumer(work, 'bulk2', (p: any) => void b.push(p.id), { name: 'B' });
    expect(await cb.poll()).toBe(N);

    expect(a.length).toBe(N);
    expect(b.length).toBe(N);
    expect(await ca.poll()).toBe(0); // A re-poll → no redelivery
    expect(await cb.poll()).toBe(0); // B re-poll → no redelivery
  });

  // K2 — at-least-once delivery: on handler error the event is NOT LOST, marker isn't written, next poll retries.
  it('handler throws on first call → event isn\'t lost; poll doesn\'t die; second poll redelivers + marks', async () => {
    const work = new InMemoryStorage().work;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const attempts: Record<string, number> = {};
    const c = createConsumer(work, 'pay', (p: any) => {
      attempts[p.id] = (attempts[p.id] ?? 0) + 1;
      if (p.id === 'p2' && attempts.p2 === 1) throw new Error('boom');
    }, { name: 'A' });
    await emit(work, 'pay', { id: 'p1' }, { id: 'p1' });
    await emit(work, 'pay', { id: 'p2' }, { id: 'p2' });
    await emit(work, 'pay', { id: 'p3' }, { id: 'p3' });

    // First poll: p2 throws → poll does NOT REJECT, p1 and p3 are still processed (loop didn't die), error is logged.
    await expect(c.poll()).resolves.toBe(2);
    expect(attempts).toEqual({ p1: 1, p2: 1, p3: 1 });
    expect(warn).toHaveBeenCalledOnce();
    expect(await work.get('evtack:pay:A:p2')).toBeUndefined(); // failed → marker NOT WRITTEN (no loss)

    // Second poll: only p2 is redelivered (p1/p3 are skipped via marker), marker is written on success.
    expect(await c.poll()).toBe(1);
    expect(attempts).toEqual({ p1: 1, p2: 2, p3: 1 });
    expect(await work.get('evtack:pay:A:p2')).toBeDefined();
    expect(await c.poll()).toBe(0); // no more redelivery now
    warn.mockRestore();
  });

  // K2 — if a failed event remains on a fully-consumed page, the cursor is NOT ADVANCED (otherwise the event is never scanned again = loss).
  it('a failed event locks the page cursor; once fixed the cursor advances, each event counted exactly once', async () => {
    const work = new InMemoryStorage().work;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const N = 60; // page size 50 → e10 is on the fully-consumed 1st page
    const attempts: Record<string, number> = {};
    let failE10 = true;
    const c = createConsumer(work, 'bulk3', (p: any) => {
      attempts[p.id] = (attempts[p.id] ?? 0) + 1;
      if (p.id === 'e10' && failE10) throw new Error('boom');
    }, { name: 'A' });
    for (let i = 0; i < N; i++) await emit(work, 'bulk3', { id: `e${i}` }, { id: `e${i}` });

    // First poll: on page 1 (e0..e49) e10 fails → the rest of the page is processed but the cursor
    // does NOT ADVANCE and page 2 isn't reached (49 delivered). e50..e59 remain for the next poll.
    expect(await c.poll()).toBe(49);
    expect(await work.get('evtcursor:bulk3:A')).toBeUndefined(); // cursor is locked — e10 can't be lost

    // Second poll: e10 is fixed → on page 1 only e10 is retried (the rest are skipped via marker),
    // once the page is clear the cursor advances and page 2 (e50..e59) is also delivered.
    failE10 = false;
    expect(await c.poll()).toBe(11);
    expect(await work.get('evtcursor:bulk3:A')).toBeDefined();

    for (let i = 0; i < N; i++) expect(attempts[`e${i}`]).toBe(i === 10 ? 2 : 1); // no double delivery (e10: 1 failure + 1 success)
    expect(await c.poll()).toBe(0);
    warn.mockRestore();
  });

  // Audit: poll storm — setInterval(200ms) on an empty topic caused tens of thousands of queries
  // per second with many consumers. start()/stop() is now a self-rescheduling setTimeout chain; on
  // an empty poll (delivered=0) the interval grows ×2 (backoff default ON), resets to pollMs on
  // delivery, and never overlaps.
  describe('poll backoff (poll storm prevention)', () => {
    it('successive poll intervals grow on an empty topic', async () => {
      const work = new InMemoryStorage().work;
      const origList = work.list.bind(work);
      const times: number[] = [];
      vi.spyOn(work, 'list').mockImplementation((...args: any[]) => {
        times.push(Date.now());
        return (origList as any)(...args);
      });
      const c = createConsumer(work, 'empty-topic', () => {}, { name: 'A', pollMs: 15, maxPollMs: 120 });
      c.start();
      await new Promise((r) => setTimeout(r, 320));
      c.stop();

      expect(times.length).toBeGreaterThanOrEqual(4);
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
      expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.3);
      expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.3);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(120 + 40);
    });

    it('poll interval resets to pollMs once an event is delivered', async () => {
      const work = new InMemoryStorage().work;
      const seen: string[] = [];
      const c = createConsumer(work, 'reset-topic', (p: any) => void seen.push(p.id), {
        name: 'A',
        pollMs: 10,
        maxPollMs: 400, // DEFLAKE: cap widened (see the reset window comment below)
      });
      c.start();
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: let backoff approach the widened cap
      await emit(work, 'reset-topic', { id: 'e1' }, { id: 'e1' });
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: worst-case backed-off tick is ≤400ms
      expect(seen).toContain('e1');

      seen.length = 0;
      await emit(work, 'reset-topic', { id: 'e2' }, { id: 'e2' });
      // if it reset (~pollMs=10ms) it's caught quickly; if still in backoff (ceiling ~80ms) it wouldn't be caught.
      // DEFLAKE margins: reset ≈10ms vs cap 400ms measured through a 150ms window (15× slack, 2.6× headroom).
      await new Promise((r) => setTimeout(r, 150));
      expect(seen).toContain('e2');
      c.stop();
    });

    it('backoff:false → fixed poll interval (old behavior)', async () => {
      const work = new InMemoryStorage().work;
      const origList = work.list.bind(work);
      let calls = 0;
      vi.spyOn(work, 'list').mockImplementation((...args: any[]) => {
        calls++;
        return (origList as any)(...args);
      });
      const c = createConsumer(work, 'const-topic', () => {}, { name: 'A', pollMs: 10, backoff: false });
      c.start();
      await new Promise((r) => setTimeout(r, 205));
      c.stop();
      expect(calls).toBeGreaterThanOrEqual(15);
    });

    it('no overlap: a new tick doesn\'t start while a slow poll is in progress', async () => {
      const work = new InMemoryStorage().work;
      const origList = work.list.bind(work);
      let active = 0;
      let maxActive = 0;
      vi.spyOn(work, 'list').mockImplementation(async (...args: any[]) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const res = await (origList as any)(...args);
        await new Promise((r) => setTimeout(r, 60));
        active--;
        return res;
      });
      const c = createConsumer(work, 'slow-topic', () => {}, { name: 'A', pollMs: 10 });
      c.start();
      await new Promise((r) => setTimeout(r, 200));
      c.stop();
      expect(maxActive).toBeLessThanOrEqual(1);
    });
  });

  describe('backpressure: emit maxDepth (opt-in)', () => {
    it('if maxDepth isn\'t given (default) the topic grows unbounded — existing behavior', async () => {
      const work = new InMemoryStorage().work;
      for (let i = 0; i < 5; i++) await emit(work, 't', { i }, { id: `e${i}` });
      const c = createConsumer(work, 't', () => {}, { name: 'A' });
      expect(await c.poll()).toBe(5);
    });

    it('emit passes freely while depth is below maxDepth', async () => {
      const work = new InMemoryStorage().work;
      await emit(work, 't', {}, { id: 'a' });
      await emit(work, 't', {}, { id: 'b' });
      // depth 2, maxDepth 3 → free.
      await expect(emit(work, 't', {}, { id: 'c', maxDepth: 3 })).resolves.toBe('c');
      const c = createConsumer(work, 't', () => {}, { name: 'A' });
      expect(await c.poll()).toBe(3);
    });

    it('emit throws EventDepthExceededError once depth reaches maxDepth', async () => {
      const work = new InMemoryStorage().work;
      await emit(work, 't', {}, { id: 'a' });
      await emit(work, 't', {}, { id: 'b' });
      // depth already 2, maxDepth 2 → exceeded (>=).
      await expect(emit(work, 't', {}, { id: 'c', maxDepth: 2 })).rejects.toThrow(EventDepthExceededError);
      await expect(emit(work, 't', {}, { id: 'c', maxDepth: 2 })).rejects.toThrow(/depth limit exceeded/);
      const c = createConsumer(work, 't', () => {}, { name: 'A' });
      expect(await c.poll()).toBe(2); // 'c' was never added
    });
  });
});
