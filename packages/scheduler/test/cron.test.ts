import { describe, it, expect } from 'vitest';
import { nextCronTime, parseField } from '../src/index.js';

const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo, d, h, mi, 0);

describe('cron parseField', () => {
  it('*, list, range, step', () => {
    expect([...parseField('*', 0, 5)]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...parseField('1,3', 0, 5)]).toEqual([1, 3]);
    expect([...parseField('2-4', 0, 5)]).toEqual([2, 3, 4]);
    expect([...parseField('*/2', 0, 5)]).toEqual([0, 2, 4]);
    expect([...parseField('1-5/2', 0, 9)]).toEqual([1, 3, 5]);
  });
  it('throws on out-of-range/invalid', () => {
    expect(() => parseField('99', 0, 59)).toThrow();
    expect(() => parseField('5-2', 0, 59)).toThrow();
  });
});

describe('nextCronTime', () => {
  const base = utc(2026, 5, 21, 12, 0); // 2026-06-21 12:00 UTC

  it('every minute → next minute', () => {
    expect(nextCronTime('* * * * *', base)).toBe(utc(2026, 5, 21, 12, 1));
  });
  it('every 5 minutes', () => {
    expect(nextCronTime('*/5 * * * *', utc(2026, 5, 21, 12, 2))).toBe(utc(2026, 5, 21, 12, 5));
  });
  it('daily 00:00 → next day', () => {
    expect(nextCronTime('0 0 * * *', base)).toBe(utc(2026, 5, 22, 0, 0));
  });
  it('specific time 9:30', () => {
    expect(nextCronTime('30 9 * * *', base)).toBe(utc(2026, 5, 22, 9, 30));
  });
  it('throws on invalid expression (not 5 fields / out of range)', () => {
    expect(() => nextCronTime('* * *', base)).toThrow();
    expect(() => nextCronTime('99 * * * *', base)).toThrow();
  });
});
