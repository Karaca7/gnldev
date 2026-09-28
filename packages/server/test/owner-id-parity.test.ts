// R17: ONE rule for what an end user's id may be.
//
// `@gnldev/auth` decides who may be minted as a subject (`subjectIdProblem`); `@gnldev/durable` decides
// what may own a stored name or a document (`ownerIdProblem`). durable depends on no other `@gnldev/*`
// package (ADR-0002), so the rule is written twice — and this test, in a package that sees both, holds
// the two copies to the same answer on every input. If one drifts, a user auth admits could be refused
// every write (or worse, the other way round: an id no user can hold would own data).
import { describe, it, expect } from 'vitest';
import { subjectIdProblem, RESERVED_SUBJECT_PREFIXES } from '@gnldev/auth';
import { ownerIdProblem, RESERVED_OWNER_PREFIXES } from '@gnldev/durable';

const C0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i));
const C1 = Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(0x7f + i)); // DEL + C1
const CORPUS: string[] = [
  '', 'a', 'bob', 'ayşe', 'u\uD83D\uDE00',
  'x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), '\uD83D\uDE00'.repeat(100), '\uD83D\uDE00'.repeat(101),
  ...C0.map((c) => `a${c}b`), ...C1.map((c) => `a${c}b`), 'a\u2028b', 'a\u2029b', 'a\u00a0b', 'a\u200bb',
  ...['operator:', 'application:', 'role:', 'token:'].flatMap((p) => [p, `${p}ops`, ` ${p}ops`, p.toUpperCase() + 'ops', p.slice(0, -1)]),
  'operator', 'ops:operator:x', 'org:acme', '~o~acme:bob:x', 'a:b', 'a~b', '100%', '%3A',
  'u\uD800', 'u\uDC00', '\uDC00\uD800', 'u\uFFFD',
];

describe('owner-id rule: durable mirrors auth', () => {
  it('the reserved prefixes are the same list', () => {
    expect([...RESERVED_OWNER_PREFIXES]).toEqual([...RESERVED_SUBJECT_PREFIXES]);
  });

  it.each(CORPUS.map((id) => [JSON.stringify(id), id]))('%s', (_label, id) => {
    expect(ownerIdProblem(id)).toBe(subjectIdProblem(id));
  });

  it('the corpus reaches every answer, so a rule returning one constant cannot pass', () => {
    expect(new Set(CORPUS.map(subjectIdProblem))).toEqual(new Set([null, 'length', 'control characters', 'reserved prefix']));
  });
});
