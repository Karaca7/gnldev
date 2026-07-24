// H12 — bloat/compaction: purge leaves empty pages; compact() RECLAIMS disk space.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { purgeRun } from '../src/retention.js';

const fileBytes = (base: string) =>
  ['', '-wal', '-shm'].reduce((t, e) => t + (existsSync(base + e) ? statSync(base + e).size : 0), 0);

describe('H12 — SQLite compaction (disk reclamation)', () => {
  it('purge leaves empty pages (the file doesn\'t shrink); compact() RECLAIMS disk space', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-compact-'));
    const path = join(dir, 'c.db');
    const st = new SqliteStorage(path);
    try {
      // 40 runs × 100 steps, ~300B content → a measurable file.
      for (let k = 0; k < 40; k++)
        for (let i = 0; i < 100; i++)
          await st.runs.put(`run-${k}:model:${i}`, { step: i, content: [{ type: 'text', text: 'x'.repeat(300) }] });

      const free0 = (st as any).db.prepare('PRAGMA freelist_count').get().freelist_count as number;
      expect(free0).toBe(0); // full DB: no waste

      // Purge half of them.
      for (let k = 0; k < 20; k++) await purgeRun(st.runs, `run-${k}`);
      const freeAfterPurge = (st as any).db.prepare('PRAGMA freelist_count').get().freelist_count as number;
      expect(freeAfterPurge).toBeGreaterThan(0); // 🔑 rows are gone but PAGES are still idle (bloat)

      const beforeCompact = fileBytes(path);
      const { reclaimedBytes } = await st.compact();
      const afterCompact = fileBytes(path);

      expect(reclaimedBytes).toBeGreaterThan(0);      // bytes were actually reclaimed
      expect(afterCompact).toBeLessThan(beforeCompact); // the file SHRANK
      expect((st as any).db.prepare('PRAGMA freelist_count').get().freelist_count).toBe(0); // waste cleared

      // data intact AFTER compact: remaining runs are readable, deleted ones are gone.
      expect((await st.runs.readRun('run-25')).length).toBe(100);
      expect(await st.runs.readRun('run-5')).toEqual([]);
    } finally {
      await st.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() flushes the WAL into the main file (no side files accumulate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-wal-'));
    const path = join(dir, 'w.db');
    const st = new SqliteStorage(path);
    for (let i = 0; i < 500; i++) await st.runs.put(`r:model:${i}`, { i });
    expect(existsSync(path + '-wal') && statSync(path + '-wal').size > 0).toBe(true); // WAL is full during writes
    await st.close();
    // Close does checkpoint(TRUNCATE) → the WAL is either gone or 0 bytes.
    expect(!existsSync(path + '-wal') || statSync(path + '-wal').size === 0).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('compact is a no-op on an :memory: DB (does not error)', async () => {
    const st = new SqliteStorage(':memory:');
    expect(await st.compact()).toEqual({ reclaimedBytes: 0 });
    await st.close();
  });
});
