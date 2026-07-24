// safeEqual: constant-time secret comparison (crypto.timingSafeEqual + sha256 pre-hash).
import { describe, it, expect } from 'vitest';
import { safeEqual } from '../src/safe-equal.js';

describe('safeEqual (constant-time comparison)', () => {
  it('equal strings → true', () => {
    expect(safeEqual('secret-token', 'secret-token')).toBe(true);
  });

  it('different strings of the same length → false', () => {
    expect(safeEqual('secret-token', 'secret-tokeX')).toBe(false);
  });

  it('strings of different lengths → false (the equal-length constraint of timingSafeEqual is bypassed via sha256)', () => {
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
    expect(safeEqual('a-much-longer-value', 'short')).toBe(false);
  });

  it('empty string: true if both are empty, false if only one is', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('x', '')).toBe(false);
  });
});
