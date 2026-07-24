// D3-A: buildScoreTrend (Observability's P2-skor per-scorer daily trend) — pure data-shape function,
// no chart/DOM dependency (same node-environment style as observability-audit.test.ts).
import { describe, it, expect } from 'vitest';
import { buildScoreTrend } from '../src/views/Observability';
import type { MetricsDayEntry } from '../src/api';

describe('buildScoreTrend (Observability)', () => {
  it('empty byDay → no scorers, no points', () => {
    expect(buildScoreTrend([])).toEqual({ scorers: [], points: [] });
  });

  it('discovers scorer names dynamically from score:<name>:avg fields, first-seen order', () => {
    const byDay: MetricsDayEntry[] = [
      { day: '2026-07-19', fields: { total: 3, 'score:relevance:avg': 0.8123, 'score:relevance:count': 2 } },
      { day: '2026-07-20', fields: { total: 1, 'score:faithfulness:avg': 0.5, 'score:relevance:avg': 0.9 } },
    ];
    const { scorers, points } = buildScoreTrend(byDay);
    expect(scorers).toEqual(['relevance', 'faithfulness']); // relevance seen first (day 1)
    expect(points).toHaveLength(2);
    // relevance avg is rounded to 3 decimals; a non-numeric-suffix field (score:relevance:count) is ignored.
    expect(points[0]).toMatchObject({ relevance: 0.812 });
    expect(points[0]!.faithfulness).toBeUndefined(); // no data that day → gap, not zero
    expect(points[1]).toMatchObject({ relevance: 0.9, faithfulness: 0.5 });
  });

  it('a day with no fields at all (undefined) still produces a labeled point with no scorer values', () => {
    const byDay: MetricsDayEntry[] = [
      { day: '2026-07-18', fields: undefined },
      { day: '2026-07-19', fields: { 'score:x:avg': 1 } },
    ];
    const { scorers, points } = buildScoreTrend(byDay);
    expect(scorers).toEqual(['x']);
    expect(points[0]!.x).toBeUndefined();
    expect(points[1]!.x).toBe(1);
    expect(typeof points[0]!.label).toBe('string');
  });
});
