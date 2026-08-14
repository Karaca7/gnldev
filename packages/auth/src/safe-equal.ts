// Constant-time secret comparison: plain `===` / Set.has is exposed to a timing side channel (the
// Further the match progresses/the earlier it bails, the longer the comparison takes → an attacker
// Can brute-force the token character by character). node:crypto timingSafeEqual is constant-time
// BUT requires equal-length buffers (throws on a length mismatch → which is itself a side channel).
// Solution (the standard trick): hash BOTH values with sha256 before comparing — since the digest
// Is always a fixed (32 byte) length, the original length difference doesn't leak, and timingSafeEqual
// Makes the rest constant-time.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Compares two secrets (bearer token, `Authorization` header value...) in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
