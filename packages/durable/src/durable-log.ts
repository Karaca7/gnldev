// Phase 12 — the shared durable-log primitive (queue + events are built on top of it).
// Writes append-only items to the journal (idempotent), lists them by prefix, and places an
// Exactly-once consumption marker via putIfAbsent. Since the `${ns}:` prefix contains no ':model:'/':tool:', it's invisible to parseJournalKey (the run reader).
import { claim } from './journal.js';
import type { Journal } from './journal.js';

export interface LogItem<T = unknown> {
  id: string;
  key: string;
  payload: T;
  at?: number;
}

/** Append an item to the log (first-write-wins → idempotent when retried with the same id). Generates an id if not given. */
export async function appendLog<T = unknown>(
  journal: Journal,
  ns: string,
  payload: T,
  id?: string,
): Promise<string> {
  const itemId = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await claim(journal, `${ns}:${itemId}`, { id: itemId, payload, at: Date.now() });
  return itemId;
}

export interface ListLogOptions {
  /**
   * Read at most this many records, NEWEST first, instead of the whole namespace.
   *
   * `listLog` is one `journal.get` per record. That is fine for a log with a bounded writer, and it
   * stopped being fine for `__audit__` once every organization's writes were pinned to the single root
   * log: measured, a request for `limit=1` scoped to one org performed 2001 gets against a 2000-record
   * log. On an in-process journal that is milliseconds; on Postgres it is 2000 round trips to return
   * one row, and the log has no sweeper wired anywhere, so it only grows.
   *
   * Ordering without I/O: an id is `${Date.now().toString(36)}-<random>`, and base36 of the current
   * epoch is a fixed 8 characters until the year 2059 — so sorting the KEY LIST descending is already
   * newest-first, and only the records that will be returned are ever fetched. `at` is still the
   * authoritative sort of what comes back.
   *
   * The resolution of that ordering is a MILLISECOND, not a record. Entries written inside one
   * millisecond share the time prefix and are separated only by their random suffix, so which of them
   * falls inside the window is arbitrary. Measured while testing this: 1200 records written in a tight
   * loop returned 1184, 1149, … as the "newest three". For a log with a human-scale write rate the
   * window is the recent end; for a burst inside one tick, entries in that tick are interchangeable.
   */
  limit?: number;
}

/**
 * Return log items in a namespace, oldest first (the historical contract).
 *
 * With `opts.limit` it reads only the newest N records and returns them oldest-first among those —
 * see ListLogOptions.limit for why the whole-namespace read had to become optional.
 */
export async function listLog<T = unknown>(journal: Journal, ns: string, opts: ListLogOptions = {}): Promise<LogItem<T>[]> {
  const prefix = `${ns}:`;
  let keys = journal.listKeys ? await journal.listKeys(prefix) : [];
  if (opts.limit !== undefined && opts.limit >= 0 && keys.length > opts.limit) {
    keys = [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, opts.limit);
  }
  const items: LogItem<T>[] = [];
  for (const key of keys) {
    const rec = await journal.get<any>(key);
    if (rec && typeof rec === 'object' && 'payload' in rec) {
      items.push({ id: rec.id ?? key.slice(prefix.length), key, payload: rec.payload, at: rec.at });
    }
  }
  items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return items;
}

/** How many records exist in a log namespace, without reading any of them. */
export async function countLog(journal: Journal, ns: string): Promise<number> {
  return journal.listKeys ? (await journal.listKeys(`${ns}:`)).length : 0;
}

/**
 * Atomically place a marker → only the FIRST call gets `true` (exactly-once consumption).
 * Even under crash/concurrency, a marker is won exactly once (putIfAbsent / claim).
 */
export async function consumeOnce(journal: Journal, marker: string): Promise<boolean> {
  return claim(journal, marker, { at: Date.now() });
}
