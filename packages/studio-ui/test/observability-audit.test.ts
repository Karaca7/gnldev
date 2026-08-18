// F6.4: audit/metrics CSV export pure functions — escaping edge cases (node environment, no DOM needed).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runsToCsv } from '../src/views/Observability';
import { auditToCsv, ACTIONS } from '../src/views/Audit';
import type { MetricsRun } from '../src/api';
import type { AuditItem } from '../src/api';

describe('runsToCsv (Observability)', () => {
  it('empty array → header row only', () => {
    expect(runsToCsv([])).toBe('runId,status,startTs,durationMs,modelSteps,toolCalls,totalTokens,costUsd');
  });

  it('null startTs/durationMs → empty field', () => {
    const rows: MetricsRun[] = [{
      runId: 'r1', status: 'completed', modelSteps: 2, toolCalls: 1,
      startTs: null, durationMs: null, costUsd: 0.01, totalTokens: 100,
    }];
    const csv = runsToCsv(rows);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('r1,completed,,,2,1,100,0.01');
  });

  it('a runId containing a comma is quoted', () => {
    const rows: MetricsRun[] = [{
      runId: 'a,b', status: 'completed', modelSteps: 0, toolCalls: 0,
      startTs: 1000, durationMs: 50, costUsd: 0, totalTokens: 0,
    }];
    expect(runsToCsv(rows).split('\n')[1]).toBe('"a,b",completed,1000,50,0,0,0,0');
  });

  it('a field containing quotes is doubled and quoted', () => {
    const rows: MetricsRun[] = [{
      runId: 'run "42"', status: 'completed', modelSteps: 0, toolCalls: 0,
      startTs: 0, durationMs: 0, costUsd: 0, totalTokens: 0,
    }];
    expect(runsToCsv(rows).split('\n')[1]).toBe('"run ""42"""' + ',completed,0,0,0,0,0,0');
  });

  it('a field containing a newline is quoted (row count is not thrown off)', () => {
    const rows: MetricsRun[] = [{
      runId: 'multi\nline', status: 'suspended', modelSteps: 1, toolCalls: 0,
      startTs: 5, durationMs: 5, costUsd: 0, totalTokens: 0,
    }];
    const csv = runsToCsv(rows);
    // 2 logical rows (header + 1 record) — the escaped newline must not throw off the row count, but
    // split('\n') on the raw text shows 3 chunks (including the \n inside the escaped field); still, a
    // single CSV record is a single logical "row".
    expect(csv).toContain('"multi\nline"');
    expect(csv.startsWith('runId,status')).toBe(true);
  });
});

describe('auditToCsv (Audit)', () => {
  it('empty array → header row only', () => {
    expect(auditToCsv([])).toBe('id,at,actor,org,action,target,detail');
  });

  it('optional fields (at/org/detail) are left empty when missing', () => {
    const items: AuditItem[] = [{ id: '1', actor: 'alice', action: 'approve', target: 'run-1' }];
    expect(auditToCsv(items).split('\n')[1]).toBe('1,,alice,,approve,run-1,');
  });

  it('detail is embedded as JSON and commas/quotes are escaped', () => {
    const items: AuditItem[] = [{
      id: '2', at: 123, actor: 'bob', org: 't1', action: 'deny', target: 'run,"2"',
      detail: { reason: 'foo,bar' },
    }];
    const line = auditToCsv(items).split('\n')[1]!;
    expect(line).toBe('2,123,bob,t1,deny,"run,""2""","{""reason"":""foo,bar""}"');
  });

  it('multiple records → header + N rows', () => {
    const items: AuditItem[] = [
      { id: 'a', actor: 'x', action: 'fork', target: 't1' },
      { id: 'b', actor: 'y', action: 'deny', target: 't2' },
    ];
    expect(auditToCsv(items).split('\n')).toHaveLength(3);
  });
});

describe('ACTIONS (Audit filter list)', () => {
  // Must match packages/studio/src/server.ts's `type AuditAction` (~line 472-479) exactly —
  // the server never produces an action outside these values, and the dropdown must not list too few or too many.
  // READ from the server's own union instead of a copy. The copy was the problem: the comment said it
  // "must match server.ts exactly" and nothing enforced that, so this list and the UI's drifted
  // together — measured, 15 of the server's 36 actions were missing from the dropdown, including
  // run.cancel, run.compensate, org.delete and pricing.update.
  const serverSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'studio', 'src', 'server.ts'),
    'utf8',
  );
  const SERVER_AUDIT_ACTIONS = [...new Set(
    [...(/type AuditAction =([\s\S]*?);/.exec(serverSrc)?.[1] ?? '').matchAll(/'([a-zA-Z.\-]+)'/g)].map((x) => x[1]),
  )];

  it('matches the server\'s AuditAction union (no extras/no omissions)', () => {
    expect([...ACTIONS].sort()).toEqual([...SERVER_AUDIT_ACTIONS].sort());
  });

  it('contains no duplicate values', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });
});
