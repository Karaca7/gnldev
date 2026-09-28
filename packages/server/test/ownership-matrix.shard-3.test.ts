// A shard of the conformance registry's walk (ADR-0002 point 7); see ownership-matrix.test.ts.
import { describe, it } from 'vitest';
import { assertShard } from './conformance-registry.js';

describe('conformance registry: births x states x doors x callers (shard 4/4)', () => {
  it('every cell holds: no attacker reads a secret, lists a foreign id, or changes the target', () => assertShard(3, 4), 600_000);
});
