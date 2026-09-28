// What the CHANGELOG tells users to import has to be importable. `WIRE_ERROR_STATUS` was named as
// the place to read the limit codes' statuses while no entry point exported it.
import { describe, it, expect } from 'vitest';
import * as durable from '../src/index.js';
import type { VectorQueryOptions, VectorDeleteWhere } from '../src/index.js';

describe('@gnldev/durable entry point', () => {
  it('exports WIRE_ERROR_STATUS with the limit codes in it', () => {
    expect(durable.WIRE_ERROR_STATUS[durable.LIMIT_ERROR_CODES.runLimitExceeded]).toBeTypeOf('number');
    expect(durable.WIRE_ERROR_STATUS[durable.LIMIT_ERROR_CODES.toolLoopDetected]).toBeTypeOf('number');
  });

  it('exports the vector query and delete option types', () => {
    const q: VectorQueryOptions = { topK: 1 } as VectorQueryOptions;
    const d: VectorDeleteWhere = { owner: 'u1' } as VectorDeleteWhere;
    expect([q, d]).toHaveLength(2);
  });
});
