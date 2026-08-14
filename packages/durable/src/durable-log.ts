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

/** Return all log items in a namespace in write order. */
export async function listLog<T = unknown>(journal: Journal, ns: string): Promise<LogItem<T>[]> {
  const prefix = `${ns}:`;
  const keys = journal.listKeys ? await journal.listKeys(prefix) : [];
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

/**
 * Atomically place a marker → only the FIRST call gets `true` (exactly-once consumption).
 * Even under crash/concurrency, a marker is won exactly once (putIfAbsent / claim).
 */
export async function consumeOnce(journal: Journal, marker: string): Promise<boolean> {
  return claim(journal, marker, { at: Date.now() });
}
