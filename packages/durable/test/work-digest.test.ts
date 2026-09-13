// Package #1 of `docs/RUNID-WORKKEY-HEYET-KARARI.md`: the identity primitive, and nothing else.
//
// The decision this file pins (§3) is that the caller's string stops BEING the journal key. The
// engine derives the key from a tuple — `["gnl.run.v1", agentName, scopeKind, scopeValue, workKey]`
// — and the derivation has to survive two very specific failure classes that the document names by
// number rather than by intuition:
//
//   (a) BOUNDARY SHIFTING (§3). Naive concatenation is not injective: `("a","b:c")` and
//       `("a:b","c")` produce the same bytes and therefore the same identity. That class shipped two
//       real CVEs in 2026 (CVE-2026-76581, CVSS 9.8 — unauthenticated admin through a shifted
//       boundary; CVE-2026-71326, whose official fix note is literally "length prefix"). The
//       collision-vector block below carries at least one shifted pair for every adjacent field
//       pair, because an encoding that loses a boundary loses it silently and forever.
//
//   (b) A FORMULA THAT DRIFTS (§3, second half). git's SHA-1→SHA-256 transition is in its sixth
//       year; argo-rollouts took a production outage from an unversioned `ComputeHash` change;
//       Kubernetes could not widen its FNV-32 and had to carry a permanent `collisionCount` scar in
//       its API. So the version tag lives INSIDE the hashed tuple and the golden vectors below are a
//       CONTRACT, not a snapshot: if one of them goes red, the honest fix is `gnl.run.v2` + `run2_`,
//       never an edit to the expected string.
//
// Reservation (§4, §7): `runDurable`/`resumeRun`/`forkRun` keep taking a RAW runId — a hash cannot
// be reversed, so resume has to be callable with the derived id itself. That is why `run1_<32hex>`
// PASSES `assertRunIdSafe` while anything merely shaped like it is refused: the prefix is the
// engine's namespace, and `#` is the engine's execution axis.
//
// SCOPE, deliberately narrow: this package ships the primitive and the reservation. No call path
// accepts a workKey yet — that is package #3 (the registry gate).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  workDigest,
  derivedRunId,
  executionRunId,
  parseDerivedRunId,
  WORKKEY_DST,
  assertRunIdSafe,
} from '../src/index.js';

const HEX32 = /^[0-9a-f]{32}$/;

describe('workDigest — the tuple encoding (§3)', () => {
  // These values were computed from the DOCUMENT's formula, independently of the implementation:
  //   sha256(JSON.stringify(["gnl.run.v1", agent, scopeKind, scopeValue, workKey])).slice(0, 32)
  // They are the CONTRACT. A red row here does not mean "update the expectation" — it means the
  // identity of every stored run just moved, and the only correct response is to mint `run2_`.
  const GOLDEN: ReadonlyArray<readonly [string, 'resource' | 'org', string, string, string]> = [
    ['billing-agent', 'resource', 'u-42', 'invoice-2026-09', '1fbdaaf5fafae893798b6a74a78ce5da'],
    ['billing-agent', 'org', '~deployment', 'nightly-reconciliation', 'bc92b9a2b500035ff8fea155d1a25745'],
    ['firmware-rollout', 'org', 'org-7', 'device-7742', 'f964ab9305489cf445f05af4be330e60'],
    ['a', 'resource', 'ab', 'cdef', '04f7e3d26320c9a0f01233d582138e91'],
    // NOT translated on purpose: a frozen vector's input text IS part of the contract, and the
    // non-ASCII path is the one where a serializer change would show up first.
    ['ajan', 'resource', 'müşteri-7', 'fatura-🌍', 'e7913ccf13f75ecebefc4da19c7d7723'],
  ];

  it.each(GOLDEN.map(([agent, kind, scope, key, digest]) => ({ agent, kind, scope, key, digest })))(
    'workDigest($agent, $kind, $scope, $key) is frozen',
    ({ agent, kind, scope, key, digest }) => {
      expect(workDigest(agent, kind, scope, key)).toBe(digest);
    },
  );

  it('the domain tag lives inside the hash, not only in the prefix', () => {
    // If `gnl.run.v1` were pasted on from the outside, dropping it would not change the digest —
    // and a v2 formula could not coexist with v1 records. This asserts the tag is a hashed field.
    const withTag = createHash('sha256')
      .update(JSON.stringify([WORKKEY_DST, 'a', 'resource', 'b', 'c']))
      .digest('hex')
      .slice(0, 32);
    const withoutTag = createHash('sha256')
      .update(JSON.stringify(['a', 'resource', 'b', 'c']))
      .digest('hex')
      .slice(0, 32);
    expect(workDigest('a', 'resource', 'b', 'c')).toBe(withTag);
    expect(withTag).not.toBe(withoutTag);
    expect(WORKKEY_DST).toBe('gnl.run.v1');
  });

  it('is 32 hex characters — not the 16 that argsHash uses', () => {
    // §3: "16 hex is NEVER used." `argsHash` truncates to 16 because its collision window is one
    // dedup decision inside one run; a runId collision is identity theft across tenants. Different
    // risk class, different budget — this assertion is what stops the next reader from "tidying up"
    // the two to the same width.
    expect(workDigest('a', 'resource', 'b', 'c')).toMatch(HEX32);
    expect(workDigest('a', 'resource', 'b', 'c')).toHaveLength(32);
  });
});

describe('workDigest — boundary shifting cannot move a field (§3, the CVE class)', () => {
  // One shifted pair per adjacent field pair. Every one of these would collide under naive
  // concatenation; under a JSON array encoding the quotes and commas are the length information.
  const PAIRS: ReadonlyArray<
    readonly [string, Parameters<typeof workDigest>, Parameters<typeof workDigest>]
  > = [
    [
      'scopeValue/workKey boundary',
      ['a', 'resource', 'ab', 'cdef'],
      ['a', 'resource', 'abc', 'def'],
    ],
    [
      'agentName/scopeValue boundary via a colon',
      ['a', 'resource', 'b:c', 'd'],
      ['a:b', 'resource', 'c', 'd'],
    ],
    [
      'agentName/scopeKind boundary',
      ['agentresource', 'org', 'x', 'y'],
      ['agent', 'resource', 'x', 'y'],
    ],
    [
      'scopeKind/scopeValue boundary',
      ['a', 'org', 'x-y', 'k'],
      ['a', 'org', 'x', 'y-k'],
    ],
    [
      'workKey swallows the separator',
      ['a', 'resource', 'b', 'c"d'],
      ['a', 'resource', 'b', 'c\\"d'],
    ],
  ];

  it.each(PAIRS.map(([name, left, right]) => ({ name, left, right })))(
    'distinct inputs stay distinct: $name',
    ({ left, right }) => {
      expect(workDigest(...left)).not.toBe(workDigest(...right));
    },
  );

  it('scopeKind alone separates two otherwise identical calls', () => {
    // The silent-leak scenario of §6: a wrong `org` choice must not be able to land on the same
    // address as the `resource` call it was supposed to be.
    expect(workDigest('a', 'resource', 'x', 'k')).not.toBe(workDigest('a', 'org', 'x', 'k'));
  });

  it('the agent name is part of the identity (heyet şartı 2a)', () => {
    // §6 states the price of this out loud: renaming an agent breaks resume for its half-done work.
    // The pin exists so the field cannot be dropped "because the workKey is unique anyway".
    expect(workDigest('agent-a', 'resource', 'u1', 'k')).not.toBe(
      workDigest('agent-b', 'resource', 'u1', 'k'),
    );
  });
});

describe('workDigest — determinism', () => {
  it('1000 calls with the same input give one answer', () => {
    const first = workDigest('billing-agent', 'resource', 'u-42', 'invoice-2026-09');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(workDigest('billing-agent', 'resource', 'u-42', 'invoice-2026-09'));
    }
    expect([...seen]).toEqual([first]);
  });

  it('derivedRunId is the digest behind the reserved prefix', () => {
    const id = derivedRunId('billing-agent', 'resource', 'u-42', 'invoice-2026-09');
    expect(id).toBe('run1_1fbdaaf5fafae893798b6a74a78ce5da');
    expect(() => assertRunIdSafe(id)).not.toThrow();
  });
});

describe('workDigest — inputs that are not names (§8)', () => {
  it('an empty workKey is refused: work without an address has no name', () => {
    expect(() => workDigest('a', 'resource', 'u1', '')).toThrow(/workKey/);
  });

  it('an empty agentName is refused', () => {
    expect(() => workDigest('', 'resource', 'u1', 'k')).toThrow(/agentName/);
  });

  it("an empty scopeValue is refused — 'org' passes the '~deployment' sentinel in (§10.2)", () => {
    // The sentinel is the CALLER's job, not a default invented here: an org-less install means
    // deployment-wide scope, and that choice is visible in the protection matrix rather than being
    // silently substituted inside a hash function.
    expect(() => workDigest('a', 'org', '', 'k')).toThrow(/scopeValue/);
    expect(() => workDigest('a', 'resource', '', 'k')).toThrow(/scopeValue/);
    expect(() => workDigest('a', 'org', '~deployment', 'k')).not.toThrow();
  });

  it('a workKey longer than 2048 characters is refused', () => {
    expect(() => workDigest('a', 'resource', 'u1', 'x'.repeat(2048))).not.toThrow();
    expect(() => workDigest('a', 'resource', 'u1', 'x'.repeat(2049))).toThrow(/NAME for work/);
  });
});

describe('run1_ is reserved on the raw surface (§7)', () => {
  const REAL = `run1_${'0'.repeat(32)}`;

  it('a well-formed derived id passes — resume/fork MUST be callable with it', () => {
    expect(() => assertRunIdSafe(REAL)).not.toThrow();
    expect(() => assertRunIdSafe('run1_1fbdaaf5fafae893798b6a74a78ce5da')).not.toThrow();
    expect(() => assertRunIdSafe(`${REAL}#2`)).not.toThrow();
    expect(() => assertRunIdSafe(`${REAL}#17`)).not.toThrow();
    expect(() => assertRunIdSafe(`${REAL}#replay-0`)).not.toThrow();
    expect(() => assertRunIdSafe(`${REAL}#replay-12`)).not.toThrow();
  });

  it('an id that merely LOOKS derived is refused', () => {
    expect(() => assertRunIdSafe('run1_deadbeef')).toThrow(/reserved/);
    expect(() => assertRunIdSafe('run1_')).toThrow(/reserved/);
    expect(() => assertRunIdSafe('run1_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`run1_${'A'.repeat(32)}`)).toThrow(/reserved/); // uppercase hex is not our spelling
    expect(() => assertRunIdSafe(`${REAL}0`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}:child`)).toThrow(/reserved/);
  });

  it('the execution axis starts at 2 and carries no other spelling', () => {
    expect(() => assertRunIdSafe(`${REAL}#0`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}#1`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}#02`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}#abc`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}#2#3`)).toThrow(/reserved/);
    expect(() => assertRunIdSafe(`${REAL}#replay-`)).toThrow(/reserved/);
  });

  it("'#' anywhere else is refused — the axis is the engine's (§4)", () => {
    expect(() => assertRunIdSafe('benim#işim')).toThrow(/#/);
    expect(() => assertRunIdSafe('order-1#2')).toThrow(/#/);
    expect(() => assertRunIdSafe('#')).toThrow(/#/);
  });

  it('ordinary ids are untouched by this package', () => {
    // The rule must stay narrow: the whole engine test suite runs on literal runIds (§12).
    for (const ok of ['ok-1', 'chatA1:msgX9', 'conv:msg1', 'agent:parent-1:call-9', 'run1', 'run1x', 'runner-1']) {
      expect(() => assertRunIdSafe(ok)).not.toThrow();
    }
  });
});

describe('executionRunId / parseDerivedRunId round-trip (§4)', () => {
  const base = derivedRunId('a', 'resource', 'u1', 'k');

  it('an execution id is the base plus #n, and parses back', () => {
    const second = executionRunId(base, 2);
    expect(second).toBe(`${base}#2`);
    expect(() => assertRunIdSafe(second)).not.toThrow();
    expect(parseDerivedRunId(second)).toEqual({
      digest: base.slice('run1_'.length),
      execution: 2,
    });
  });

  it('execution #1 has no suffix — it is the base id', () => {
    expect(() => executionRunId(base, 1)).toThrow();
    expect(() => executionRunId(base, 0)).toThrow();
    expect(() => executionRunId(base, -3)).toThrow();
    expect(() => executionRunId(base, 2.5)).toThrow();
  });

  it('an id that already carries the axis cannot grow a second one', () => {
    expect(() => executionRunId(executionRunId(base, 2), 3)).toThrow(/#/);
  });

  it('parseDerivedRunId reads the base, the axis and the replay counter', () => {
    const digest = base.slice('run1_'.length);
    expect(parseDerivedRunId(base)).toEqual({ digest });
    expect(parseDerivedRunId(`${base}#7`)).toEqual({ digest, execution: 7 });
    expect(parseDerivedRunId(`${base}#replay-3`)).toEqual({ digest, replaySeq: 3 });
  });

  it('parseDerivedRunId returns undefined for everything that is not ours', () => {
    for (const foreign of ['ok-1', 'run1_deadbeef', `${base}#1`, `${base}#0`, `${base}#x`, 'conv:msg1', '']) {
      expect(parseDerivedRunId(foreign)).toBeUndefined();
    }
  });
});
