// Splitting a document must not change who may read it. Each chunk carries its source's partition and
// end-user label — a chunk that dropped them would be answered from the wrong shelf, or from none.
import { describe, it, expect } from 'vitest';
import { chunkDocuments } from '../src/index.js';

const long = Array.from({ length: 40 }, (_, i) => `sentence number ${i} of a long private note.`).join(' ');

describe('chunkDocuments keeps who a document belongs to', () => {
  it('every chunk of a labelled document keeps its namespace, owner and shared flag', () => {
    const chunks = chunkDocuments([
      { id: 'mine', text: long, namespace: 'org:acme', owner: 'ayse' },
      { id: 'all', text: long, namespace: 'org:acme', shared: true },
    ], { size: 200, overlap: 0 });
    const mine = chunks.filter((c) => c.id.startsWith('mine#'));
    const all = chunks.filter((c) => c.id.startsWith('all#'));
    expect(mine.length).toBeGreaterThan(1);
    for (const c of mine) expect({ ns: c.namespace, owner: c.owner, shared: c.shared }).toEqual({ ns: 'org:acme', owner: 'ayse', shared: undefined });
    for (const c of all) expect({ ns: c.namespace, owner: c.owner, shared: c.shared }).toEqual({ ns: 'org:acme', owner: undefined, shared: true });
  });
});
